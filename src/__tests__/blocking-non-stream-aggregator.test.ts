/**
 * Unit tests for `createBlockingJsonAggregator`. The aggregator reverse-parses
 * the SSE frames produced by `translateBlockingMessage` into a single
 * Anthropic-format JSON Message, used by the non-stream blocking sink to
 * mirror what the streaming sink writes verbatim.
 */

import { describe, it, expect } from "bun:test"
import { createBlockingJsonAggregator } from "../proxy/pipeline/blockingNonStreamAggregator"

const enc = new TextEncoder()

function frame(type: string, data: unknown): Uint8Array {
  return enc.encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`)
}

describe("blockingNonStreamAggregator", () => {
  it("captures messageId and base usage from message_start", () => {
    const agg = createBlockingJsonAggregator()
    agg.consumeSseFrame(frame("message_start", {
      type: "message_start",
      message: {
        id: "msg_abc",
        usage: { input_tokens: 100, cache_read_input_tokens: 5 },
      },
      index: 0,
    }))
    const out = agg.build("claude-sonnet-4-5-20250929")
    expect(out.id).toBe("msg_abc")
    expect(out.usage.input_tokens).toBe(100)
    expect(out.usage.cache_read_input_tokens).toBe(5)
    expect(out.role).toBe("assistant")
    expect(out.type).toBe("message")
    expect(out.model).toBe("claude-sonnet-4-5-20250929")
    expect(out.content).toEqual([])
  })

  it("synthesises a fallback id when message_start is absent", () => {
    const agg = createBlockingJsonAggregator()
    const out = agg.build("model")
    expect(out.id).toMatch(/^msg_\d+$/)
  })

  it("accumulates text_delta into a single text content block", () => {
    const agg = createBlockingJsonAggregator()
    agg.consumeSseFrame(frame("message_start", {
      type: "message_start",
      message: { id: "msg_1", usage: { input_tokens: 1 } },
      index: 0,
    }))
    agg.consumeSseFrame(frame("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    }))
    agg.consumeSseFrame(frame("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "Hello, " },
    }))
    agg.consumeSseFrame(frame("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "world!" },
    }))
    agg.consumeSseFrame(frame("content_block_stop", {
      type: "content_block_stop",
      index: 0,
    }))
    const out = agg.build("m")
    expect(out.content).toEqual([{ type: "text", text: "Hello, world!" }])
  })

  it("accumulates input_json_delta and parses on content_block_stop", () => {
    const agg = createBlockingJsonAggregator()
    agg.consumeSseFrame(frame("message_start", {
      type: "message_start",
      message: { id: "msg_2" },
      index: 0,
    }))
    agg.consumeSseFrame(frame("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: "toolu_x", name: "listFiles", input: {} },
    }))
    agg.consumeSseFrame(frame("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: '{"path' },
    }))
    agg.consumeSseFrame(frame("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: '":"."}' },
    }))
    agg.consumeSseFrame(frame("content_block_stop", {
      type: "content_block_stop",
      index: 0,
    }))
    const out = agg.build("m")
    expect(out.content).toHaveLength(1)
    expect(out.content[0]).toMatchObject({
      type: "tool_use",
      id: "toolu_x",
      name: "listFiles",
      input: { path: "." },
    })
  })

  it("preserves thinking and signature blocks", () => {
    const agg = createBlockingJsonAggregator()
    agg.consumeSseFrame(frame("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "thinking", thinking: "" },
    }))
    agg.consumeSseFrame(frame("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "thinking_delta", thinking: "hmm" },
    }))
    agg.consumeSseFrame(frame("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "signature_delta", signature: "abcXY" },
    }))
    agg.consumeSseFrame(frame("content_block_stop", {
      type: "content_block_stop",
      index: 0,
    }))
    const out = agg.build("m")
    expect(out.content[0]).toMatchObject({
      type: "thinking",
      thinking: "hmm",
      signature: "abcXY",
    })
  })

  it("captures final output_tokens and stop_reason from message_delta", () => {
    const agg = createBlockingJsonAggregator()
    agg.consumeSseFrame(frame("message_start", {
      type: "message_start",
      message: { id: "msg_3", usage: { input_tokens: 10 } },
      index: 0,
    }))
    agg.consumeSseFrame(frame("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "tool_use", stop_sequence: null },
      usage: { output_tokens: 42 },
    }))
    const out = agg.build("m")
    expect(out.usage.output_tokens).toBe(42)
    expect(out.usage.input_tokens).toBe(10)
    expect(out.stop_reason).toBe("tool_use")
  })

  it("upgrades end_turn to tool_use when content has tool_use blocks", () => {
    const agg = createBlockingJsonAggregator()
    agg.consumeSseFrame(frame("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: "toolu_y", name: "x", input: {} },
    }))
    agg.consumeSseFrame(frame("content_block_stop", {
      type: "content_block_stop",
      index: 0,
    }))
    agg.consumeSseFrame(frame("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 1 },
    }))
    const out = agg.build("m")
    expect(out.stop_reason).toBe("tool_use")
  })

  it("markEnd('max_tokens') overrides stop_reason regardless of message_delta", () => {
    const agg = createBlockingJsonAggregator()
    agg.consumeSseFrame(frame("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "tool_use", stop_sequence: null },
      usage: { output_tokens: 5 },
    }))
    agg.markEnd("max_tokens")
    const out = agg.build("m")
    expect(out.stop_reason).toBe("max_tokens")
  })

  it("markEnd('end_turn') keeps message_delta's reason", () => {
    const agg = createBlockingJsonAggregator()
    agg.consumeSseFrame(frame("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 1 },
    }))
    agg.markEnd("end_turn")
    const out = agg.build("m")
    expect(out.stop_reason).toBe("end_turn")
  })

  it("malformed input_json leaves block input untouched", () => {
    const agg = createBlockingJsonAggregator()
    agg.consumeSseFrame(frame("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: "toolu_b", name: "x", input: { seeded: true } },
    }))
    agg.consumeSseFrame(frame("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: "not-json" },
    }))
    agg.consumeSseFrame(frame("content_block_stop", {
      type: "content_block_stop",
      index: 0,
    }))
    const out = agg.build("m")
    expect(out.content[0]).toMatchObject({ input: { seeded: true } })
  })

  it("ignores non-SSE frames silently", () => {
    const agg = createBlockingJsonAggregator()
    agg.consumeSseFrame(enc.encode(": heartbeat\n\n"))
    agg.consumeSseFrame(enc.encode("garbage"))
    const out = agg.build("m")
    expect(out.content).toEqual([])
  })

  it("handles multi-block ordering and SDK-index → array-index mapping", () => {
    const agg = createBlockingJsonAggregator()
    // Two blocks at SDK indices 0 and 1; deltas referenced by index.
    agg.consumeSseFrame(frame("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    }))
    agg.consumeSseFrame(frame("content_block_start", {
      type: "content_block_start",
      index: 1,
      content_block: { type: "tool_use", id: "toolu_c", name: "f", input: {} },
    }))
    agg.consumeSseFrame(frame("content_block_delta", {
      type: "content_block_delta",
      index: 1,
      delta: { type: "input_json_delta", partial_json: '{"a":1}' },
    }))
    agg.consumeSseFrame(frame("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "Calling..." },
    }))
    agg.consumeSseFrame(frame("content_block_stop", { type: "content_block_stop", index: 1 }))
    agg.consumeSseFrame(frame("content_block_stop", { type: "content_block_stop", index: 0 }))
    const out = agg.build("m")
    expect(out.content).toHaveLength(2)
    expect(out.content[0]).toMatchObject({ type: "text", text: "Calling..." })
    expect(out.content[1]).toMatchObject({ type: "tool_use", id: "toolu_c", input: { a: 1 } })
  })
})
