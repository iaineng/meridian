/**
 * Cross-Provider Detection Tests
 *
 * When a user converses through the proxy, switches to another provider
 * (GPT/Gemini), has exchanges, then switches back, the proxy should
 * preserve the external provider's assistant messages as context rather
 * than silently dropping them.
 *
 * Strategy: position-based. The leading assistant message in the resume
 * delta is always the SDK's own response (already in SDK history) and
 * gets skipped. All subsequent assistant messages are from external
 * providers and get preserved as XML-wrapped context.
 */

import { describe, it, expect, mock, beforeEach } from "bun:test"
import { assistantMessage } from "./helpers"

// --- Capture SDK calls ---
let mockMessages: any[] = []
let capturedQueryParams: any = null
let queryCallCount = 0

const MOCK_SDK_SESSION = "sdk-session-cross-provider"

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: (params: any) => {
    capturedQueryParams = params
    queryCallCount++
    return (async function* () {
      for (const msg of mockMessages) {
        yield { ...msg, session_id: MOCK_SDK_SESSION }
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

async function post(app: any, body: any, headers: Record<string, string> = {}) {
  const req = new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  })
  return app.fetch(req)
}

// ============================================================
// CROSS-PROVIDER ASSISTANT MESSAGE DETECTION
// ============================================================

describe("Cross-provider: position-based assistant message handling", () => {
  beforeEach(() => {
    mockMessages = [
      assistantMessage([{ type: "text", text: "SDK response" }]),
    ]
    clearSessionCache()
    capturedQueryParams = null
    queryCallCount = 0
  })

  it("should skip leading assistant message on resume (SDK response)", async () => {
    const app = createTestApp()

    // First request — establishes session
    const r1 = await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      stream: false,
      messages: [{ role: "user", content: "Hello" }],
    }, { "x-opencode-session": "cp-session-1" })
    await r1.json()

    // Second request — resume with SDK assistant (delta[0]) + new user
    mockMessages = [
      assistantMessage([{ type: "text", text: "I remember!" }]),
    ]

    const r2 = await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      stream: false,
      messages: [
        { role: "user", content: "Hello" },
        { role: "assistant", content: [{ type: "text", text: "SDK response" }] },
        { role: "user", content: "Follow up" },
      ],
    }, { "x-opencode-session": "cp-session-1" })
    await r2.json()

    expect(capturedQueryParams.options.resume).toBe(MOCK_SDK_SESSION)
    const prompt = capturedQueryParams.prompt
    expect(typeof prompt).toBe("string")
    // Leading assistant (SDK response) should be skipped
    expect(prompt).not.toContain("SDK response")
    expect(prompt).toContain("Follow up")
  })

  it("should preserve non-leading assistant messages (external provider)", async () => {
    const app = createTestApp()

    const r1 = await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      stream: false,
      messages: [{ role: "user", content: "Hello" }],
    }, { "x-opencode-session": "cp-session-2" })
    await r1.json()

    mockMessages = [
      assistantMessage([{ type: "text", text: "Resumed!" }]),
    ]

    const r2 = await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      stream: false,
      messages: [
        { role: "user", content: "Hello" },
        { role: "assistant", content: [{ type: "text", text: "SDK response" }] },
        { role: "user", content: "Switched to GPT" },
        { role: "assistant", content: [{ type: "text", text: "GPT says hi" }] },
        { role: "user", content: "Back to Claude" },
      ],
    }, { "x-opencode-session": "cp-session-2" })
    await r2.json()

    expect(capturedQueryParams.options.resume).toBe(MOCK_SDK_SESSION)
    const prompt = capturedQueryParams.prompt
    expect(typeof prompt).toBe("string")
    // Leading assistant skipped, non-leading preserved in <conversation_history>
    expect(prompt).not.toContain("SDK response")
    expect(prompt).toContain('<turn role="assistant">')
    expect(prompt).toContain("GPT says hi")
    expect(prompt).toContain("<conversation_history>")
    expect(prompt).toContain('<turn role="user">')
    expect(prompt).toContain("Switched to GPT")
    expect(prompt).toContain("Back to Claude")
  })

  it("should preserve multiple external assistant messages", async () => {
    const app = createTestApp()

    const r1 = await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      stream: false,
      messages: [{ role: "user", content: "Hello" }],
    }, { "x-opencode-session": "cp-session-3" })
    await r1.json()

    mockMessages = [
      assistantMessage([{ type: "text", text: "Welcome back!" }]),
    ]

    const r2 = await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      stream: false,
      messages: [
        { role: "user", content: "Hello" },
        { role: "assistant", content: [{ type: "text", text: "SDK response" }] },
        { role: "user", content: "Q1 for GPT" },
        { role: "assistant", content: [{ type: "text", text: "GPT answer 1" }] },
        { role: "user", content: "Q2 for Gemini" },
        { role: "assistant", content: [{ type: "text", text: "Gemini answer 2" }] },
        { role: "user", content: "Back to Claude now" },
      ],
    }, { "x-opencode-session": "cp-session-3" })
    await r2.json()

    const prompt = capturedQueryParams.prompt
    expect(typeof prompt).toBe("string")
    expect(prompt).not.toContain("SDK response")
    expect(prompt).toContain("GPT answer 1")
    expect(prompt).toContain("Gemini answer 2")
    expect(prompt).toContain("Q1 for GPT")
    expect(prompt).toContain("Q2 for Gemini")
    expect(prompt).toContain("Back to Claude now")
  })

  it("should handle delta starting with user message (no SDK assistant echoed)", async () => {
    const app = createTestApp()

    const r1 = await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      stream: false,
      messages: [{ role: "user", content: "Hello" }],
    }, { "x-opencode-session": "cp-session-4" })
    await r1.json()

    mockMessages = [
      assistantMessage([{ type: "text", text: "Got it!" }]),
    ]

    // Delta starts with user (no assistant echoed back)
    const r2 = await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      stream: false,
      messages: [
        { role: "user", content: "Hello" },
        { role: "assistant", content: [{ type: "text", text: "SDK response" }] },
        { role: "user", content: "More context" },
      ],
    }, { "x-opencode-session": "cp-session-4" })
    await r2.json()

    expect(capturedQueryParams.options.resume).toBe(MOCK_SDK_SESSION)
    const prompt = capturedQueryParams.prompt
    expect(typeof prompt).toBe("string")
    expect(prompt).toContain("More context")
  })

  it("should skip leading assistant in legacy session (no stored hash)", async () => {
    const app = createTestApp()

    // Manually store a legacy session
    const { storeSession } = await import("../proxy/session/cache")
    storeSession(
      "cp-legacy",
      [{ role: "user", content: "Hello" }],
      MOCK_SDK_SESSION,
      undefined,
      [null],
    )

    mockMessages = [
      assistantMessage([{ type: "text", text: "Resumed!" }]),
    ]

    const r = await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      stream: false,
      messages: [
        { role: "user", content: "Hello" },
        { role: "assistant", content: [{ type: "text", text: "Some assistant response" }] },
        { role: "user", content: "Follow up" },
      ],
    }, { "x-opencode-session": "cp-legacy" })
    await r.json()

    const prompt = capturedQueryParams.prompt
    expect(typeof prompt).toBe("string")
    // Leading assistant skipped even for legacy sessions
    expect(prompt).not.toContain("Some assistant response")
    expect(prompt).toContain("Follow up")
  })
})
