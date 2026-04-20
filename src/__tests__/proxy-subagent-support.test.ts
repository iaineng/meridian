/**
 * Phase 3: Subagent and Multi-turn Support Tests
 *
 * Tests for:
 * 1. Concurrent requests (subagents must not be blocked by parent)
 * 2. Error recovery (Claude should be able to retry after tool errors)
 * 3. tool_result messages properly converted in follow-up requests
 * 4. Multiple tool calls in a single response
 */

import { describe, it, expect, mock, beforeEach } from "bun:test"
import { crEncode } from "../proxy/obfuscate"
import {
  messageStart,
  textBlockStart,
  toolUseBlockStart,
  textDelta,
  inputJsonDelta,
  blockStop,
  messageDelta,
  messageStop,
  assistantMessage,
  assistantStreamEvents,
  makeRequest,
  makeToolResultRequest,
  parseSSE,
} from "./helpers"

// --- Capture SDK calls ---
let mockMessages: any[] = []
let capturedQueryParams: any = null
let queryCallCount = 0

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: (params: any) => {
    capturedQueryParams = params
    queryCallCount++
    return (async function* () {
      for (const msg of mockMessages) {
        yield msg
      }
    })()
  },
  createSdkMcpServer: () => ({
    type: "sdk",
    name: "test",
    instance: {},
  }),
}))

mock.module("../logger", () => ({
  claudeLog: () => {},
  withClaudeLogContext: (_ctx: any, fn: any) => fn(),
}))

mock.module("../mcpTools", () => ({
  createOpencodeMcpServer: () => ({ type: "sdk", name: "opencode", instance: {} }),
}))

const { createProxyServer } = await import("../proxy/server")

function createTestApp() {
  const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })
  return app
}

async function postMessages(app: any, body: Record<string, unknown>) {
  const req = new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  return app.fetch(req)
}

async function readStreamFull(response: Response): Promise<string> {
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let result = ""
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    result += decoder.decode(value, { stream: true })
  }
  return result
}

/** Drain a structured-prompt AsyncIterable into searchable plain text.
 *  Concatenates all text and tool_result string content from every yielded
 *  user message. Returns the original string when prompt is a string. */
async function promptToText(prompt: any): Promise<string> {
  if (typeof prompt === "string") return prompt
  const out: string[] = []
  for await (const m of prompt) {
    const content = m?.message?.content
    if (Array.isArray(content)) {
      for (const b of content) {
        if (b?.type === "text" && typeof b.text === "string") out.push(b.text)
        else if (b?.type === "tool_result") {
          const c = b.content
          if (typeof c === "string") out.push(c)
          else if (Array.isArray(c)) {
            for (const sub of c) {
              if (sub?.type === "text" && typeof sub.text === "string") out.push(sub.text)
            }
          }
        }
      }
    } else if (typeof content === "string") {
      out.push(content)
    }
  }
  return out.join("\n")
}

// ============================================================
// CONCURRENT REQUESTS
// ============================================================

describe("Phase 3: Concurrent request support", () => {
  beforeEach(() => {
    mockMessages = []
    capturedQueryParams = null
    queryCallCount = 0
  })

  it("should handle concurrent streaming requests without blocking", async () => {
    mockMessages = [
      messageStart(),
      textBlockStart(0),
      textDelta(0, "Response"),
      blockStop(0),
      messageDelta("end_turn"),
      messageStop(),
    ]

    const app = createTestApp()

    // Fire two requests simultaneously (like OpenCode does with main + title gen)
    const [r1, r2] = await Promise.all([
      postMessages(app, makeRequest({ stream: true })),
      postMessages(app, makeRequest({ stream: true })),
    ])

    expect(r1.status).toBe(200)
    expect(r2.status).toBe(200)

    // Both should complete (not block each other)
    const [text1, text2] = await Promise.all([
      readStreamFull(r1),
      readStreamFull(r2),
    ])

    expect(text1).toContain("Response")
    expect(text2).toContain("Response")
  })

  it("should handle concurrent non-streaming requests", async () => {
    mockMessages = assistantStreamEvents([{ type: "text", text: "OK" }])

    const app = createTestApp()

    const [r1, r2] = await Promise.all([
      postMessages(app, makeRequest({ stream: false })),
      postMessages(app, makeRequest({ stream: false })),
    ])

    const [b1, b2] = await Promise.all([
      r1.json() as Promise<any>,
      r2.json() as Promise<any>,
    ])

    expect(b1.content[0].text).toBe("OK")
    expect(b2.content[0].text).toBe("OK")
  })
})

// ============================================================
// TOOL RESULT HANDLING
// ============================================================

describe("Phase 3: Tool result in follow-up requests", () => {
  beforeEach(() => {
    mockMessages = []
    capturedQueryParams = null
    queryCallCount = 0
  })

  it("balanced-slices trailing tool_result into JSONL; prompt is a Continue. sentinel", async () => {
    mockMessages = [
      assistantMessage([{ type: "text", text: "Here are the contents." }]),
    ]

    const app = createTestApp()
    const response = await postMessages(app, makeRequest({
      stream: false,
      messages: [
        { role: "user", content: "Read test.ts" },
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "test.ts" } },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_1", content: "console.log('hello')" },
          ],
        },
      ],
    }))
    await response.json()

    // Balanced slicing: trailing assistant has unresolved tool_use, so the
    // tool_result user is written into the JSONL (along with a synthetic
    // `[HEARTBEAT]` assistant closer) and the SDK prompt becomes `[ACK]`.
    const promptText = await promptToText(capturedQueryParams.prompt)
    expect(promptText).toBe("[ACK]")
    // A fresh session UUID is generated (resume points to the written jsonl).
    expect(typeof capturedQueryParams.options.resume).toBe("string")
  })

  it("should handle multiple tool results in a single message", async () => {
    mockMessages = [
      assistantMessage([{ type: "text", text: "Both files read." }]),
    ]

    const app = createTestApp()
    const response = await postMessages(app, makeRequest({
      stream: false,
      messages: [
        { role: "user", content: "Read both files" },
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "toolu_a", name: "Read", input: { file_path: "a.ts" } },
            { type: "tool_use", id: "toolu_b", name: "Read", input: { file_path: "b.ts" } },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_a", content: "file a contents" },
            { type: "tool_result", tool_use_id: "toolu_b", content: "file b contents" },
          ],
        },
      ],
    }))
    await response.json()

    // Both tool_results live in the JSONL transcript; prompt is the `[ACK]`
    // infrastructure signal (balanced slicing).
    const promptText = await promptToText(capturedQueryParams.prompt)
    expect(promptText).toBe("[ACK]")
    expect(typeof capturedQueryParams.options.resume).toBe("string")
  })

  it("should handle error tool results", async () => {
    mockMessages = [
      assistantMessage([{ type: "text", text: "I see the error, let me try differently." }]),
    ]

    const app = createTestApp()
    const response = await postMessages(app, makeRequest({
      stream: false,
      messages: [
        { role: "user", content: "Do something" },
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "toolu_err", name: "Task", input: { agent_type: "general-purpose", prompt: "read file" } },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_err", content: "Error: Unknown agent type: general-purpose is not a valid agent type", is_error: true },
          ],
        },
      ],
    }))
    await response.json()

    // Error tool_result also goes through balanced slicing into the JSONL.
    const promptText = await promptToText(capturedQueryParams.prompt)
    expect(promptText).toBe("[ACK]")
    expect(typeof capturedQueryParams.options.resume).toBe("string")
  })
})

// ============================================================
// MULTIPLE TOOL CALLS IN SINGLE RESPONSE
// ============================================================

describe("Phase 3: Multiple tool calls in response", () => {
  beforeEach(() => {
    mockMessages = []
    capturedQueryParams = null
  })

  it("should forward multiple tool_use blocks in streaming", async () => {
    mockMessages = [
      messageStart(),
      // First tool call
      toolUseBlockStart(0, "Read", "toolu_r1"),
      inputJsonDelta(0, '{"file_path":"a.ts"}'),
      blockStop(0),
      // Second tool call
      toolUseBlockStart(1, "Read", "toolu_r2"),
      inputJsonDelta(1, '{"file_path":"b.ts"}'),
      blockStop(1),
      messageDelta("tool_use"),
      messageStop(),
    ]

    const app = createTestApp()
    const response = await postMessages(app, makeRequest({ stream: true }))
    const text = await readStreamFull(response)
    const events = parseSSE(text)

    const blockStarts = events.filter((e) => e.event === "content_block_start")
    const toolStarts = blockStarts.filter((e) => (e.data as any).content_block?.type === "tool_use")
    expect(toolStarts.length).toBe(2)
    expect((toolStarts[0]?.data as any).content_block.name).toBe("Read")
    expect((toolStarts[1]?.data as any).content_block.name).toBe("Read")
  })

  it("should include multiple tool_use blocks in non-streaming", async () => {
    mockMessages = assistantStreamEvents(
      [
        { type: "tool_use", id: "toolu_m1", name: "Read", input: { file_path: "a.ts" } },
        { type: "tool_use", id: "toolu_m2", name: "Bash", input: { command: "ls" } },
      ],
      { stopReason: "tool_use" }
    )

    const app = createTestApp()
    const response = await postMessages(app, makeRequest({ stream: false }))
    const body = await response.json() as any

    expect(body.content.length).toBe(2)
    expect(body.content[0].type).toBe("tool_use")
    expect(body.content[0].name).toBe("Read")
    expect(body.content[1].type).toBe("tool_use")
    expect(body.content[1].name).toBe("Bash")
    expect(body.stop_reason).toBe("tool_use")
  })
})
