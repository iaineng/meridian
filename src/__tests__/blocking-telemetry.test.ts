/**
 * Regression: runBlockingStream must record exactly one telemetry metric per
 * HTTP, with lineageType "blocking" or "blocking_continuation" preserved.
 *
 * Previously the blocking pipeline bypassed both recordRequestSuccess and
 * recordRequestError, so blocking sessions never appeared in the /telemetry
 * Requests view — only the diagnostic log events surfaced. This test drives
 * a continuation HTTP with a pre-buffered close_round so we exercise the
 * full `runBlockingStream → deliver → recordTelemetry` path without needing
 * to mock the SDK query iterator.
 */

import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test"

// Stub the SDK so static imports in blockingStream link successfully.
// Continuation requests don't invoke query(), so the stub never has to emit.
mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  createSdkMcpServer: (opts: any) => ({ type: "sdk", name: opts.name, instance: {}, tools: opts.tools ?? [] }),
  tool: (name: string, description: string, shape: any, handler: Function, extras?: any) => ({ name, description, shape, handler, extras }),
  query: () => ({ [Symbol.asyncIterator]: () => ({ next: async () => ({ value: undefined, done: true }) }) }),
}))

const { runBlockingStream } = await import("../proxy/pipeline/blockingStream")
const { blockingPool } = await import("../proxy/session/blockingPool")
const { telemetryStore } = await import("../telemetry")
const { computeMessageHashes } = await import("../proxy/session/lineage")

async function drainStream(res: Response): Promise<string> {
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

function makeShared(messages: any[], overrides: Partial<any> = {}) {
  return {
    requestMeta: {
      requestId: "req-tel-blocking",
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
    stream: true,
    profile: { type: "oauth", env: {} },
    ...overrides,
  } as any
}

describe("runBlockingStream — telemetry visibility", () => {
  beforeEach(async () => {
    await blockingPool._reset()
    telemetryStore.clear()
  })
  afterEach(async () => {
    await blockingPool._reset()
    telemetryStore.clear()
  })

  it("continuation HTTP records a metric with lineageType=blocking_continuation", async () => {
    const messages = [
      { role: "user", content: "read README" },
      { role: "assistant", content: [{ type: "tool_use", id: "tu_1", name: "mcp__tools__Read", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_1", content: "ok" }] },
    ]
    const priorHashes = computeMessageHashes(messages.slice(0, -1))
    const key = { kind: "lineage", hash: priorHashes[0]! } as const

    const state = blockingPool.acquire(key, {
      key,
      ephemeralSessionId: "00000000-0000-0000-0000-00000000aaaa",
      workingDirectory: "/tmp",
      priorMessageHashes: priorHashes,
      cleanup: async () => {},
    })

    // Pre-buffer a close_round so the first attached sink immediately closes
    // the HTTP — no SDK, no handler loop needed for this test.
    state.eventBuffer.push({ kind: "close_round", stopReason: "tool_use" })

    const shared = makeShared(messages)
    const handler = {
      cleanup: async () => {},
      isEphemeral: true,
      isResume: false,
      lineageType: "blocking_continuation",
      blockingMode: true,
      isBlockingContinuation: true,
      blockingSessionKey: key,
      blockingState: state,
      pendingToolResults: [],
    } as any

    const env = { claudeExecutable: "/usr/bin/claude", requestStartAt: shared.requestMeta.queueStartedAt }
    const res = runBlockingStream(shared, handler, {} as any, {} as any, env as any)
    await drainStream(res)

    const [metric] = telemetryStore.getRecent({ limit: 1 })
    expect(metric).toBeDefined()
    expect(metric!.lineageType).toBe("blocking_continuation")
    expect(metric!.isEphemeral).toBe(true)
    expect(metric!.adapter).toBe("opencode")
    expect(metric!.mode).toBe("stream")
    expect(metric!.error).toBeNull()
  })

  it("SDK-end event records a metric (end_reason=end_turn)", async () => {
    const messages = [{ role: "user", content: "hi" }]
    const priorHashes = computeMessageHashes(messages)
    const key = { kind: "lineage", hash: priorHashes[0]! } as const

    const state = blockingPool.acquire(key, {
      key,
      ephemeralSessionId: "00000000-0000-0000-0000-00000000bbbb",
      workingDirectory: "/tmp",
      priorMessageHashes: priorHashes,
      cleanup: async () => {},
    })
    state.eventBuffer.push({ kind: "end", reason: "end_turn" })

    const shared = makeShared(messages)
    const handler = {
      cleanup: async () => {},
      isEphemeral: true,
      isResume: false,
      lineageType: "blocking_continuation",
      blockingMode: true,
      isBlockingContinuation: true,
      blockingSessionKey: key,
      blockingState: state,
      pendingToolResults: [],
    } as any

    const env = { claudeExecutable: "/usr/bin/claude", requestStartAt: shared.requestMeta.queueStartedAt }
    const res = runBlockingStream(shared, handler, {} as any, {} as any, env as any)
    await drainStream(res)

    const [metric] = telemetryStore.getRecent({ limit: 1 })
    expect(metric).toBeDefined()
    expect(metric!.lineageType).toBe("blocking_continuation")
    expect(metric!.error).toBeNull()
  })

  it("SDK-error event records an error metric", async () => {
    const messages = [{ role: "user", content: "hi" }]
    const priorHashes = computeMessageHashes(messages)
    const key = { kind: "lineage", hash: priorHashes[0]! } as const

    const state = blockingPool.acquire(key, {
      key,
      ephemeralSessionId: "00000000-0000-0000-0000-00000000cccc",
      workingDirectory: "/tmp",
      priorMessageHashes: priorHashes,
      cleanup: async () => {},
    })
    state.eventBuffer.push({ kind: "error", error: new Error("upstream 529 overloaded_error") })

    const shared = makeShared(messages)
    const handler = {
      cleanup: async () => {},
      isEphemeral: true,
      isResume: false,
      lineageType: "blocking_continuation",
      blockingMode: true,
      isBlockingContinuation: true,
      blockingSessionKey: key,
      blockingState: state,
      pendingToolResults: [],
    } as any

    const env = { claudeExecutable: "/usr/bin/claude", requestStartAt: shared.requestMeta.queueStartedAt }
    const res = runBlockingStream(shared, handler, {} as any, {} as any, env as any)
    await drainStream(res)

    const [metric] = telemetryStore.getRecent({ limit: 1 })
    expect(metric).toBeDefined()
    expect(metric!.error).not.toBeNull()
  })
})
