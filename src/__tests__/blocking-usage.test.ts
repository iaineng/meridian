/**
 * Regression: blocking mode must forward the SDK's native `message_start`
 * and `message_delta` frames verbatim (carrying the API's real `msg_id`,
 * `model`, `usage`, `stop_reason`), and only synthesise `message_stop`
 * after the two-gate round closer fires.
 *
 * Prior design synthesised `message_start` with zero usage and accumulated
 * per-round usage into state fields; that was dropped once we realised each
 * HTTP round already corresponds to exactly one SDK internal turn, so the
 * SDK's native frames already carry everything the client needs.
 */

import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test"

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  createSdkMcpServer: (opts: any) => ({ type: "sdk", name: opts.name, instance: {}, tools: opts.tools ?? [] }),
  tool: (name: string, description: string, shape: any, handler: Function, extras?: any) => ({ name, description, shape, handler, extras }),
  query: () => ({ [Symbol.asyncIterator]: () => ({ next: async () => ({ value: undefined, done: true }) }) }),
}))

const { translateBlockingMessage, runBlockingStream } = await import("../proxy/pipeline/blockingStream")
const { blockingPool } = await import("../proxy/session/blockingPool")
const { computeMessageHashes } = await import("../proxy/session/lineage")
const { telemetryStore } = await import("../telemetry")

function makeState() {
  const state = blockingPool.acquire(
    { kind: "header", value: "s-usage" },
    {
      key: { kind: "header", value: "s-usage" },
      ephemeralSessionId: "00000000-0000-0000-0000-000000000000",
      workingDirectory: "/tmp",
      priorMessageHashes: ["h0"],
      cleanup: async () => {},
    },
  )
  return state
}

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

function parseSseEvents(body: string): Array<{ event: string; data: any }> {
  const events: Array<{ event: string; data: any }> = []
  for (const chunk of body.split("\n\n")) {
    const lines = chunk.split("\n")
    const eventLine = lines.find(l => l.startsWith("event: "))
    const dataLine = lines.find(l => l.startsWith("data: "))
    if (!eventLine || !dataLine) continue
    const event = eventLine.slice("event: ".length)
    const data = JSON.parse(dataLine.slice("data: ".length))
    events.push({ event, data })
  }
  return events
}

function decodeFrames(frames: Uint8Array[]): Array<{ event: string; data: any }> {
  const decoder = new TextDecoder()
  return frames.map(f => {
    const text = decoder.decode(f)
    const eventMatch = /^event: (\S+)/m.exec(text)
    const dataMatch = /^data: (.*)$/m.exec(text)
    return {
      event: eventMatch?.[1] ?? "",
      data: dataMatch ? JSON.parse(dataMatch[1]!) : null,
    }
  })
}

describe("blocking usage propagation", () => {
  beforeEach(async () => {
    await blockingPool._reset()
    telemetryStore.clear()
  })
  afterEach(async () => {
    await blockingPool._reset()
    telemetryStore.clear()
  })

  it("translateBlockingMessage: SDK message_start is forwarded verbatim (preserves msg_id, model, usage)", () => {
    const state = makeState()
    const encoder = new TextEncoder()
    const frames = translateBlockingMessage(
      {
        type: "stream_event",
        event: {
          type: "message_start",
          message: {
            id: "msg_abc123",
            type: "message",
            role: "assistant",
            model: "claude-sonnet-4-5",
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: {
              input_tokens: 1500,
              output_tokens: 1,
              cache_creation_input_tokens: 200,
              cache_read_input_tokens: 800,
            },
          },
        },
      },
      state,
      encoder,
    )
    expect(frames.length).toBe(1)
    const [out] = decodeFrames(frames)
    expect(out!.event).toBe("message_start")
    expect(out!.data.type).toBe("message_start")
    expect(out!.data.message.id).toBe("msg_abc123")
    expect(out!.data.message.model).toBe("claude-sonnet-4-5")
    expect(out!.data.message.usage).toEqual({
      input_tokens: 1500,
      output_tokens: 1,
      cache_creation_input_tokens: 200,
      cache_read_input_tokens: 800,
    })
    // Lifetime accumulator tracks it for diagnostics.
    expect(state.cumulativeUsage.input_tokens).toBe(1500)
    expect(state.cumulativeUsage.cache_read_input_tokens).toBe(800)
  })

  it("translateBlockingMessage: message_start resets per-turn tool_use tracking", () => {
    const state = makeState()
    const encoder = new TextEncoder()
    // Seed stale per-turn state (as if from a prior turn).
    state.toolUseIdBySdkIdx.set(0, { toolName: "Read", toolUseId: "tu_stale" })
    state.inputJsonAccum.set(0, "{stale}")
    translateBlockingMessage(
      { type: "stream_event", event: { type: "message_start", message: { usage: {} } } },
      state,
      encoder,
    )
    expect(state.toolUseIdBySdkIdx.size).toBe(0)
    expect(state.inputJsonAccum.size).toBe(0)
  })

  it("translateBlockingMessage: message_delta is forwarded verbatim (stop_reason + usage)", () => {
    const state = makeState()
    const encoder = new TextEncoder()
    const frames = translateBlockingMessage(
      {
        type: "stream_event",
        event: {
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { output_tokens: 173 },
        },
      },
      state,
      encoder,
    )
    expect(frames.length).toBe(1)
    const [out] = decodeFrames(frames)
    expect(out!.event).toBe("message_delta")
    expect(out!.data.delta.stop_reason).toBe("end_turn")
    expect(out!.data.usage.output_tokens).toBe(173)
  })

  it("translateBlockingMessage: message_stop is suppressed (meridian synthesises its own at close_round)", () => {
    const state = makeState()
    const encoder = new TextEncoder()
    const frames = translateBlockingMessage(
      { type: "stream_event", event: { type: "message_stop" } },
      state,
      encoder,
    )
    expect(frames.length).toBe(0)
  })

  it("translateBlockingMessage: message_delta(stop_reason:tool_use) arms the round closer", () => {
    const state = makeState()
    const encoder = new TextEncoder()
    // Populate a pending tool_use binding so arming has an expected id.
    state.toolUseIdBySdkIdx.set(0, { toolName: "Read", toolUseId: "tu_X" })
    translateBlockingMessage(
      {
        type: "stream_event",
        event: {
          type: "message_delta",
          delta: { stop_reason: "tool_use", stop_sequence: null },
          usage: { output_tokens: 42 },
        },
      },
      state,
      encoder,
    )
    expect(state.pendingRoundClose).not.toBeNull()
    expect(state.pendingRoundClose!.expectedIds.has("tu_X")).toBe(true)
  })

  it("regression: message_delta(tool_use) frame reaches the CURRENT HTTP when all handlers are already pending", async () => {
    // Scenario: client's MCP handler entered (registered a PendingTool) BEFORE
    // the API emitted message_delta(tool_use). Previously translateBlockingMessage
    // called maybeCloseRound synchronously, which detached the sink before the
    // caller pushed the message_delta frame — so the frame landed in the buffer
    // and was replayed at the start of the NEXT HTTP round. Fixed by deferring
    // maybeCloseRound to after the consumer pushes the frame.
    const { maybeCloseRound } = await import("../proxy/passthroughTools")
    const state = makeState()
    const encoder = new TextEncoder()

    // Seed: one pending tool_use (handler already entered), SDK index
    // mapping already in place (from an earlier content_block_start).
    state.toolUseIdBySdkIdx.set(0, { toolName: "Read", toolUseId: "tu_X" })
    state.pendingTools.set("tu_X", {
      mcpToolName: "read",
      clientToolName: "Read",
      toolUseId: "tu_X",
      input: {},
      resolve: () => {},
      reject: () => {},
      startedAt: Date.now(),
    })

    // Capture the order of events delivered to the active sink.
    const delivered: Array<{ kind: string; event?: string }> = []
    state.activeSink = (evt: any) => {
      if (evt.kind === "sse") {
        const text = new TextDecoder().decode(evt.frame)
        const m = /^event: (\S+)/m.exec(text)
        delivered.push({ kind: "sse", event: m?.[1] })
      } else {
        delivered.push({ kind: evt.kind })
      }
    }

    // Simulate the consumer loop's behavior for one iteration: translate the
    // SDK message, push its frames to the sink, THEN check the round closer.
    const frames = translateBlockingMessage(
      {
        type: "stream_event",
        event: {
          type: "message_delta",
          delta: { stop_reason: "tool_use", stop_sequence: null },
          usage: { output_tokens: 42 },
        },
      },
      state,
      encoder,
    )
    for (const f of frames) state.activeSink!({ kind: "sse", frame: f })
    // translateBlockingMessage only armed pendingRoundClose — it must NOT
    // have fired close_round on its own.
    expect(delivered.find(d => d.kind === "close_round")).toBeUndefined()
    // Now the caller invokes maybeCloseRound → close_round fires.
    maybeCloseRound(state)

    // Delivery order must be: message_delta SSE first, then close_round.
    expect(delivered.length).toBe(2)
    expect(delivered[0]).toEqual({ kind: "sse", event: "message_delta" })
    expect(delivered[1]).toEqual({ kind: "close_round" })
  })

  it("e2e: close_round emits only a synthetic message_stop (SDK's message_start/delta already forwarded by consumer)", async () => {
    const messages = [{ role: "user", content: "hello" }]
    const priorHashes = computeMessageHashes(messages)
    const key = { kind: "lineage", hash: priorHashes[0]! } as const

    const state = blockingPool.acquire(key, {
      key,
      ephemeralSessionId: "00000000-0000-0000-0000-00000000cccc",
      workingDirectory: "/tmp",
      priorMessageHashes: priorHashes,
      cleanup: async () => {},
    })

    // Simulate the consumer task having already forwarded SDK's native
    // message_start + message_delta frames for this round.
    const encoder = new TextEncoder()
    const sdkFrames = [
      ...translateBlockingMessage({
        type: "stream_event",
        event: {
          type: "message_start",
          message: {
            id: "msg_real_id",
            type: "message",
            role: "assistant",
            model: "claude-sonnet-4-5",
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 1500, output_tokens: 1, cache_read_input_tokens: 800 },
          },
        },
      }, state, encoder),
      ...translateBlockingMessage({
        type: "stream_event",
        event: {
          type: "message_delta",
          delta: { stop_reason: "tool_use", stop_sequence: null },
          usage: { output_tokens: 73 },
        },
      }, state, encoder),
    ]
    for (const f of sdkFrames) state.eventBuffer.push({ kind: "sse", frame: f })
    state.eventBuffer.push({ kind: "close_round", stopReason: "tool_use" })

    const shared = {
      requestMeta: { requestId: "req-usage-1", endpoint: "/v1/messages", queueEnteredAt: 0, queueStartedAt: 0 },
      adapter: { name: "opencode" },
      body: { model: "claude-sonnet-4-5", messages },
      model: "claude-sonnet-4-5",
      allMessages: messages,
      workingDirectory: "/tmp",
      initialPassthrough: true,
      outputFormat: undefined,
      stream: true,
      profile: { type: "oauth", env: {} },
    } as any

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

    const env = { claudeExecutable: "/usr/bin/claude", requestStartAt: 0 }
    const res = runBlockingStream(shared, handler, {} as any, {} as any, env as any)
    const body = await drainStream(res)
    const events = parseSseEvents(body)

    // SDK's native message_start forwarded verbatim — real msg_id + usage.
    const startEvent = events.find(e => e.event === "message_start")
    expect(startEvent).toBeDefined()
    expect(startEvent!.data.message.id).toBe("msg_real_id")
    expect(startEvent!.data.message.usage).toEqual({
      input_tokens: 1500,
      output_tokens: 1,
      cache_read_input_tokens: 800,
    })

    // SDK's native message_delta forwarded verbatim — real output_tokens.
    const deltaEvent = events.find(e => e.event === "message_delta")
    expect(deltaEvent).toBeDefined()
    expect(deltaEvent!.data.delta.stop_reason).toBe("tool_use")
    expect(deltaEvent!.data.usage.output_tokens).toBe(73)

    // Only a synthetic message_stop is added by meridian.
    const stopEvents = events.filter(e => e.event === "message_stop")
    expect(stopEvents.length).toBe(1)
  })
})
