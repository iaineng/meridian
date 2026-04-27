/**
 * runBlockingNonStream end-to-end behaviour: the JSON Message produced from
 * the same `BufferedEvent` stream that feeds the SSE path, plus close_round
 * vs end vs error termination semantics, plus telemetry recording.
 *
 * Continuation HTTPs do not invoke `query()`, so we can pre-buffer events
 * and verify the resulting JSON without standing up the SDK iterator.
 */

import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test"

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  createSdkMcpServer: (opts: any) => ({ type: "sdk", name: opts.name, instance: {}, tools: opts.tools ?? [] }),
  tool: (name: string, description: string, shape: any, handler: Function, extras?: any) => ({ name, description, shape, handler, extras }),
  query: () => ({ [Symbol.asyncIterator]: () => ({ next: async () => ({ value: undefined, done: true }) }) }),
}))

const { runBlockingNonStream } = await import("../proxy/pipeline/blockingStream")
const { blockingPool } = await import("../proxy/session/blockingPool")
const { telemetryStore } = await import("../telemetry")
const { computeMessageHashes } = await import("../proxy/session/lineage")

const enc = new TextEncoder()

function frame(type: string, data: unknown): { kind: "sse"; frame: Uint8Array } {
  return { kind: "sse", frame: enc.encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`) }
}

function makeShared(messages: any[], overrides: Partial<any> = {}) {
  return {
    requestMeta: {
      requestId: "req-tel-blocking-ns",
      endpoint: "/v1/messages",
      queueEnteredAt: 1_000,
      queueStartedAt: 1_000,
    },
    adapter: { name: "opencode" },
    body: { model: "claude-sonnet-4-5", messages },
    model: "claude-sonnet-4-5",
    allMessages: messages,
    workingDirectory: "/tmp",
    initialPassthrough: true,
    outputFormat: undefined,
    stream: false,
    profile: { type: "oauth", env: {} },
    ...overrides,
  } as any
}

function makeHandler(state: any, key: any, pendingToolResults: any[] = [], isContinuation = true) {
  return {
    cleanup: async () => {},
    isEphemeral: true,
    isResume: false,
    lineageType: isContinuation ? "blocking_continuation" : "blocking",
    blockingMode: true,
    isBlockingContinuation: isContinuation,
    blockingSessionKey: key,
    blockingState: state,
    pendingToolResults,
  } as any
}

describe("runBlockingNonStream", () => {
  beforeEach(async () => {
    await blockingPool._reset()
    telemetryStore.clear()
  })
  afterEach(async () => {
    await blockingPool._reset()
    telemetryStore.clear()
  })

  it("E1: close_round → JSON Message with stop_reason='tool_use' and content blocks", async () => {
    const messages = [
      { role: "user", content: "list files" },
      { role: "assistant", content: [{ type: "tool_use", id: "tu_1", name: "Read", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_1", content: "ok" }] },
    ]
    const priorHashes = computeMessageHashes(messages.slice(0, -1))
    const key = { kind: "lineage", hash: priorHashes[0]! } as const
    const state = blockingPool.acquire(key, {
      key,
      ephemeralSessionId: "00000000-0000-0000-0000-0000000000e1",
      workingDirectory: "/tmp",
      priorMessageHashes: priorHashes,
      cleanup: async () => {},
    })

    // Pre-buffer one full assistant turn ending with a tool_use, then a
    // close_round (mimics what `spawnConsumer` would push when the SDK
    // emits message_delta(stop_reason="tool_use") and all handlers entered).
    state.eventBuffer.push(
      frame("message_start", { type: "message_start", message: { id: "msg_e1", usage: { input_tokens: 50 } } }),
      frame("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
      frame("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Reading..." } }),
      frame("content_block_stop", { type: "content_block_stop", index: 0 }),
      frame("content_block_start", { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "tu_NEXT", name: "listFiles", input: {} } }),
      frame("content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"path":"."}' } }),
      frame("content_block_stop", { type: "content_block_stop", index: 1 }),
      frame("message_delta", {
        type: "message_delta",
        delta: { stop_reason: "tool_use", stop_sequence: null },
        usage: { output_tokens: 7 },
      }),
      { kind: "close_round", stopReason: "tool_use" },
    )

    const shared = makeShared(messages)
    const handler = makeHandler(state, key, [
      { tool_use_id: "tu_1", content: "ok" },
    ])
    const env = { claudeExecutable: "/usr/bin/claude", requestStartAt: shared.requestMeta.queueStartedAt }
    const res = await runBlockingNonStream(shared, handler, {} as any, {} as any, env as any)

    expect(res.headers.get("Content-Type")).toBe("application/json")
    expect(res.headers.get("X-Claude-Session-ID")).toBe(`l:${priorHashes[0]}`)
    const body: any = await res.json()
    expect(body.id).toBe("msg_e1")
    expect(body.role).toBe("assistant")
    expect(body.type).toBe("message")
    expect(body.model).toBe("claude-sonnet-4-5")
    expect(body.stop_reason).toBe("tool_use")
    expect(body.usage.input_tokens).toBe(50)
    expect(body.usage.output_tokens).toBe(7)
    expect(body.content).toHaveLength(2)
    expect(body.content[0]).toMatchObject({ type: "text", text: "Reading..." })
    expect(body.content[1]).toMatchObject({
      type: "tool_use",
      id: "tu_NEXT",
      name: "listFiles",
      input: { path: "." },
    })
    // Telemetry recorded as non-stream.
    const [metric] = telemetryStore.getRecent({ limit: 1 })
    expect(metric).toBeDefined()
    expect(metric!.mode).toBe("non-stream")
    expect(metric!.lineageType).toBe("blocking_continuation")
    expect(metric!.error).toBeNull()
    // Session stays alive after close_round.
    expect(state.status).toBe("streaming")
  })

  it("E2: end with end_turn → JSON Message stop_reason='end_turn' and pool released", async () => {
    const messages = [{ role: "user", content: "hi" }]
    const priorHashes = computeMessageHashes(messages)
    const key = { kind: "lineage", hash: priorHashes[0]! } as const
    const state = blockingPool.acquire(key, {
      key,
      ephemeralSessionId: "00000000-0000-0000-0000-0000000000e2",
      workingDirectory: "/tmp",
      priorMessageHashes: priorHashes,
      cleanup: async () => {},
    })

    state.eventBuffer.push(
      frame("message_start", { type: "message_start", message: { id: "msg_e2", usage: { input_tokens: 5 } } }),
      frame("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
      frame("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hello" } }),
      frame("content_block_stop", { type: "content_block_stop", index: 0 }),
      frame("message_delta", {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 1 },
      }),
      { kind: "end", reason: "end_turn" },
    )

    const shared = makeShared(messages)
    const handler = makeHandler(state, key, [])
    const env = { claudeExecutable: "/usr/bin/claude", requestStartAt: shared.requestMeta.queueStartedAt }
    const res = await runBlockingNonStream(shared, handler, {} as any, {} as any, env as any)

    const body: any = await res.json()
    expect(body.stop_reason).toBe("end_turn")
    expect(body.content[0]).toMatchObject({ type: "text", text: "hello" })
    // Pool released → state terminated, no longer findable.
    expect(state.status).toBe("terminated")
    expect(blockingPool.lookup(key, priorHashes)).toBeUndefined()
  })

  it("E3: end with max_tokens → stop_reason='max_tokens' overrides any prior message_delta", async () => {
    const messages = [{ role: "user", content: "long" }]
    const priorHashes = computeMessageHashes(messages)
    const key = { kind: "lineage", hash: priorHashes[0]! } as const
    const state = blockingPool.acquire(key, {
      key,
      ephemeralSessionId: "00000000-0000-0000-0000-0000000000e3",
      workingDirectory: "/tmp",
      priorMessageHashes: priorHashes,
      cleanup: async () => {},
    })

    state.eventBuffer.push(
      frame("message_start", { type: "message_start", message: { id: "msg_e3", usage: {} } }),
      frame("message_delta", {
        type: "message_delta",
        delta: { stop_reason: "max_tokens", stop_sequence: null },
        usage: { output_tokens: 99 },
      }),
      { kind: "end", reason: "max_tokens" },
    )

    const shared = makeShared(messages)
    const handler = makeHandler(state, key, [])
    const env = { claudeExecutable: "/usr/bin/claude", requestStartAt: shared.requestMeta.queueStartedAt }
    const res = await runBlockingNonStream(shared, handler, {} as any, {} as any, env as any)
    const body: any = await res.json()
    expect(body.stop_reason).toBe("max_tokens")
    expect(body.usage.output_tokens).toBe(99)
  })

  it("E4: error event → JSON error envelope and pool released; error metric recorded", async () => {
    const messages = [{ role: "user", content: "hi" }]
    const priorHashes = computeMessageHashes(messages)
    const key = { kind: "lineage", hash: priorHashes[0]! } as const
    const state = blockingPool.acquire(key, {
      key,
      ephemeralSessionId: "00000000-0000-0000-0000-0000000000e4",
      workingDirectory: "/tmp",
      priorMessageHashes: priorHashes,
      cleanup: async () => {},
    })

    state.eventBuffer.push({ kind: "error", error: new Error("upstream 529 overloaded_error") })

    const shared = makeShared(messages)
    const handler = makeHandler(state, key, [])
    const env = { claudeExecutable: "/usr/bin/claude", requestStartAt: shared.requestMeta.queueStartedAt }
    const res = await runBlockingNonStream(shared, handler, {} as any, {} as any, env as any)

    expect(res.headers.get("Content-Type")).toBe("application/json")
    expect(res.headers.get("X-Claude-Session-ID")).toBe(`l:${priorHashes[0]}`)
    const body: any = await res.json()
    expect(body.type).toBe("error")
    expect(body.error.type).toBeTruthy()
    expect(body.error.message).toContain("overloaded_error")

    expect(state.status).toBe("terminated")
    const [metric] = telemetryStore.getRecent({ limit: 1 })
    expect(metric).toBeDefined()
    expect(metric!.error).not.toBeNull()
  })

  it("continuation routes pendingToolResults by id, then by position fallback", async () => {
    const messages = [
      { role: "user", content: "do x" },
      { role: "assistant", content: [
        { type: "tool_use", id: "tu_A", name: "Read", input: {} },
        { type: "tool_use", id: "tu_B", name: "Read", input: {} },
      ] },
      { role: "user", content: [
        // Client's id matches A, but B is sent as a renamed id (forces positional fallback).
        { type: "tool_result", tool_use_id: "tu_A", content: "A-result" },
        { type: "tool_result", tool_use_id: "tu_B_RENAMED", content: "B-result" },
      ] },
    ]
    const priorHashes = computeMessageHashes(messages.slice(0, -1))
    const key = { kind: "lineage", hash: priorHashes[0]! } as const
    const state = blockingPool.acquire(key, {
      key,
      ephemeralSessionId: "00000000-0000-0000-0000-0000000000c0",
      workingDirectory: "/tmp",
      priorMessageHashes: priorHashes,
      cleanup: async () => {},
    })
    state.currentRoundToolIds = ["tu_A", "tu_B"]
    let resolvedA: any = null
    let resolvedB: any = null
    state.pendingTools.set("tu_A", {
      mcpToolName: "Read", clientToolName: "Read", toolUseId: "tu_A",
      input: {}, resolve: (r: any) => { resolvedA = r }, reject: () => {}, startedAt: 0,
    })
    state.pendingTools.set("tu_B", {
      mcpToolName: "Read", clientToolName: "Read", toolUseId: "tu_B",
      input: {}, resolve: (r: any) => { resolvedB = r }, reject: () => {}, startedAt: 0,
    })

    // Buffer an immediate close_round so the HTTP returns once continuation
    // routing has run.
    state.eventBuffer.push({ kind: "close_round", stopReason: "tool_use" })

    const shared = makeShared(messages)
    const handler = makeHandler(state, key, [
      { tool_use_id: "tu_A", content: "A-result" },
      { tool_use_id: "tu_B_RENAMED", content: "B-result" },
    ])
    const env = { claudeExecutable: "/usr/bin/claude", requestStartAt: shared.requestMeta.queueStartedAt }
    await runBlockingNonStream(shared, handler, {} as any, {} as any, env as any)

    expect(resolvedA).not.toBeNull()
    expect(resolvedB).not.toBeNull()
    // currentRoundToolIds should be cleared after applying continuation.
    expect(state.currentRoundToolIds).toEqual([])
    // priorMessageHashes refreshed from messages.slice(0, -1).
    expect(state.priorMessageHashes).toEqual(computeMessageHashes(messages.slice(0, -1)))
  })
})
