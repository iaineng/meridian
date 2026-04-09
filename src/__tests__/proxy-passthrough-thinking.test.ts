/**
 * Passthrough mode: thinking blocks are forwarded to the client.
 *
 * type:"thinking" / type:"redacted_thinking" blocks are passed through
 * so clients that support extended thinking can render them.
 */

import { describe, it, expect, mock, beforeEach } from "bun:test"
import {
  messageStart,
  textBlockStart,
  toolUseBlockStart,
  inputJsonDelta,
  blockStop,
  messageDelta,
  messageStop,
  textDelta,
  parseSSE,
  assistantStreamEvents,
  streamEvent,
  makeRequest,
} from "./helpers"
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"

// ─── OpenCode edit tool definition (real schema from OpenCode) ───────────────
const EDIT_TOOL = {
  name: "edit",
  description: "Edit a file by replacing oldString with newString",
  input_schema: {
    type: "object",
    properties: {
      filePath: { type: "string" },
      oldString: { type: "string" },
      newString: { type: "string" },
    },
    required: ["filePath", "oldString", "newString"],
  },
}

// ─── SDK mock ────────────────────────────────────────────────────────────────
let mockMessages: SDKMessage[] = []

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: () =>
    (async function* () {
      for (const msg of mockMessages) yield msg
    })(),
  createSdkMcpServer: () => ({
    type: "sdk",
    name: "test",
    instance: { tool: () => {} },
  }),
}))

mock.module("../logger", () => ({
  claudeLog: () => {},
  withClaudeLogContext: (_ctx: unknown, fn: () => unknown) => fn(),
}))

mock.module("../mcpTools", () => ({
  createOpencodeMcpServer: () => ({ type: "sdk", name: "opencode", instance: { tool: () => {} } }),
}))

const { createProxyServer, clearSessionCache } = await import("../proxy/server")

function app() {
  const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })
  return app
}

function passthroughRequest(stream: boolean, extra: Record<string, unknown> = {}) {
  return makeRequest({
    stream,
    tools: [EDIT_TOOL],
    messages: [{ role: "user", content: "Edit /tmp/hello.ts" }],
    ...extra,
  })
}

/** POST a request in passthrough mode (sets MERIDIAN_PASSTHROUGH for the call) */
async function fetchPassthrough(stream: boolean, extra: Record<string, unknown> = {}) {
  const prev = process.env.MERIDIAN_PASSTHROUGH
  process.env.MERIDIAN_PASSTHROUGH = "1"
  try {
    return await app().fetch(new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(passthroughRequest(stream, extra)),
    }))
  } finally {
    if (prev === undefined) delete process.env.MERIDIAN_PASSTHROUGH
    else process.env.MERIDIAN_PASSTHROUGH = prev
  }
}

// SDK prefix for passthrough MCP tools — must match PASSTHROUGH_MCP_PREFIX from passthroughTools.ts
const PREFIX = "mcp__p-tools__"

// Helper: a complete tool_use block (streamed)
function streamedToolUse(index: number, toolId: string) {
  return [
    toolUseBlockStart(index, `${PREFIX}edit`, toolId),
    inputJsonDelta(index, `{"filePath":"/tmp/hello.ts","oldString":"foo","newString":"bar"}`),
    blockStop(index),
  ]
}

// Helper: a thinking content block (streamed)
function thinkingBlockStart(index: number): SDKMessage {
  return {
    type: "stream_event",
    event: {
      type: "content_block_start",
      index,
      content_block: { type: "thinking", thinking: "" },
    },
    parent_tool_use_id: null,
    uuid: crypto.randomUUID(),
    session_id: "test-session",
  } as SDKMessage
}
function thinkingDelta(index: number, text: string): SDKMessage {
  return {
    type: "stream_event",
    event: {
      type: "content_block_delta",
      index,
      delta: { type: "thinking_delta", thinking: text },
    },
    parent_tool_use_id: null,
    uuid: crypto.randomUUID(),
    session_id: "test-session",
  } as SDKMessage
}

beforeEach(() => {
  clearSessionCache()
  mockMessages = []
})

// ─────────────────────────────────────────────────────────────────────────────
// Non-streaming: thinking blocks forwarded
// ─────────────────────────────────────────────────────────────────────────────

describe("passthrough non-streaming — thinking blocks forwarded", () => {
  it("forwards thinking blocks in non-streaming passthrough", async () => {
    mockMessages = assistantStreamEvents([
      { type: "thinking", thinking: "Let me plan the edit...", signature: "enc_sig_abc" },
      { type: "tool_use", id: "tu_002", name: `${PREFIX}edit`,
        input: { filePath: "/tmp/hello.ts", oldString: "foo", newString: "bar" } },
    ], { stopReason: "tool_use" })

    const res = await fetchPassthrough(false)
    const body = await res.json() as Record<string, unknown>

    const types = (body.content as Array<Record<string, unknown>>).map((b) => b.type)
    expect(types).toContain("tool_use")
    expect(types).toContain("thinking")
    expect(body.stop_reason).toBe("tool_use")
  })

  it("forwards redacted_thinking blocks in passthrough non-streaming", async () => {
    mockMessages = [
      messageStart(),
      streamEvent({ type: "content_block_start", index: 0, content_block: { type: "redacted_thinking", data: "redacted_data_xyz" } }),
      blockStop(0),
      toolUseBlockStart(1, `${PREFIX}edit`, "tu_003"),
      inputJsonDelta(1, JSON.stringify({ filePath: "/tmp/hello.ts", oldString: "foo", newString: "bar" })),
      blockStop(1),
      messageDelta("tool_use"),
      messageStop(),
    ]

    const res = await fetchPassthrough(false)
    const body = await res.json() as Record<string, unknown>

    const types = (body.content as Array<Record<string, unknown>>).map((b) => b.type)
    expect(types).toContain("redacted_thinking")
    expect(types).toContain("tool_use")
  })

  it("preserves tool_use input fields intact alongside thinking", async () => {
    mockMessages = assistantStreamEvents([
      { type: "thinking", thinking: "Planning...", signature: "enc_sig" },
      {
        type: "tool_use", id: "tu_004", name: `${PREFIX}edit`,
        input: { filePath: "/tmp/greet.ts", oldString: `"Hello " + name`, newString: "`Hello ${name}`" },
      },
    ], { stopReason: "tool_use" })

    const res = await fetchPassthrough(false)
    const body = await res.json() as Record<string, unknown>
    const content = body.content as Array<Record<string, unknown>>
    const tu = content.find((b) => b.type === "tool_use")

    expect(tu).toBeDefined()
    expect(tu!.name).toBe("edit")  // mcp__oc__ prefix stripped
    expect((tu!.input as Record<string, unknown>).filePath).toBe("/tmp/greet.ts")
    expect((tu!.input as Record<string, unknown>).oldString).toBe(`"Hello " + name`)
    expect((tu!.input as Record<string, unknown>).newString).toBe("`Hello ${name}`")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Streaming: thinking blocks forwarded
// ─────────────────────────────────────────────────────────────────────────────

describe("passthrough streaming — thinking blocks forwarded", () => {
  it("forwards thinking content_block_start and its deltas in the stream", async () => {
    mockMessages = [
      messageStart(),
      thinkingBlockStart(0),
      thinkingDelta(0, "I should use the edit tool"),
      blockStop(0),
      textBlockStart(1),
      textDelta(1, "Preparing edit..."),
      blockStop(1),
      ...streamedToolUse(2, "tu_stream_001"),
      messageDelta("tool_use"),
      messageStop(),
    ]

    const res = await fetchPassthrough(true)
    expect(res.status).toBe(200)
    const text = await res.text()
    const events = parseSSE(text)

    // thinking content_block_start should be present
    const blockStarts = events.filter((e) => e.event === "content_block_start")
    const blockTypes = blockStarts.map((e) => (e.data as any).content_block?.type)
    expect(blockTypes).toContain("thinking")

    // thinking_delta events should be present
    const deltas = events.filter((e) => e.event === "content_block_delta")
    const deltaTypes = deltas.map((e) => (e.data as any).delta?.type)
    expect(deltaTypes).toContain("thinking_delta")
  })

  it("forwards the tool_use block with thinking block preceding it", async () => {
    mockMessages = [
      messageStart(),
      thinkingBlockStart(0),
      thinkingDelta(0, "Plan the edit"),
      blockStop(0),
      ...streamedToolUse(1, "tu_stream_002"),
      messageDelta("tool_use"),
      messageStop(),
    ]

    const res = await fetchPassthrough(true)
    const text = await res.text()
    const events = parseSSE(text)

    const blockStarts = events.filter((e) => e.event === "content_block_start")
    const blockTypes = blockStarts.map((e) => (e.data as any).content_block?.type)
    expect(blockTypes).toContain("thinking")
    expect(blockTypes).toContain("tool_use")

    const tuStart = blockStarts.find((e) => (e.data as any).content_block?.type === "tool_use")!
    expect((tuStart.data as any).content_block?.name).toBe("edit")  // prefix stripped
  })

  it("tool_use input is complete and parseable alongside thinking", async () => {
    mockMessages = [
      messageStart(),
      thinkingBlockStart(0),
      thinkingDelta(0, "Planning..."),
      blockStop(0),
      toolUseBlockStart(1, `${PREFIX}edit`, "tu_stream_003"),
      inputJsonDelta(1, '{"filePath":"/tmp/g.ts","oldString":"foo '),
      inputJsonDelta(1, 'bar","newString":"baz qux"}'),
      blockStop(1),
      messageDelta("tool_use"),
      messageStop(),
    ]

    const res = await fetchPassthrough(true)
    const text = await res.text()
    const events = parseSSE(text)

    // Reconstruct the tool input from input_json_delta events
    const jsonDeltas = events
      .filter((e) => e.event === "content_block_delta" && (e.data as any).delta?.type === "input_json_delta")
      .map((e) => (e.data as any).delta?.partial_json as string)
    const fullJson = jsonDeltas.join("")
    const input = JSON.parse(fullJson) as Record<string, unknown>

    expect(input.filePath).toBe("/tmp/g.ts")
    expect(input.oldString).toBe("foo bar")
    expect(input.newString).toBe("baz qux")
  })

  it("forwards thinking blocks in non-passthrough mode too", async () => {
    mockMessages = [
      messageStart(),
      thinkingBlockStart(0),
      thinkingDelta(0, "Let me think..."),
      blockStop(0),
      textBlockStart(1),
      textDelta(1, "Here is the answer"),
      blockStop(1),
      messageDelta("end_turn"),
      messageStop(),
    ]

    // No tools in this request = not passthrough mode
    const res = await app().fetch(new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(makeRequest({ stream: true })),
    }))
    const text = await res.text()
    const events = parseSSE(text)

    const blockStarts = events.filter((e) => e.event === "content_block_start")
    const blockTypes = blockStarts.map((e) => (e.data as any).content_block?.type)
    expect(blockTypes).toContain("thinking")
  })
})
