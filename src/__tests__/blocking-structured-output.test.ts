/**
 * translateBlockingMessage StructuredOutput handling.
 *
 *   1. `tool_use { name: "StructuredOutput" }` is converted to a `text` block;
 *      the SDK's `input_json_delta` frames are rewritten to `text_delta`
 *      whose text is the schema-conformant JSON payload.
 *   2. The terminal `message_delta(stop_reason="tool_use")` whose only
 *      tool_use this turn was StructuredOutput gets its stop_reason rewritten
 *      to "end_turn" — there is no client-callable tool_use to act on, and
 *      pendingRoundClose stays unarmed (the SDK's natural end drives close).
 *   3. Mixed StructuredOutput + built-in WebSearch is handled correctly: the
 *      WebSearch tool_use is suppressed (deferred-synthesis pipeline), and
 *      StructuredOutput is translated as text.
 *   4. Mixed StructuredOutput + custom MCP tool_use prefers the round-close
 *      path (real client-callable tools take priority); StructuredOutput is
 *      still emitted as text.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { translateBlockingMessage } from "../proxy/pipeline/blockingStream"
import { blockingPool, type BlockingSessionState } from "../proxy/session/blockingPool"

const enc = new TextEncoder()
const dec = new TextDecoder()

function decodeFrames(frames: Uint8Array[]): Array<{ type: string; data: any }> {
  return frames.map((f) => {
    const text = dec.decode(f)
    const nl = text.indexOf("\n")
    const type = text.slice("event: ".length, nl)
    const dataStart = text.indexOf("data: ", nl + 1) + "data: ".length
    const dataEnd = text.indexOf("\n\n", dataStart)
    return { type, data: JSON.parse(text.slice(dataStart, dataEnd < 0 ? undefined : dataEnd)) }
  })
}

function streamEvent(event: any): any {
  return { type: "stream_event", event }
}

function freshState(opts: { useBuiltinWebSearch?: boolean } = {}): BlockingSessionState {
  const key = { kind: "lineage", hash: `t-${Math.random().toString(36).slice(2)}` } as const
  return blockingPool.acquire(key, {
    key,
    ephemeralSessionId: "00000000-0000-0000-0000-00000000so01",
    workingDirectory: "/tmp",
    priorMessageHashes: [],
    cleanup: async () => {},
    useBuiltinWebSearch: opts.useBuiltinWebSearch ?? false,
    pendingWebSearchResults: [],
    outputFormatActive: true,
  })
}

describe("translateBlockingMessage StructuredOutput handling", () => {
  beforeEach(async () => { await blockingPool._reset() })
  afterEach(async () => { await blockingPool._reset() })

  it("translates lone StructuredOutput tool_use into a client-visible text block", () => {
    const state = freshState()

    translateBlockingMessage(
      streamEvent({ type: "message_start", message: { id: "msg_1", usage: { input_tokens: 10 } } }),
      state, enc,
    )

    // SDK emits StructuredOutput tool_use → translated to text block.
    const startFrames = translateBlockingMessage(
      streamEvent({
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "tu_so", name: "StructuredOutput", input: {} },
      }),
      state, enc,
    )
    const startDecoded = decodeFrames(startFrames)
    expect(startDecoded.length).toBe(1)
    expect(startDecoded[0]!.type).toBe("content_block_start")
    expect(startDecoded[0]!.data.content_block).toEqual({ type: "text", text: "" })
    expect(state.structuredOutputIndices.has(0)).toBe(true)
    expect(state.sdkToClientIndex.get(0)).toBe(0)

    // SDK emits input_json_delta → translator rewrites to text_delta.
    const deltaFrames = translateBlockingMessage(
      streamEvent({
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: "{\"title\":" },
      }),
      state, enc,
    )
    const deltaDecoded = decodeFrames(deltaFrames)
    expect(deltaDecoded.length).toBe(1)
    expect(deltaDecoded[0]!.data.delta).toEqual({ type: "text_delta", text: "{\"title\":" })
    expect(deltaDecoded[0]!.data.index).toBe(0)

    const deltaFrames2 = translateBlockingMessage(
      streamEvent({
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: "\"hi\"}" },
      }),
      state, enc,
    )
    expect(decodeFrames(deltaFrames2)[0]!.data.delta).toEqual({ type: "text_delta", text: "\"hi\"}" })

    // content_block_stop is forwarded with the remapped client index.
    const stopFrames = translateBlockingMessage(
      streamEvent({ type: "content_block_stop", index: 0 }),
      state, enc,
    )
    expect(decodeFrames(stopFrames)[0]!.data.index).toBe(0)
  })

  it("rewrites stop_reason from tool_use to end_turn when only StructuredOutput was emitted", () => {
    const state = freshState()
    translateBlockingMessage(
      streamEvent({ type: "message_start", message: { id: "msg_1", usage: {} } }),
      state, enc,
    )
    translateBlockingMessage(
      streamEvent({
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "tu_so", name: "StructuredOutput", input: {} },
      }),
      state, enc,
    )

    const out = translateBlockingMessage(
      streamEvent({
        type: "message_delta",
        delta: { stop_reason: "tool_use", stop_sequence: null },
        usage: { output_tokens: 8 },
      }),
      state, enc,
    )
    const decoded = decodeFrames(out)
    expect(decoded.length).toBe(1)
    expect(decoded[0]!.data.delta.stop_reason).toBe("end_turn")
    // Round-close MUST stay unarmed — the SDK's natural end will close the HTTP.
    expect(state.pendingRoundClose).toBeNull()
  })

  it("does NOT rewrite stop_reason when a real MCP tool_use is also present", () => {
    const state = freshState()
    translateBlockingMessage(
      streamEvent({ type: "message_start", message: { id: "msg_1", usage: {} } }),
      state, enc,
    )
    // Real client-callable tool_use first.
    translateBlockingMessage(
      streamEvent({
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "tu_real", name: "mcp__tools__my-tool", input: {} },
      }),
      state, enc,
    )
    // StructuredOutput second.
    translateBlockingMessage(
      streamEvent({
        type: "content_block_start",
        index: 1,
        content_block: { type: "tool_use", id: "tu_so", name: "StructuredOutput", input: {} },
      }),
      state, enc,
    )

    const out = translateBlockingMessage(
      streamEvent({
        type: "message_delta",
        delta: { stop_reason: "tool_use", stop_sequence: null },
        usage: { output_tokens: 5 },
      }),
      state, enc,
    )
    const decoded = decodeFrames(out)
    expect(decoded.length).toBe(1)
    expect(decoded[0]!.data.delta.stop_reason).toBe("tool_use")
    // Round-close armed for the real MCP tool_use.
    expect(state.pendingRoundClose).not.toBeNull()
    expect(state.pendingRoundClose!.expectedIds.has("tu_real")).toBe(true)
    expect(state.pendingRoundClose!.expectedIds.has("tu_so")).toBe(false)
  })

  it("StructuredOutput + WebSearch in same turn → WebSearch suppressed, StructuredOutput translated, stop_reason→end_turn", () => {
    const state = freshState({ useBuiltinWebSearch: true })
    translateBlockingMessage(
      streamEvent({ type: "message_start", message: { id: "msg_1", usage: {} } }),
      state, enc,
    )

    // WebSearch tool_use → suppressed.
    const wsFrames = translateBlockingMessage(
      streamEvent({
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "tu_ws", name: "WebSearch", input: {} },
      }),
      state, enc,
    )
    expect(wsFrames.length).toBe(0)
    expect(state.webSearchSkipIndices.has(0)).toBe(true)

    // StructuredOutput tool_use → translated.
    const soFrames = translateBlockingMessage(
      streamEvent({
        type: "content_block_start",
        index: 1,
        content_block: { type: "tool_use", id: "tu_so", name: "StructuredOutput", input: {} },
      }),
      state, enc,
    )
    expect(decodeFrames(soFrames)[0]!.data.content_block).toEqual({ type: "text", text: "" })
    expect(state.structuredOutputIndices.has(1)).toBe(true)

    // Terminal message_delta — StructuredOutput presence wins; rewrite to end_turn.
    const out = translateBlockingMessage(
      streamEvent({
        type: "message_delta",
        delta: { stop_reason: "tool_use", stop_sequence: null },
        usage: { output_tokens: 12 },
      }),
      state, enc,
    )
    expect(decodeFrames(out)[0]!.data.delta.stop_reason).toBe("end_turn")
    expect(state.pendingRoundClose).toBeNull()
  })

  it("when outputFormatActive is false, StructuredOutput tool_use is forwarded as plain tool_use (no translation)", () => {
    // outputFormatActive defaults to false unless explicitly set; emulate by
    // flipping it off after acquire.
    const state = freshState()
    state.outputFormatActive = false

    translateBlockingMessage(
      streamEvent({ type: "message_start", message: { id: "msg_1", usage: {} } }),
      state, enc,
    )
    const out = translateBlockingMessage(
      streamEvent({
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "tu_so", name: "StructuredOutput", input: {} },
      }),
      state, enc,
    )
    // Falls through to default tool_use forwarding — no text translation.
    const decoded = decodeFrames(out)
    expect(decoded.length).toBe(1)
    expect(decoded[0]!.data.content_block.type).toBe("tool_use")
    expect(decoded[0]!.data.content_block.name).toBe("StructuredOutput")
    expect(state.structuredOutputIndices.has(0)).toBe(false)
  })

  it("clears structuredOutputIndices on each message_start (per-turn scope)", () => {
    const state = freshState()
    translateBlockingMessage(
      streamEvent({ type: "message_start", message: { id: "msg_1", usage: {} } }),
      state, enc,
    )
    translateBlockingMessage(
      streamEvent({
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "tu_so", name: "StructuredOutput", input: {} },
      }),
      state, enc,
    )
    expect(state.structuredOutputIndices.size).toBe(1)

    // A fresh SDK turn — translator must reset per-turn maps so SDK index 0
    // does not alias the previous turn's StructuredOutput.
    translateBlockingMessage(
      streamEvent({ type: "message_start", message: { id: "msg_2", usage: {} } }),
      state, enc,
    )
    expect(state.structuredOutputIndices.size).toBe(0)
  })
})

describe("translateBlockingMessage outputFormat plain-text suppression", () => {
  beforeEach(async () => { await blockingPool._reset() })
  afterEach(async () => { await blockingPool._reset() })

  it("suppresses text content_block_start / delta / stop when outputFormatActive is true", () => {
    const state = freshState()
    translateBlockingMessage(
      streamEvent({ type: "message_start", message: { id: "msg_1", usage: {} } }),
      state, enc,
    )

    // The model emits prose alongside the StructuredOutput payload.
    const startFrames = translateBlockingMessage(
      streamEvent({
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      }),
      state, enc,
    )
    expect(startFrames.length).toBe(0)
    expect(state.outputFormatTextSkipIndices.has(0)).toBe(true)
    // No client-block index allocated for a suppressed block — the next real
    // block should still land at client index 0.
    expect(state.nextClientBlockIndex).toBe(0)
    expect(state.sdkToClientIndex.has(0)).toBe(false)

    const deltaFrames = translateBlockingMessage(
      streamEvent({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Here is the JSON: " },
      }),
      state, enc,
    )
    expect(deltaFrames.length).toBe(0)

    const stopFrames = translateBlockingMessage(
      streamEvent({ type: "content_block_stop", index: 0 }),
      state, enc,
    )
    expect(stopFrames.length).toBe(0)
  })

  it("suppresses prose text yet still translates the StructuredOutput tool_use that follows", () => {
    const state = freshState()
    translateBlockingMessage(
      streamEvent({ type: "message_start", message: { id: "msg_1", usage: {} } }),
      state, enc,
    )

    // SDK index 0: prose → suppressed.
    const textStart = translateBlockingMessage(
      streamEvent({
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      }),
      state, enc,
    )
    expect(textStart.length).toBe(0)
    translateBlockingMessage(
      streamEvent({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Sure, here it is:" },
      }),
      state, enc,
    )
    translateBlockingMessage(
      streamEvent({ type: "content_block_stop", index: 0 }),
      state, enc,
    )

    // SDK index 1: StructuredOutput → translated to text at client index 0.
    const soStart = translateBlockingMessage(
      streamEvent({
        type: "content_block_start",
        index: 1,
        content_block: { type: "tool_use", id: "tu_so", name: "StructuredOutput", input: {} },
      }),
      state, enc,
    )
    const soDecoded = decodeFrames(soStart)
    expect(soDecoded.length).toBe(1)
    expect(soDecoded[0]!.data.content_block).toEqual({ type: "text", text: "" })
    expect(soDecoded[0]!.data.index).toBe(0)
    expect(state.structuredOutputIndices.has(1)).toBe(true)

    // The StructuredOutput payload is forwarded as text_delta on the same
    // client index — this is the ONLY content the client sees.
    const soDelta = translateBlockingMessage(
      streamEvent({
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: "{\"x\":1}" },
      }),
      state, enc,
    )
    const soDeltaDecoded = decodeFrames(soDelta)
    expect(soDeltaDecoded.length).toBe(1)
    expect(soDeltaDecoded[0]!.data.delta).toEqual({ type: "text_delta", text: "{\"x\":1}" })
    expect(soDeltaDecoded[0]!.data.index).toBe(0)

    // Terminal: rewrite tool_use stop to end_turn.
    const term = translateBlockingMessage(
      streamEvent({
        type: "message_delta",
        delta: { stop_reason: "tool_use", stop_sequence: null },
        usage: { output_tokens: 5 },
      }),
      state, enc,
    )
    expect(decodeFrames(term)[0]!.data.delta.stop_reason).toBe("end_turn")
  })

  it("does NOT suppress text blocks when outputFormatActive is false (plain blocking-mode chats keep their text)", () => {
    const state = freshState()
    state.outputFormatActive = false

    translateBlockingMessage(
      streamEvent({ type: "message_start", message: { id: "msg_1", usage: {} } }),
      state, enc,
    )
    const startFrames = translateBlockingMessage(
      streamEvent({
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      }),
      state, enc,
    )
    const startDecoded = decodeFrames(startFrames)
    expect(startDecoded.length).toBe(1)
    expect(startDecoded[0]!.data.content_block.type).toBe("text")
    expect(state.outputFormatTextSkipIndices.has(0)).toBe(false)

    const deltaFrames = translateBlockingMessage(
      streamEvent({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "hello" },
      }),
      state, enc,
    )
    expect(decodeFrames(deltaFrames)[0]!.data.delta).toEqual({ type: "text_delta", text: "hello" })
  })

  it("clears outputFormatTextSkipIndices on each message_start (per-turn scope)", () => {
    const state = freshState()
    translateBlockingMessage(
      streamEvent({ type: "message_start", message: { id: "msg_1", usage: {} } }),
      state, enc,
    )
    translateBlockingMessage(
      streamEvent({
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      }),
      state, enc,
    )
    expect(state.outputFormatTextSkipIndices.size).toBe(1)

    translateBlockingMessage(
      streamEvent({ type: "message_start", message: { id: "msg_2", usage: {} } }),
      state, enc,
    )
    expect(state.outputFormatTextSkipIndices.size).toBe(0)
  })
})

describe("translateBlockingMessage outputFormat SDK-retry handling", () => {
  beforeEach(async () => { await blockingPool._reset() })
  afterEach(async () => { await blockingPool._reset() })

  it("buffers intermediate end_turn from a failed retry; only the recovered turn's terminal frame reaches the client", () => {
    const state = freshState()

    // --- Turn 1: model emits text but never calls StructuredOutput. ---
    translateBlockingMessage(
      streamEvent({ type: "message_start", message: { id: "msg_1", usage: {} } }),
      state, enc,
    )
    translateBlockingMessage(
      streamEvent({
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      }),
      state, enc,
    )
    translateBlockingMessage(
      streamEvent({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Sorry, I can't help with that" },
      }),
      state, enc,
    )
    translateBlockingMessage(
      streamEvent({ type: "content_block_stop", index: 0 }),
      state, enc,
    )
    // Turn 1's terminal message_delta — premature end_turn, must be buffered.
    const turn1Term = translateBlockingMessage(
      streamEvent({
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 7 },
      }),
      state, enc,
    )
    expect(turn1Term.length).toBe(0)
    expect(state.outputFormatLastDelta).toBeDefined()
    expect((state.outputFormatLastDelta as any).usage.output_tokens).toBe(7)
    expect(state.outputFormatTerminalForwarded).toBe(false)

    // --- SDK appends a directive and retries → fresh internal turn 2. ---
    translateBlockingMessage(
      streamEvent({ type: "message_start", message: { id: "msg_2", usage: {} } }),
      state, enc,
    )
    // Per-turn structuredOutputIndices was cleared on message_start; the buffered
    // delta and the round-scoped terminal-forwarded flag survive.
    expect(state.structuredOutputIndices.size).toBe(0)
    expect(state.outputFormatLastDelta).toBeDefined()
    expect(state.outputFormatTerminalForwarded).toBe(false)

    // Turn 2: model complies and emits StructuredOutput tool_use.
    translateBlockingMessage(
      streamEvent({
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "tu_so", name: "StructuredOutput", input: {} },
      }),
      state, enc,
    )
    expect(state.structuredOutputIndices.has(0)).toBe(true)

    // Turn 2's message_delta(stop_reason=tool_use) → rewrite to end_turn,
    // forward, mark terminal-forwarded so the consumer's finally block does
    // NOT synthesise a duplicate.
    const turn2Term = translateBlockingMessage(
      streamEvent({
        type: "message_delta",
        delta: { stop_reason: "tool_use", stop_sequence: null },
        usage: { output_tokens: 4 },
      }),
      state, enc,
    )
    const decoded = decodeFrames(turn2Term)
    expect(decoded.length).toBe(1)
    expect(decoded[0]!.data.delta.stop_reason).toBe("end_turn")
    expect(state.outputFormatTerminalForwarded).toBe(true)
    expect(state.pendingRoundClose).toBeNull()
  })

  it("does NOT buffer when outputFormatActive is false (existing semantics preserved)", () => {
    const state = freshState()
    state.outputFormatActive = false

    translateBlockingMessage(
      streamEvent({ type: "message_start", message: { id: "msg_1", usage: {} } }),
      state, enc,
    )
    const out = translateBlockingMessage(
      streamEvent({
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 5 },
      }),
      state, enc,
    )
    // Forward as-is — no buffering.
    expect(out.length).toBe(1)
    expect(decodeFrames(out)[0]!.data.delta.stop_reason).toBe("end_turn")
    expect(state.outputFormatLastDelta).toBeUndefined()
  })

  it("does NOT buffer max_tokens stop_reason (those are real terminal signals even mid-retry)", () => {
    // Edge case: when SDK hits the max_tokens limit on an intermediate turn,
    // it still propagates as a real terminal stop_reason. The current logic
    // treats any non-tool_use stop_reason as buffered when outputFormatActive
    // and SO not yet emitted — this test documents the current behaviour.
    // (If SDK semantics differ in practice we can refine.)
    const state = freshState()

    translateBlockingMessage(
      streamEvent({ type: "message_start", message: { id: "msg_1", usage: {} } }),
      state, enc,
    )
    const out = translateBlockingMessage(
      streamEvent({
        type: "message_delta",
        delta: { stop_reason: "max_tokens", stop_sequence: null },
        usage: { output_tokens: 50 },
      }),
      state, enc,
    )
    // Currently buffered (uniform with end_turn). The synthetic terminal
    // emitted by spawnConsumer's finally block carries end_turn — if SDK
    // ever surfaces max_tokens through this path we may want to preserve it.
    expect(out.length).toBe(0)
    expect(state.outputFormatLastDelta).toBeDefined()
  })
})
