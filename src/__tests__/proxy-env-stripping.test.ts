/**
 * Environment Variable Stripping Tests
 *
 * Verifies that ANTHROPIC_API_KEY, ANTHROPIC_BASE_URL, and ANTHROPIC_AUTH_TOKEN
 * are stripped from the environment passed to SDK subprocesses, preventing:
 *   1. Infinite loops when the proxy sets these vars for OpenCode
 *   2. The subprocess using a fake "dummy" API key instead of native Claude Max auth
 *
 * Related: https://github.com/rynfar/meridian/issues/XXX
 */

import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Capture the env passed to query()
let capturedQueryOptions: any = null
const savedEnv: Record<string, string | undefined> = {}
let tmpHome: string = ""

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: (params: any) => {
    capturedQueryOptions = params.options
    return (async function* () {
      yield {
        type: "assistant",
        message: {
          id: "msg_test",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "ok" }],
          model: "claude-sonnet-4-5",
          stop_reason: "end_turn",
          usage: { input_tokens: 10, output_tokens: 5 },
        },
        session_id: "sess-env-test",
      }
    })()
  },
  createSdkMcpServer: () => ({ type: "sdk", name: "test", instance: {} }),
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

async function post(app: any, body: any) {
  return app.fetch(new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }))
}

const BASIC_REQUEST = {
  model: "claude-sonnet-4-5",
  max_tokens: 1024,
  stream: false,
  messages: [{ role: "user", content: "hello" }],
}

const OAUTH_ENV_KEYS = [
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_ACCOUNT_UUID",
  "CLAUDE_CODE_USER_EMAIL",
  "CLAUDE_CODE_ORGANIZATION_UUID",
] as const

describe("Environment variable stripping", () => {
  beforeEach(() => {
    capturedQueryOptions = null
    clearSessionCache()
    // Save current env
    for (const key of [
      "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN",
      "HOME", "USERPROFILE",
      "CLAUDE_CODE_ENTRYPOINT",
      ...OAUTH_ENV_KEYS,
    ]) {
      savedEnv[key] = process.env[key]
    }
    // Isolate HOME so the OAuth env resolver can't pick up the runner's
    // real ~/.claude.json. Also drop any parent CLAUDE_CODE_* the runner
    // inherited so positive assertions below are deterministic.
    tmpHome = mkdtempSync(join(tmpdir(), "meridian-env-strip-home-"))
    process.env.HOME = tmpHome
    process.env.USERPROFILE = tmpHome
    for (const k of OAUTH_ENV_KEYS) delete process.env[k]
    delete process.env.CLAUDE_CODE_ENTRYPOINT
  })

  afterEach(() => {
    // Restore env
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
    try { rmSync(tmpHome, { recursive: true, force: true }) } catch {}
  })

  it("should strip ANTHROPIC_API_KEY from subprocess env", async () => {
    process.env.ANTHROPIC_API_KEY = "dummy"
    const app = createTestApp()
    await post(app, BASIC_REQUEST)
    expect(capturedQueryOptions).toBeDefined()
    expect(capturedQueryOptions.env.ANTHROPIC_API_KEY).toBeUndefined()
  })

  it("should strip ANTHROPIC_BASE_URL from subprocess env", async () => {
    process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:3456"
    const app = createTestApp()
    await post(app, BASIC_REQUEST)
    expect(capturedQueryOptions).toBeDefined()
    expect(capturedQueryOptions.env.ANTHROPIC_BASE_URL).toBeUndefined()
  })

  it("should strip ANTHROPIC_AUTH_TOKEN from subprocess env", async () => {
    process.env.ANTHROPIC_AUTH_TOKEN = "some-token"
    const app = createTestApp()
    await post(app, BASIC_REQUEST)
    expect(capturedQueryOptions).toBeDefined()
    expect(capturedQueryOptions.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
  })

  it("should strip all three Anthropic env vars simultaneously", async () => {
    process.env.ANTHROPIC_API_KEY = "dummy"
    process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:3456"
    process.env.ANTHROPIC_AUTH_TOKEN = "tok-123"
    const app = createTestApp()
    await post(app, BASIC_REQUEST)
    expect(capturedQueryOptions).toBeDefined()
    expect(capturedQueryOptions.env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(capturedQueryOptions.env.ANTHROPIC_BASE_URL).toBeUndefined()
    expect(capturedQueryOptions.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
  })

  it("should preserve other env vars", async () => {
    process.env.ANTHROPIC_API_KEY = "dummy"
    process.env.MY_CUSTOM_VAR = "keep-me"
    const app = createTestApp()
    await post(app, BASIC_REQUEST)
    expect(capturedQueryOptions.env.MY_CUSTOM_VAR).toBe("keep-me")
    delete process.env.MY_CUSTOM_VAR
  })

  it("should set ENABLE_TOOL_SEARCH to false", async () => {
    const app = createTestApp()
    await post(app, BASIC_REQUEST)
    expect(capturedQueryOptions.env.ENABLE_TOOL_SEARCH).toBe("false")
  })

  it("should not inject CLAUDE_CODE_ENTRYPOINT when parent is unset", async () => {
    const app = createTestApp()
    await post(app, BASIC_REQUEST)
    expect(capturedQueryOptions.env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined()
  })

  it("should pass parent CLAUDE_CODE_ENTRYPOINT through unchanged", async () => {
    process.env.CLAUDE_CODE_ENTRYPOINT = "cli"
    const app = createTestApp()
    await post(app, BASIC_REQUEST)
    expect(capturedQueryOptions.env.CLAUDE_CODE_ENTRYPOINT).toBe("cli")
  })

  it("should still strip CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS", async () => {
    process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = "true"
    const app = createTestApp()
    await post(app, BASIC_REQUEST)
    expect(capturedQueryOptions.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS).toBeUndefined()
    delete process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS
  })

  it("should work in streaming mode too", async () => {
    process.env.ANTHROPIC_API_KEY = "dummy"
    process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:3456"
    const app = createTestApp()
    const res = await post(app, { ...BASIC_REQUEST, stream: true })
    // Consume the stream to trigger the query
    await res.text()
    expect(capturedQueryOptions).toBeDefined()
    expect(capturedQueryOptions.env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(capturedQueryOptions.env.ANTHROPIC_BASE_URL).toBeUndefined()
  })
})
