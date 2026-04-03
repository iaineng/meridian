/**
 * Tests for tool type filtering in passthrough mode.
 *
 * When passthrough is enabled, tools with a `type` field that is not "custom"
 * are filtered out. Exception: a single web_search tool switches to internal
 * SDK execution with maxTurns=200 and WebSearch unblocked.
 */

import { afterEach, beforeEach, describe, expect, it, mock, afterAll } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { assistantMessage } from "./helpers"

let capturedQueryParams: any = null
let mockMessages: any[] = []

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: (params: any) => {
    capturedQueryParams = params
    return (async function* () {
      for (const msg of mockMessages) {
        yield { ...msg, session_id: "sdk-test" }
      }
    })()
  },
  createSdkMcpServer: () => ({ type: "sdk", name: "test", instance: {
    tool: () => {},
  } }),
}))

mock.module("../logger", () => ({
  claudeLog: () => {},
  withClaudeLogContext: (_ctx: any, fn: any) => fn(),
}))

mock.module("../mcpTools", () => ({
  createOpencodeMcpServer: () => ({ type: "sdk", name: "opencode", instance: {} }),
}))

const tmpDir = mkdtempSync(join(tmpdir(), "tool-type-filter-test-"))
process.env.CLAUDE_PROXY_SESSION_DIR = tmpDir

const { createProxyServer, clearSessionCache } = await import("../proxy/server")
const { clearSharedSessions } = await import("../proxy/sessionStore")

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true })
  delete process.env.CLAUDE_PROXY_SESSION_DIR
  mock.restore()
})

beforeEach(() => {
  mockMessages = [assistantMessage([{ type: "text", text: "ok" }])]
  capturedQueryParams = null
  clearSessionCache()
  clearSharedSessions()
  process.env.CLAUDE_PROXY_PASSTHROUGH = "1"
})

afterEach(() => {
  delete process.env.CLAUDE_PROXY_PASSTHROUGH
})

function createTestApp() {
  const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })
  return app
}

async function sendRequest(app: any, tools: any[], stream = false, system?: string) {
  capturedQueryParams = null
  const response = await app.fetch(new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-5",
      max_tokens: 128,
      stream,
      messages: [{ role: "user", content: "hello" }],
      tools,
      ...(system ? { system } : {}),
    }),
  }))

  if (stream) {
    const reader = response.body?.getReader()
    if (reader) {
      while (true) {
        const { done } = await reader.read()
        if (done) break
      }
    }
  } else {
    await response.json()
  }

  return capturedQueryParams
}

describe("Tool type filtering in passthrough mode", () => {
  it("filters out non-custom typed tools", async () => {
    const app = createTestApp()
    const tools = [
      { name: "my_tool", type: "custom", description: "A custom tool", input_schema: { type: "object", properties: {} } },
      { type: "web_search_20250305" },
      { type: "computer_20241022" },
    ]
    const params = await sendRequest(app, tools)
    // Should still be passthrough (maxTurns=1) with only the custom tool
    expect(params.options.maxTurns).toBe(1)
    // WebSearch should still be blocked (not the single web_search exception)
    const disallowed = params.options.disallowedTools as string[]
    expect(disallowed).toContain("WebSearch")
  })

  it("single web_search tool triggers internal execution with maxTurns=200", async () => {
    const app = createTestApp()
    const tools = [{ type: "web_search_20250305" }]
    const params = await sendRequest(app, tools)
    // Should switch to internal mode
    expect(params.options.maxTurns).toBe(200)
    // WebSearch should NOT be blocked
    const disallowed = params.options.disallowedTools as string[]
    expect(disallowed).not.toContain("WebSearch")
    // No MCP tools should be registered (web_search-only path)
    expect(params.options.allowedTools).toBeUndefined()
    expect(params.options.mcpServers).toBeUndefined()
  })

  it("single web_search tool works in streaming mode", async () => {
    const app = createTestApp()
    const tools = [{ type: "web_search_20250305" }]
    const params = await sendRequest(app, tools, true)
    expect(params.options.maxTurns).toBe(200)
    const disallowed = params.options.disallowedTools as string[]
    expect(disallowed).not.toContain("WebSearch")
    // No MCP tools should be registered (web_search-only path)
    expect(params.options.allowedTools).toBeUndefined()
    expect(params.options.mcpServers).toBeUndefined()
  })

  it("tools without type field are treated as custom (not filtered)", async () => {
    const app = createTestApp()
    const tools = [
      { name: "my_tool", description: "A tool", input_schema: { type: "object", properties: {} } },
    ]
    const params = await sendRequest(app, tools)
    // Should remain passthrough (maxTurns=1)
    expect(params.options.maxTurns).toBe(1)
  })

  it("tools with type: 'custom' are preserved", async () => {
    const app = createTestApp()
    const tools = [
      { name: "my_tool", type: "custom", description: "A tool", input_schema: { type: "object", properties: {} } },
    ]
    const params = await sendRequest(app, tools)
    expect(params.options.maxTurns).toBe(1)
  })

  it("mixed tools: custom + web_search does NOT trigger internal execution", async () => {
    const app = createTestApp()
    const tools = [
      { name: "my_tool", type: "custom", description: "A tool", input_schema: { type: "object", properties: {} } },
      { type: "web_search_20250305" },
    ]
    const params = await sendRequest(app, tools)
    // 2 tools total → not the single web_search exception, stays passthrough
    expect(params.options.maxTurns).toBe(1)
    const disallowed = params.options.disallowedTools as string[]
    expect(disallowed).toContain("WebSearch")
  })

  it("single web_search preserves raw system prompt (no claude_code preset)", async () => {
    const app = createTestApp()
    const tools = [{ type: "web_search_20250305" }]
    const systemText = "You are a helpful search assistant."
    const params = await sendRequest(app, tools, false, systemText)
    // Should use raw system prompt string, not the claude_code preset object
    expect(typeof params.options.systemPrompt).toBe("string")
    // Content is homoglyph-encoded but must not be the preset wrapper
    expect(params.options.systemPrompt).not.toHaveProperty("type")
  })

  it("non-passthrough mode is unaffected by tool types", async () => {
    delete process.env.CLAUDE_PROXY_PASSTHROUGH
    const app = createTestApp()
    const tools = [{ type: "web_search_20250305" }]
    const params = await sendRequest(app, tools)
    // Normal mode always has maxTurns=200
    expect(params.options.maxTurns).toBe(200)
    // WebSearch is still blocked in normal mode (no useBuiltinWebSearch)
    const disallowed = params.options.disallowedTools as string[]
    expect(disallowed).toContain("WebSearch")
  })
})
