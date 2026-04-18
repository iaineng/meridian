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

import { obfuscateSystemMessage, crEncode } from "../proxy/obfuscate"

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
      append: obfuscateSystemMessage("You are a helpful assistant."),
    })
    // Prompt text should NOT contain the raw system context (it's in the SDK option now, obfuscated)
    const prompt = capturedQueryParams.prompt
    expect(typeof prompt).toBe("string")
    expect(prompt).not.toContain("You are a helpful assistant.")
  })

  it("balanced-slices tool_result into JSONL; SDK prompt is a Continue. sentinel", async () => {
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

    // Balanced slicing: the tool_result is written into the JSONL transcript
    // (along with a synthetic assistant closer so the transcript ends on an
    // assistant turn) and the SDK prompt becomes "Continue.". This prevents
    // the SDK's z77() deferred-tool detection from forking the conversation
    // and keeps the tool_result's bytes stable across subsequent requests.
    expect(capturedQueryParams).toBeDefined()
    const prompt = capturedQueryParams.prompt
    const promptText = typeof prompt === "string"
      ? prompt
      : await (async () => {
          const out: string[] = []
          for await (const m of prompt) {
            const c = m?.message?.content
            if (Array.isArray(c)) {
              for (const b of c) if (b?.type === "text") out.push(b.text)
            } else if (typeof c === "string") {
              out.push(c)
            }
          }
          return out.join("")
        })()
    expect(promptText).toBe("Continue.")
    expect(typeof capturedQueryParams.options.resume).toBe("string")
  })
})
