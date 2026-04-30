/**
 * translateBlockingMessage handles built-in WebSearch correctly:
 *
 *   1. Duplicate `message_start` frames are coalesced — the second SDK turn
 *      that fires after a local WebSearch call should NOT produce a second
 *      `event: message_start` SSE frame to the client.
 *   2. Non-passthrough `tool_use { name: "WebSearch" }` content blocks are
 *      suppressed (they're the SDK's client-tool form). Their delta + stop
 *      frames are skipped too.
 *   3. `state.pendingWebSearchResults` is drained at duplicate-message_start
 *      boundaries into synthetic `server_tool_use` + `web_search_tool_result`
 *      content blocks, matching the executor's non-blocking behaviour.
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

function freshState(): BlockingSessionState {
  const key = { kind: "lineage", hash: `t-${Math.random().toString(36).slice(2)}` } as const
  return blockingPool.acquire(key, {
    key,
    ephemeralSessionId: "00000000-0000-0000-0000-00000000ws01",
    workingDirectory: "/tmp",
    priorMessageHashes: [],
    cleanup: async () => {},
    useBuiltinWebSearch: true,
    pendingWebSearchResults: [],
  })
}

describe("translateBlockingMessage WebSearch handling", () => {
  beforeEach(async () => { await blockingPool._reset() })
  afterEach(async () => { await blockingPool._reset() })

  it("forwards the first message_start, suppresses subsequent ones, and drains synthetic web_search frames with monotonic indices", () => {
    const state = freshState()

    // First message_start → forwarded verbatim.
    const f1 = translateBlockingMessage(
      streamEvent({ type: "message_start", message: { id: "msg_1", usage: { input_tokens: 10 } } }),
      state, enc,
    )
    const d1 = decodeFrames(f1)
    expect(d1.length).toBe(1)
    expect(d1[0]!.type).toBe("message_start")
    expect(state.messageStartEmittedThisRound).toBe(true)

    // The hook captured a WebSearch result before the SDK started its second
    // internal turn; the translator drains it on the duplicate message_start.
    state.pendingWebSearchResults.push({
      query: "claude code",
      results: [{
        tool_use_id: "ws_1",
        content: [{ title: "Claude Code", url: "https://claude.ai/code" }],
      }],
    })

    const f2 = translateBlockingMessage(
      streamEvent({ type: "message_start", message: { id: "msg_2", usage: { input_tokens: 5 } } }),
      state, enc,
    )
    const d2 = decodeFrames(f2)
    // No message_start frame in the output — synthetic web search blocks only.
    expect(d2.find((x) => x.type === "message_start")).toBeUndefined()
    const stu = d2.find((x) => x.type === "content_block_start" && x.data.content_block?.type === "server_tool_use")
    expect(stu).toBeDefined()
    expect(stu!.data.content_block.name).toBe("web_search")
    expect(stu!.data.content_block.id).toBe("ws_1")
    expect(stu!.data.content_block.input).toEqual({ query: "claude code" })

    const wstr = d2.find((x) => x.type === "content_block_start" && x.data.content_block?.type === "web_search_tool_result")
    expect(wstr).toBeDefined()
    expect(wstr!.data.content_block.tool_use_id).toBe("ws_1")
    expect(wstr!.data.content_block.content[0].url).toBe("https://claude.ai/code")

    // Pending list is drained.
    expect(state.pendingWebSearchResults.length).toBe(0)

    // Synthetic indices are monotonic and non-negative — no negative-index
    // hack leaks to the client.
    const allIndices = d2
      .filter((x) => x.type === "content_block_start" || x.type === "content_block_stop")
      .map((x) => x.data.index as number)
    expect(allIndices.every((i) => Number.isInteger(i) && i >= 0)).toBe(true)
    // Strictly increasing within the drained pair (server_tool_use start/stop, then result start/stop).
    expect(allIndices).toEqual([...allIndices].sort((a, b) => a - b))
  })

  it("real SDK content_block frames after a duplicate message_start get remapped onto the round's monotonic index sequence", () => {
    const state = freshState()
    // First turn: just a message_start (forwarded).
    translateBlockingMessage(
      streamEvent({ type: "message_start", message: { id: "msg_1", usage: {} } }),
      state, enc,
    )
    // Capture a WebSearch hit so the duplicate message_start drains synthetic frames.
    state.pendingWebSearchResults.push({
      query: "q",
      results: [{ tool_use_id: "ws_1", content: [{ title: "T", url: "https://x" }] }],
    })
    // Duplicate message_start (turn 2 of same round) — drains 2 synthetic
    // blocks (server_tool_use at index 0, web_search_tool_result at index 1).
    const f2 = translateBlockingMessage(
      streamEvent({ type: "message_start", message: { id: "msg_2", usage: {} } }),
      state, enc,
    )
    const drainStartIndices = decodeFrames(f2)
      .filter((x) => x.type === "content_block_start")
      .map((x) => x.data.index as number)
    expect(drainStartIndices).toEqual([0, 1])
    // SDK's turn-2 first content block uses SDK-index 0 (turn-local) — meridian
    // must allocate the next client index (2) instead of colliding with the
    // synthetic blocks above.
    const f3 = translateBlockingMessage(
      streamEvent({
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      }),
      state, enc,
    )
    const startFrame = decodeFrames(f3)[0]!
    expect(startFrame.type).toBe("content_block_start")
    expect(startFrame.data.index).toBe(2)
    // The matching delta must use the same remapped client index.
    const f4 = translateBlockingMessage(
      streamEvent({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "hello" },
      }),
      state, enc,
    )
    const deltaFrame = decodeFrames(f4)[0]!
    expect(deltaFrame.data.index).toBe(2)
    const f5 = translateBlockingMessage(
      streamEvent({ type: "content_block_stop", index: 0 }),
      state, enc,
    )
    expect(decodeFrames(f5)[0]!.data.index).toBe(2)
  })

  it("suppresses orphan message_delta(stop_reason=tool_use) when the only tool_uses this turn were suppressed WebSearch blocks", () => {
    const state = freshState()
    translateBlockingMessage(
      streamEvent({ type: "message_start", message: { id: "msg_1", usage: {} } }),
      state, enc,
    )
    // SDK emits a WebSearch tool_use — suppressed and tracked as skipped.
    translateBlockingMessage(
      streamEvent({
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "tu_1", name: "WebSearch", input: {} },
      }),
      state, enc,
    )
    expect(state.webSearchSkipIndices.has(0)).toBe(true)

    // SDK now emits the turn-ending message_delta with stop_reason=tool_use.
    // No real client-callable tool_use was forwarded; meridian must drop the
    // frame so the client never sees an orphaned "act on tool_use" signal.
    const out = translateBlockingMessage(
      streamEvent({
        type: "message_delta",
        delta: { stop_reason: "tool_use", stop_sequence: null },
        usage: { output_tokens: 10 },
      }),
      state, enc,
    )
    expect(out.length).toBe(0)
    // pendingRoundClose stays unarmed because no real tool_use_id was tracked.
    expect(state.pendingRoundClose).toBeNull()
  })

  it("forwards message_delta(stop_reason=tool_use) when at least one passthrough tool_use is real", () => {
    const state = freshState()
    translateBlockingMessage(
      streamEvent({ type: "message_start", message: { id: "msg_1", usage: {} } }),
      state, enc,
    )
    // A real passthrough tool_use is emitted — its id lands in toolUseIdBySdkIdx.
    translateBlockingMessage(
      streamEvent({
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "tu_real", name: "mcp__tools__my-tool", input: {} },
      }),
      state, enc,
    )
    // Plus a WebSearch tool_use that gets suppressed.
    translateBlockingMessage(
      streamEvent({
        type: "content_block_start",
        index: 1,
        content_block: { type: "tool_use", id: "tu_ws", name: "WebSearch", input: {} },
      }),
      state, enc,
    )
    // message_delta with stop_reason=tool_use SHOULD flow because expectedIds
    // contains tu_real even though tu_ws was suppressed.
    const out = translateBlockingMessage(
      streamEvent({
        type: "message_delta",
        delta: { stop_reason: "tool_use", stop_sequence: null },
        usage: { output_tokens: 5 },
      }),
      state, enc,
    )
    expect(out.length).toBe(1)
    expect(decodeFrames(out)[0]!.data.delta.stop_reason).toBe("tool_use")
    expect(state.pendingRoundClose).not.toBeNull()
    expect(state.pendingRoundClose!.expectedIds.has("tu_real")).toBe(true)
    expect(state.pendingRoundClose!.expectedIds.has("tu_ws")).toBe(false)
  })

  it("suppresses the SDK's client-tool-form WebSearch tool_use_start and its delta/stop", () => {
    const state = freshState()

    // First emit a message_start so the round is open.
    translateBlockingMessage(
      streamEvent({ type: "message_start", message: { id: "msg_1", usage: {} } }),
      state, enc,
    )

    // SDK emits a non-passthrough-prefix tool_use named "WebSearch" — the
    // translator must drop it (and its trailing delta/stop on the same index).
    const skipped = translateBlockingMessage(
      streamEvent({
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "tu_1", name: "WebSearch", input: {} },
      }),
      state, enc,
    )
    expect(skipped.length).toBe(0)
    expect(state.webSearchSkipIndices.has(0)).toBe(true)

    const skippedDelta = translateBlockingMessage(
      streamEvent({
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: "{\"query\":\"x\"}" },
      }),
      state, enc,
    )
    expect(skippedDelta.length).toBe(0)

    const skippedStop = translateBlockingMessage(
      streamEvent({ type: "content_block_stop", index: 0 }),
      state, enc,
    )
    expect(skippedStop.length).toBe(0)
  })

  it("forwards non-WebSearch tool_use blocks even when useBuiltinWebSearch is true", () => {
    const state = freshState()
    translateBlockingMessage(
      streamEvent({ type: "message_start", message: { id: "msg_1", usage: {} } }),
      state, enc,
    )

    // Passthrough-prefixed tool_use is the agent's tool — must still flow.
    const out = translateBlockingMessage(
      streamEvent({
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "tu_1", name: "mcp__tools__my-tool", input: {} },
      }),
      state, enc,
    )
    const decoded = decodeFrames(out)
    expect(decoded.length).toBe(1)
    expect(decoded[0]!.data.content_block.name).toBe("my-tool")
  })

  it("when useBuiltinWebSearch=false, the translator does not touch any tool_use blocks", () => {
    const key = { kind: "lineage", hash: `t-no-ws-${Math.random()}` } as const
    const state = blockingPool.acquire(key, {
      key,
      ephemeralSessionId: "00000000-0000-0000-0000-00000000ws02",
      workingDirectory: "/tmp",
      priorMessageHashes: [],
      cleanup: async () => {},
      useBuiltinWebSearch: false,
      pendingWebSearchResults: [],
    })

    translateBlockingMessage(
      streamEvent({ type: "message_start", message: { id: "msg_1", usage: {} } }),
      state, enc,
    )

    // Non-passthrough tool_use forwards as-is when useBuiltinWebSearch is off.
    const out = translateBlockingMessage(
      streamEvent({
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "tu_1", name: "SomeOtherTool", input: {} },
      }),
      state, enc,
    )
    expect(out.length).toBe(1)
    expect(state.webSearchSkipIndices.size).toBe(0)
  })
})
