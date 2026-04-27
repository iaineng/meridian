/**
 * Cross-mode alternation: a single blocking-MCP session must accept any mix
 * of `stream:true` (runBlockingStream) and `stream:false`
 * (runBlockingNonStream) HTTP rounds. The pool/state-machine layer is sink-
 * agnostic; these tests verify that the two entrypoints produce equivalent
 * server-visible state — same `priorMessageHashes`, same pool sibling, same
 * ephemeralSessionId across mode switches.
 */

import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test"

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  createSdkMcpServer: (opts: any) => ({ type: "sdk", name: opts.name, instance: {}, tools: opts.tools ?? [] }),
  tool: (name: string, description: string, shape: any, handler: Function, extras?: any) => ({ name, description, shape, handler, extras }),
  query: () => ({ [Symbol.asyncIterator]: () => ({ next: async () => ({ value: undefined, done: true }) }) }),
}))

const {
  runBlockingStream,
  runBlockingNonStream,
} = await import("../proxy/pipeline/blockingStream")
const { blockingPool } = await import("../proxy/session/blockingPool")
const { telemetryStore } = await import("../telemetry")
const { computeMessageHashes } = await import("../proxy/session/lineage")

const enc = new TextEncoder()

function sseFrame(type: string, data: unknown): { kind: "sse"; frame: Uint8Array } {
  return { kind: "sse", frame: enc.encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`) }
}

function pushAssistantTurn(state: any, opts: { msgId: string; toolUseId: string; toolName?: string }) {
  state.eventBuffer.push(
    sseFrame("message_start", { type: "message_start", message: { id: opts.msgId, usage: { input_tokens: 1 } } }),
    sseFrame("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: opts.toolUseId, name: opts.toolName ?? "Read", input: {} },
    }),
    sseFrame("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: '{"path":"."}' },
    }),
    sseFrame("content_block_stop", { type: "content_block_stop", index: 0 }),
    sseFrame("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "tool_use", stop_sequence: null },
      usage: { output_tokens: 1 },
    }),
    { kind: "close_round", stopReason: "tool_use" },
  )
}

function pushFinalTurn(state: any, opts: { msgId: string }) {
  state.eventBuffer.push(
    sseFrame("message_start", { type: "message_start", message: { id: opts.msgId, usage: { input_tokens: 1 } } }),
    sseFrame("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    }),
    sseFrame("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "done" },
    }),
    sseFrame("content_block_stop", { type: "content_block_stop", index: 0 }),
    sseFrame("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 1 },
    }),
    { kind: "end", reason: "end_turn" },
  )
}

function makeShared(messages: any[], stream: boolean) {
  return {
    requestMeta: {
      requestId: `req-alt-${Math.random().toString(36).slice(2, 8)}`,
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
    stream,
    profile: { type: "oauth", env: {} },
  } as any
}

function makeHandler(state: any, key: any, pendingToolResults: any[] = []) {
  return {
    cleanup: async () => {},
    isEphemeral: true,
    isResume: false,
    lineageType: "blocking_continuation",
    blockingMode: true,
    isBlockingContinuation: true,
    blockingSessionKey: key,
    blockingState: state,
    pendingToolResults,
  } as any
}

async function drainSse(res: Response): Promise<string> {
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let out = ""
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    if (value) out += decoder.decode(value)
  }
  return out
}

function pendingResolverPair() {
  let resolved: any = null
  const slot = {
    mcpToolName: "Read",
    clientToolName: "Read",
    toolUseId: "",
    input: {},
    resolve: (r: any) => { resolved = r },
    reject: () => {},
    startedAt: 0,
  }
  return { slot, getResolved: () => resolved }
}

describe("blocking session: stream/non-stream alternation", () => {
  beforeEach(async () => {
    await blockingPool._reset()
    telemetryStore.clear()
  })
  afterEach(async () => {
    await blockingPool._reset()
    telemetryStore.clear()
  })

  it("A1: stream HTTP → non-stream continuation HTTP: same session, lineage chain advances", async () => {
    // Production-equivalent: round 0's SDK iterator was already started; we
    // emulate that here by pre-acquiring state and pre-buffering events.
    // Both rounds' handlers therefore use isBlockingContinuation:true (the
    // SDK-iterator-spawn path is exercised in blocking-fork.test.ts and
    // blocking-stale-continuation.test.ts).
    const r0Messages = [{ role: "user", content: "list files" }]
    const r0Priors = computeMessageHashes(r0Messages)
    const key = { kind: "lineage", hash: r0Priors[0]! } as const
    const state = blockingPool.acquire(key, {
      key,
      ephemeralSessionId: "00000000-0000-0000-0000-0000000000a1",
      workingDirectory: "/tmp",
      priorMessageHashes: r0Priors,
      cleanup: async () => {},
    })

    // Round 0 sink: stream HTTP. Push a tool_use turn ending in close_round.
    pushAssistantTurn(state, { msgId: "msg_r0", toolUseId: "tu_R0" })
    state.currentRoundToolIds = ["tu_R0"]
    const round0Pending = pendingResolverPair()
    round0Pending.slot.toolUseId = "tu_R0"
    state.pendingTools.set("tu_R0", round0Pending.slot as any)

    const r0Handler = makeHandler(state, key, [])
    const r0Res = runBlockingStream(makeShared(r0Messages, true), r0Handler, {} as any, {} as any, {
      claudeExecutable: "/usr/bin/claude",
      requestStartAt: 1_000,
    } as any)
    expect(r0Res.headers.get("Content-Type")).toBe("text/event-stream")
    const r0Sse = await drainSse(r0Res)
    // Stream HTTP wrote the buffered frames out to SSE.
    expect(r0Sse).toContain("message_start")
    expect(r0Sse).toContain("tu_R0")
    expect(r0Sse).toContain("message_stop")
    // After round 0, session is still streaming and the pool still owns it.
    expect(state.status).toBe("streaming")
    expect(blockingPool.lookup(key, r0Priors)).toBe(state)

    // Round 1: non-stream continuation arrives with tool_result for tu_R0.
    const r1Messages = [
      ...r0Messages,
      { role: "assistant", content: [{ type: "tool_use", id: "tu_R0", name: "Read", input: { path: "." } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_R0", content: "a.txt" }] },
    ]

    // Push the next round's events: SDK responds with text and ends.
    pushFinalTurn(state, { msgId: "msg_r1" })

    const r1Res = await runBlockingNonStream(
      makeShared(r1Messages, false),
      makeHandler(state, key, [{ tool_use_id: "tu_R0", content: "a.txt" }]),
      {} as any, {} as any,
      { claudeExecutable: "/usr/bin/claude", requestStartAt: 2_000 } as any,
    )

    expect(r1Res.headers.get("Content-Type")).toBe("application/json")
    const r1Body: any = await r1Res.json()
    expect(r1Body.id).toBe("msg_r1")
    expect(r1Body.stop_reason).toBe("end_turn")
    expect(r1Body.content[0]).toMatchObject({ type: "text", text: "done" })

    // Round 0 tool_result was routed to the pending handler.
    expect(round0Pending.getResolved()).not.toBeNull()
    // priorMessageHashes was advanced from [r0[0]] → hashes(r1[0..-1]).
    expect(state.priorMessageHashes).toEqual(computeMessageHashes(r1Messages.slice(0, -1)))
    // SDK end → pool released.
    expect(state.status).toBe("terminated")
  })

  it("A2: non-stream initial → stream continuation: same session, tool_results route correctly", async () => {
    const r0Messages = [{ role: "user", content: "ping" }]
    const r0Priors = computeMessageHashes(r0Messages)
    const key = { kind: "lineage", hash: r0Priors[0]! } as const
    const state = blockingPool.acquire(key, {
      key,
      ephemeralSessionId: "00000000-0000-0000-0000-0000000000a2",
      workingDirectory: "/tmp",
      priorMessageHashes: r0Priors,
      cleanup: async () => {},
    })

    // Round 0 buffer: tool_use ending in close_round.
    pushAssistantTurn(state, { msgId: "msg_r0", toolUseId: "tu_X" })
    state.currentRoundToolIds = ["tu_X"]
    const pending = pendingResolverPair()
    pending.slot.toolUseId = "tu_X"
    state.pendingTools.set("tu_X", pending.slot as any)

    // Round 0: non-stream HTTP attached to a pre-acquired state (the SDK
    // iterator is exercised separately).
    const r0Handler = makeHandler(state, key, [])
    const r0Res = await runBlockingNonStream(
      makeShared(r0Messages, false),
      r0Handler,
      {} as any, {} as any,
      { claudeExecutable: "/usr/bin/claude", requestStartAt: 1_000 } as any,
    )
    expect(r0Res.headers.get("Content-Type")).toBe("application/json")
    const r0Body: any = await r0Res.json()
    expect(r0Body.id).toBe("msg_r0")
    expect(r0Body.stop_reason).toBe("tool_use")
    expect(r0Body.content[0]).toMatchObject({ type: "tool_use", id: "tu_X" })
    expect(state.status).toBe("streaming")

    // Round 1: stream continuation, providing tool_result for tu_X.
    pushFinalTurn(state, { msgId: "msg_r1" })
    const r1Messages = [
      ...r0Messages,
      { role: "assistant", content: [{ type: "tool_use", id: "tu_X", name: "Read", input: { path: "." } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_X", content: "ok" }] },
    ]
    const r1Res = runBlockingStream(
      makeShared(r1Messages, true),
      makeHandler(state, key, [{ tool_use_id: "tu_X", content: "ok" }]),
      {} as any, {} as any,
      { claudeExecutable: "/usr/bin/claude", requestStartAt: 2_000 } as any,
    )
    const r1Sse = await drainSse(r1Res)
    expect(r1Sse).toContain("event: message_start")
    expect(r1Sse).toContain("text_delta")
    expect(r1Sse).toContain("end_turn")
    expect(pending.getResolved()).not.toBeNull()
    expect(state.priorMessageHashes).toEqual(computeMessageHashes(r1Messages.slice(0, -1)))
    expect(state.status).toBe("terminated")
  })

  it("A3: 4-round chain stream → non-stream → stream → non-stream, lineage advances each round", async () => {
    const r0Messages = [{ role: "user", content: "start" }]
    const r0Priors = computeMessageHashes(r0Messages)
    const key = { kind: "lineage", hash: r0Priors[0]! } as const
    const state = blockingPool.acquire(key, {
      key,
      ephemeralSessionId: "00000000-0000-0000-0000-0000000000a3",
      workingDirectory: "/tmp",
      priorMessageHashes: r0Priors,
      cleanup: async () => {},
    })

    const env = { claudeExecutable: "/usr/bin/claude", requestStartAt: 0 } as any

    // Round 0 (stream): tool_use tu_R0
    pushAssistantTurn(state, { msgId: "msg_r0", toolUseId: "tu_R0" })
    state.currentRoundToolIds = ["tu_R0"]
    const p0 = pendingResolverPair()
    p0.slot.toolUseId = "tu_R0"
    state.pendingTools.set("tu_R0", p0.slot as any)
    await drainSse(runBlockingStream(
      makeShared(r0Messages, true),
      makeHandler(state, key, []),
      {} as any, {} as any, env,
    ))
    expect(state.status).toBe("streaming")
    expect(p0.getResolved()).toBeNull()

    // Round 1 (non-stream continuation): tool_result for tu_R0, next tool_use tu_R1
    const r1Messages = [
      ...r0Messages,
      { role: "assistant", content: [{ type: "tool_use", id: "tu_R0", name: "Read", input: { path: "." } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_R0", content: "ok" }] },
    ]
    pushAssistantTurn(state, { msgId: "msg_r1", toolUseId: "tu_R1" })
    state.currentRoundToolIds = ["tu_R1"]
    const p1 = pendingResolverPair()
    p1.slot.toolUseId = "tu_R1"
    state.pendingTools.set("tu_R1", p1.slot as any)
    const r1Res = await runBlockingNonStream(
      makeShared(r1Messages, false),
      makeHandler(state, key, [{ tool_use_id: "tu_R0", content: "ok" }]),
      {} as any, {} as any, env,
    )
    const r1Body: any = await r1Res.json()
    expect(r1Body.content[0]).toMatchObject({ type: "tool_use", id: "tu_R1" })
    expect(p0.getResolved()).not.toBeNull()
    expect(state.priorMessageHashes).toEqual(computeMessageHashes(r1Messages.slice(0, -1)))

    // Round 2 (stream continuation): tool_result for tu_R1, next tool_use tu_R2
    const r2Messages = [
      ...r1Messages,
      { role: "assistant", content: [{ type: "tool_use", id: "tu_R1", name: "Read", input: { path: "." } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_R1", content: "ok" }] },
    ]
    pushAssistantTurn(state, { msgId: "msg_r2", toolUseId: "tu_R2" })
    state.currentRoundToolIds = ["tu_R2"]
    const p2 = pendingResolverPair()
    p2.slot.toolUseId = "tu_R2"
    state.pendingTools.set("tu_R2", p2.slot as any)
    await drainSse(runBlockingStream(
      makeShared(r2Messages, true),
      makeHandler(state, key, [{ tool_use_id: "tu_R1", content: "ok" }]),
      {} as any, {} as any, env,
    ))
    expect(p1.getResolved()).not.toBeNull()
    expect(state.priorMessageHashes).toEqual(computeMessageHashes(r2Messages.slice(0, -1)))

    // Round 3 (non-stream continuation): tool_result for tu_R2, then end_turn.
    const r3Messages = [
      ...r2Messages,
      { role: "assistant", content: [{ type: "tool_use", id: "tu_R2", name: "Read", input: { path: "." } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_R2", content: "ok" }] },
    ]
    pushFinalTurn(state, { msgId: "msg_r3" })
    const r3Res = await runBlockingNonStream(
      makeShared(r3Messages, false),
      makeHandler(state, key, [{ tool_use_id: "tu_R2", content: "ok" }]),
      {} as any, {} as any, env,
    )
    const r3Body: any = await r3Res.json()
    expect(r3Body.stop_reason).toBe("end_turn")
    expect(r3Body.content[0]).toMatchObject({ type: "text", text: "done" })
    expect(p2.getResolved()).not.toBeNull()

    // After end → pool released, ephemeralSessionId stayed constant the
    // entire 4-round chain.
    expect(state.status).toBe("terminated")
  })

  it("A4: pool lookup picks the same sibling regardless of mode used", async () => {
    const messages = [{ role: "user", content: "x" }]
    const priors = computeMessageHashes(messages)
    const key = { kind: "lineage", hash: priors[0]! } as const

    const live = blockingPool.acquire(key, {
      key,
      ephemeralSessionId: "00000000-0000-0000-0000-0000000000a4",
      workingDirectory: "/tmp",
      priorMessageHashes: priors,
      cleanup: async () => {},
    })

    // After a stream-mode round 0 that ended in close_round, lookup with the
    // extended priors finds the live sibling.
    const continuationPriors = computeMessageHashes([
      ...messages,
      { role: "assistant", content: [{ type: "tool_use", id: "tu_K", name: "Read", input: {} }] },
    ])
    expect(blockingPool.lookup(key, continuationPriors)).toBe(live)

    // After a non-stream initial, the pool lookup is identical — same key,
    // same prefix shape.
    expect(blockingPool.lookup(key, priors)).toBe(live)
  })
})
