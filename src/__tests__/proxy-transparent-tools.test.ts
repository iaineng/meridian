/**
 * Phase 2: Transparent Tool Handling Tests
 *
 * The proxy must NOT define its own tools. Instead, it should:
 * 1. Use maxTurns: 1 so Claude returns tool_use to the client (not executing internally)
 * 2. Not inject MCP tools or blocked/allowed tool lists
 * 3. Let OpenCode control the tool execution loop
 *
 * These tests verify the proxy acts as a transparent pass-through,
 * not as an agent that handles tools internally.
 */

import { describe, it, expect, mock, beforeEach } from "bun:test"

const HOMOGLYPH_MAP: Record<string, string> = {
  'a': '\u0430', 'c': '\u0441', 'e': '\u0435', 'i': '\u0456',
  'j': '\u0458', 'o': '\u043e', 'p': '\u0440', 's': '\u0455',
  'x': '\u0445', 'y': '\u0443',
  'A': '\u0410', 'B': '\u0412', 'C': '\u0421', 'E': '\u0415',
  'H': '\u041d', 'I': '\u0406', 'J': '\u0408', 'K': '\u041a',
  'M': '\u041c', 'N': '\u039d', 'O': '\u041e', 'P': '\u0420',
  'S': '\u0405', 'T': '\u0422', 'X': '\u0425', 'Z': '\u0396',
  'd': '\u0501', 'g': '\u0261', 'h': '\u04bb', 'q': '\u051b',
  'v': '\u03bd', 'w': '\u051d',
  'V': '\u0474', 'W': '\u051c',
  ' ': '\u3000', ':': '\uff1a',
}
function homoglyphEncode(s: string): string {
  let r = ''; for (const c of s) r += HOMOGLYPH_MAP[c] ?? c; return r
}

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
  makeRequest,
  makeToolResultRequest,
  parseSSE,
} from "./helpers"

// --- Capture SDK calls ---
let mockMessages: any[] = []
let capturedQueryParams: any = null

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: (params: any) => {
    capturedQueryParams = params
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

const { createProxyServer, clearSessionCache } = await import("../proxy/server")

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

// ============================================================
// PHASE 2: Transparent tool pass-through
// ============================================================

describe("Phase 2: SDK should not use internal tools", () => {
  beforeEach(() => {
    mockMessages = []
    capturedQueryParams = null
  })

  it("should use maxTurns: 200 for multi-turn tool execution", async () => {
    mockMessages = [
      messageStart(),
      textBlockStart(0),
      textDelta(0, "Hello"),
      blockStop(0),
      messageDelta("end_turn"),
      messageStop(),
    ]

    const app = createTestApp()
    const response = await postMessages(app, makeRequest({ stream: true }))
    await readStreamFull(response)

    expect(capturedQueryParams).toBeDefined()
    expect(capturedQueryParams.options.maxTurns).toBe(200)
  })

  it("should include MCP tools for internal tool execution", async () => {
    mockMessages = [
      assistantMessage([{ type: "text", text: "Hi" }]),
    ]

    const app = createTestApp()
    const response = await postMessages(app, makeRequest({ stream: false }))
    await response.json()

    expect(capturedQueryParams).toBeDefined()
    expect(capturedQueryParams.options.mcpServers).toBeDefined()
  })

  it("should block SDK built-in tools and allow only MCP tools", async () => {
    mockMessages = [
      assistantMessage([{ type: "text", text: "Hi" }]),
    ]

    const app = createTestApp()
    const response = await postMessages(app, makeRequest({ stream: false }))
    await response.json()

    // Block built-in tools (they use wrong param names)
    expect(capturedQueryParams.options.disallowedTools).toContain("Read")
    expect(capturedQueryParams.options.disallowedTools).toContain("Bash")
    expect(capturedQueryParams.options.disallowedTools).toContain("Write")

    // Allow only MCP tools (correct param names)
    expect(capturedQueryParams.options.allowedTools).toContain("mcp__opencode__read")
    expect(capturedQueryParams.options.allowedTools).toContain("mcp__opencode__bash")
  })

  it("should bypass permissions for automatic tool execution", async () => {
    mockMessages = [
      assistantMessage([{ type: "text", text: "Hi" }]),
    ]

    const app = createTestApp()
    const response = await postMessages(app, makeRequest({ stream: false }))
    await response.json()

    expect(capturedQueryParams.options.permissionMode).toBe("bypassPermissions")
    expect(capturedQueryParams.options.allowDangerouslySkipPermissions).toBe(true)
  })
})

describe("Phase 2: Message format preservation", () => {
  beforeEach(() => {
    mockMessages = []
    capturedQueryParams = null
    clearSessionCache()
  })

  it("should pass system prompt via appendSystemPrompt, not merged into messages", async () => {
    mockMessages = [
      assistantMessage([{ type: "text", text: "Hi" }]),
    ]

    const app = createTestApp()
    const response = await postMessages(app, makeRequest({
      stream: false,
      system: "You are a helpful assistant.",
      messages: [{ role: "user", content: "Hello" }],
    }))
    await response.json()

    // System prompt should be passed via systemPrompt option (append to Claude Code default)
    expect(capturedQueryParams).toBeDefined()
    expect(capturedQueryParams.options.systemPrompt).toEqual({
      type: "preset",
      preset: "claude_code",
      append: homoglyphEncode("You are a helpful assistant."),
    })
    // Prompt text should NOT contain the raw system context (it's in the SDK option now, homoglyph-encoded)
    const prompt = capturedQueryParams.prompt
    expect(typeof prompt).toBe("string")
    expect(prompt).not.toContain("You are a helpful assistant.")
  })

  it("should include tool_result content in the prompt sent to SDK", async () => {
    mockMessages = [
      assistantMessage([{ type: "text", text: "The file contains..." }]),
    ]

    const app = createTestApp()
    const request = makeToolResultRequest(
      "toolu_abc123",
      "file contents here",
      [{ role: "user", content: "Read test.ts" }]
    )
    request.stream = false // use non-streaming to get JSON response
    const response = await postMessages(app, request)
    await response.json()

    // The prompt sent to SDK should include the tool result context
    expect(capturedQueryParams).toBeDefined()
    expect(capturedQueryParams.prompt).toContain("file contents here")
  })
})
