/**
 * Blocking-MCP dispatch routes ALL ephemeral+passthrough+tools requests to the
 * blocking pipeline, including built-in-only tool sets like lone `web_search`.
 *
 * The blocking translator handles WebSearch correctly:
 *   - duplicate `message_start` frames (the SDK opens a fresh API turn after
 *     each local WebSearch call) are coalesced into one client-visible message
 *   - the model's client-tool `tool_use { name: "WebSearch" }` is suppressed
 *   - `state.pendingWebSearchResults` (populated by the PostToolUse hook) is
 *     drained into synthetic `server_tool_use` / `web_search_tool_result`
 *     blocks at each duplicate-message_start boundary
 *
 * This test verifies the dispatch decision lands on blocking. The translator
 * mechanics live in `blocking-websearch-translator.test.ts`.
 */

import { describe, it, expect, beforeEach, afterEach, mock, afterAll } from "bun:test"
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
  createSdkMcpServer: () => ({
    type: "sdk",
    name: "test",
    instance: { tool: () => {} },
  }),
  tool: (name: string, description: string, shape: any, handler: Function) =>
    ({ name, description, shape, handler }),
}))

mock.module("../logger", () => ({
  claudeLog: () => {},
  withClaudeLogContext: (_ctx: any, fn: any) => fn(),
}))

mock.module("../mcpTools", () => ({
  createOpencodeMcpServer: () => ({ type: "sdk", name: "opencode", instance: {} }),
}))

const tmpDir = mkdtempSync(join(tmpdir(), "blocking-dispatch-builtin-only-"))
process.env.CLAUDE_PROXY_SESSION_DIR = tmpDir

const { createProxyServer, clearSessionCache } = await import("../proxy/server")
const { clearSharedSessions } = await import("../proxy/sessionStore")
const { blockingPool } = await import("../proxy/session/blockingPool")

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true })
  delete process.env.CLAUDE_PROXY_SESSION_DIR
  mock.restore()
})

beforeEach(async () => {
  mockMessages = [assistantMessage([{ type: "text", text: "ok" }])]
  capturedQueryParams = null
  clearSessionCache()
  clearSharedSessions()
  await blockingPool._reset()
  process.env.MERIDIAN_PASSTHROUGH = "1"
  process.env.MERIDIAN_EPHEMERAL_JSONL = "1"
  process.env.MERIDIAN_BLOCKING_MCP = "1"
})

afterEach(async () => {
  delete process.env.MERIDIAN_PASSTHROUGH
  delete process.env.MERIDIAN_EPHEMERAL_JSONL
  delete process.env.MERIDIAN_BLOCKING_MCP
  await blockingPool._reset()
})

function createTestApp() {
  const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })
  return app
}

async function sendRequest(app: any, tools: any[]) {
  capturedQueryParams = null
  const response = await app.fetch(new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-5",
      max_tokens: 128,
      stream: false,
      messages: [{ role: "user", content: "hello" }],
      tools,
    }),
  }))
  await response.json()
  return capturedQueryParams
}

async function sendRequestRaw(app: any, body: Record<string, unknown>) {
  capturedQueryParams = null
  const response = await app.fetch(new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-5",
      max_tokens: 128,
      stream: false,
      messages: [{ role: "user", content: "hello" }],
      ...body,
    }),
  }))
  await response.json()
  return capturedQueryParams
}

describe("Blocking dispatch with built-in tools", () => {
  it("lone web_search → blocking path (maxTurns=10_000, useBuiltinWebSearch flipped on)", async () => {
    const app = createTestApp()
    const params = await sendRequest(app, [{ type: "web_search_20250305" }])
    expect(params).not.toBeNull()
    // Blocking dispatch lifts maxTurns to 10_000 — the SDK can chain multiple
    // internal turns around WebSearch without burning the round budget.
    expect(params.options.maxTurns).toBe(10_000)
    // CLAUDE_CODE_STREAM_CLOSE_TIMEOUT is the blocking-only env injection.
    expect(params.options.env?.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT).toBe("1800000")
    // WebSearch unblocked in disallowedTools (single-web_search flip).
    const disallowed = params.options.disallowedTools as string[]
    expect(disallowed).not.toContain("WebSearch")
  })

  it("custom + web_search → blocking path (mixed mode preserves both)", async () => {
    const app = createTestApp()
    const tools = [
      { name: "my_tool", type: "custom", description: "x", input_schema: { type: "object", properties: {} } },
      { type: "web_search_20250305" },
    ]
    const params = await sendRequest(app, tools)
    expect(params).not.toBeNull()
    expect(params.options.maxTurns).toBe(10_000)
    expect(params.options.env?.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT).toBe("1800000")
    const disallowed = params.options.disallowedTools as string[]
    expect(disallowed).not.toContain("WebSearch")
  })

  it("lone custom → blocking path (baseline)", async () => {
    const app = createTestApp()
    const tools = [
      { name: "my_tool", type: "custom", description: "x", input_schema: { type: "object", properties: {} } },
    ]
    const params = await sendRequest(app, tools)
    expect(params).not.toBeNull()
    expect(params.options.maxTurns).toBe(10_000)
  })

  it("no tools at all → blocking path (env owns the dispatch decision)", async () => {
    // Plain chat: no tools, no outputFormat. Previously gated out by the
    // hasTools precondition and routed to ephemeral/executor; now uniform
    // blocking when the env switch is on.
    const app = createTestApp()
    const params = await sendRequestRaw(app, {})
    expect(params).not.toBeNull()
    expect(params.options.maxTurns).toBe(10_000)
    expect(params.options.env?.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT).toBe("1800000")
  })

  it("outputFormat-only (no tools) → blocking path with full retry budget", async () => {
    const app = createTestApp()
    const params = await sendRequestRaw(app, {
      output_config: {
        format: {
          type: "json_schema",
          schema: {
            type: "object",
            properties: { title: { type: "string" } },
            required: ["title"],
            additionalProperties: false,
          },
        },
      },
    })
    expect(params).not.toBeNull()
    // 10_000 turns absorbs the SDK's StructuredOutput retry attempts. Without
    // this, passthrough mode capped retries at maxTurns=1 and a single
    // schema-validation miss flipped the whole response into the executor's
    // catch-path "message_delta(0) + message_stop + error" envelope.
    expect(params.options.maxTurns).toBe(10_000)
    expect(params.options.env?.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT).toBe("1800000")
    // outputFormat is propagated to the SDK options so StructuredOutput is
    // injected as a tool the model is forced to call.
    expect(params.options.outputFormat).toBeDefined()
    expect((params.options.outputFormat as any).type).toBe("json_schema")
  })

  it("empty tools array (`tools: []`) → blocking path", async () => {
    // Edge case from clients that send `tools: []` to disable tools while
    // still using StructuredOutput. The old `tools.length > 0` check
    // routed this away from blocking; uniform blocking handles it.
    const app = createTestApp()
    const params = await sendRequestRaw(app, { tools: [] })
    expect(params).not.toBeNull()
    expect(params.options.maxTurns).toBe(10_000)
  })
})
