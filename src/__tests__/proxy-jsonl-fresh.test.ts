/**
 * Integration tests for the JSONL-backed fresh session path.
 *
 * For diverged (new) sessions we write history to a JSONL transcript under
 * ~/.claude/projects/<sanitized-cwd>/<uuid>.jsonl and call the SDK with
 * `resume: <uuid>` + only the last user message as the prompt — instead of
 * flattening the full history into a single XML-tagged text prompt.
 *
 * These tests mock the SDK and point `CLAUDE_CONFIG_DIR` at a tmp directory
 * so the actual JSONL file is written to disk and can be inspected.
 */

import { describe, it, expect, mock, beforeEach, afterAll, beforeAll } from "bun:test"
import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

// --- Tmp CLAUDE_CONFIG_DIR so jsonl writes don't pollute the real ~/.claude ---
const TMP_ROOT = path.join(os.tmpdir(), `meridian-jsonl-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
const ORIGINAL_CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR
const ORIGINAL_JSONL_FLAG = process.env.MERIDIAN_USE_JSONL_SESSIONS

beforeAll(async () => {
  process.env.CLAUDE_CONFIG_DIR = TMP_ROOT
  delete process.env.MERIDIAN_USE_JSONL_SESSIONS
  await fs.mkdir(TMP_ROOT, { recursive: true })
})

afterAll(async () => {
  if (ORIGINAL_CLAUDE_CONFIG_DIR === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = ORIGINAL_CLAUDE_CONFIG_DIR
  if (ORIGINAL_JSONL_FLAG === undefined) delete process.env.MERIDIAN_USE_JSONL_SESSIONS
  else process.env.MERIDIAN_USE_JSONL_SESSIONS = ORIGINAL_JSONL_FLAG
  try { await fs.rm(TMP_ROOT, { recursive: true, force: true }) } catch {}
})

// --- SDK mock: capture query() params and yield a minimal assistant response ---
let capturedQueryParams: any = null

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: (params: any) => {
    capturedQueryParams = params
    return (async function* () {
      yield {
        type: "assistant",
        message: {
          id: "msg_mock",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "ok" }],
          model: "claude-sonnet-4-5",
          stop_reason: "end_turn",
          usage: { input_tokens: 10, output_tokens: 5 },
        },
        session_id: "sdk-mock-session",
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
const { sanitizeCwdForProjectDir } = await import("../proxy/session/transcript")

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

function resumedUuid(): string | undefined {
  const r = capturedQueryParams?.options?.resume
  return typeof r === "string" ? r : undefined
}

/** Drain the structured-prompt AsyncIterable into a plain text concatenation
 *  for substring assertions. Returns the original string if prompt is a string. */
async function promptToText(prompt: any): Promise<string> {
  if (typeof prompt === "string") return prompt
  const out: string[] = []
  for await (const m of prompt) {
    const content = m?.message?.content
    if (Array.isArray(content)) {
      for (const b of content) {
        if (b?.type === "text" && typeof b.text === "string") out.push(b.text)
      }
    } else if (typeof content === "string") {
      out.push(content)
    }
  }
  return out.join("\n")
}

// The proxy's default workingDirectory is tmpdir()/meridian-sandbox (see server.ts
// SANDBOX_DIR). The JSONL transcript is written under <CLAUDE_CONFIG_DIR>/projects/
// <sanitized-sandbox-dir>/<uuid>.jsonl.
const SERVER_SANDBOX_DIR = path.join(os.tmpdir(), "meridian-sandbox")

async function readJsonlLines(uuid: string): Promise<Array<Record<string, any>>> {
  const file = path.join(
    TMP_ROOT,
    "projects",
    sanitizeCwdForProjectDir(SERVER_SANDBOX_DIR),
    `${uuid}.jsonl`,
  )
  const body = await fs.readFile(file, "utf8")
  return body
    .split("\n")
    .filter(line => line.length > 0)
    .map(line => JSON.parse(line))
}

describe("JSONL-backed fresh session", () => {
  beforeEach(() => {
    capturedQueryParams = null
    clearSessionCache()
  })

  it("writes a jsonl transcript and sends only the last user message as prompt", async () => {
    const app = createTestApp()
    await (await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      stream: false,
      messages: [
        { role: "user", content: "first turn" },
        { role: "assistant", content: [{ type: "text", text: "response A" }] },
        { role: "user", content: "second turn" },
      ],
    })).json()

    const uuid = resumedUuid()
    expect(uuid).toBeDefined()
    // jsonl-fresh now passes a structured user message (AsyncIterable) so the
    // SDK CLI appends tool_result/text blocks verbatim instead of the proxy
    // flattening them to <function_results> XML.
    expect(typeof capturedQueryParams.prompt).not.toBe("string")
    const promptText = await promptToText(capturedQueryParams.prompt)
    expect(promptText).not.toContain("first turn")
    expect(promptText).not.toContain("response A")
    // Prompt is crEncoded (matching the JSONL history encoding) so prompt cache
    // stays stable across turns.
    expect(promptText).toContain("second\r turn")

    const lines = await readJsonlLines(uuid!)
    // Sentinel permission-mode + 2 history messages (user + assistant)
    expect(lines).toHaveLength(3)
    expect(lines[0]!.type).toBe("permission-mode")
    expect(lines[0]!.sessionId).toBe(uuid)

    // Message chain: first user, then assistant
    const userLine = lines[1]!
    const assistantLine = lines[2]!
    expect(userLine.type).toBe("user")
    expect(userLine.parentUuid).toBeNull()
    expect(userLine.isSidechain).toBe(false)
    // crEncode + array-wrap: string content becomes [{type:"text", text}].
    // Fallback breakpoint lands on the last user row in JSONL (here: the only user row).
    expect(userLine.message.content).toEqual([
      { type: "text", text: "first\r turn", cache_control: { type: "ephemeral", ttl: "1h" } },
    ])

    expect(assistantLine.type).toBe("assistant")
    expect(assistantLine.parentUuid).toBe(userLine.uuid)
    expect(assistantLine.isSidechain).toBe(false)
    expect(assistantLine.message.role).toBe("assistant")
    expect(assistantLine.message.content).toEqual([{ type: "text", text: "response A" }])
  })

  it("does not write a transcript for a single-message request", async () => {
    const app = createTestApp()
    await (await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      stream: false,
      messages: [{ role: "user", content: "one-shot" }],
    })).json()

    // Single message: no jsonl path activated → no resume
    expect(capturedQueryParams.options.resume).toBeUndefined()
    expect(typeof capturedQueryParams.prompt).toBe("string")
  })

  it("preserves tool_use and tool_result structure in the jsonl", async () => {
    const app = createTestApp()
    await (await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      stream: false,
      messages: [
        { role: "user", content: "read the file" },
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "a.ts" } },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_1", content: "console.log('hi')" },
          ],
        },
      ],
    })).json()

    const uuid = resumedUuid()
    expect(uuid).toBeDefined()

    const lines = await readJsonlLines(uuid!)
    // Balanced slicing: trailing assistant has unresolved tool_use, so the
    // last user (tool_result) is written into the JSONL to keep the pair
    // intact. A minimal synthetic assistant ("...") is appended so the
    // transcript ends on an assistant turn. Prompt is the "Continue."
    // sentinel that opens a clean new user turn on top.
    // permission-mode + user + assistant(tool_use) + user(tool_result)
    //   + assistant(synthetic)
    expect(lines).toHaveLength(5)
    const toolUseLine = lines[2]!
    expect(toolUseLine.type).toBe("assistant")
    expect(toolUseLine.message.content).toEqual([
      { type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "a.ts" } },
    ])
    const toolResultLine = lines[3]!
    expect(toolResultLine.type).toBe("user")
    expect(toolResultLine.message.content[0].type).toBe("tool_result")
    expect(toolResultLine.message.content[0].tool_use_id).toBe("toolu_1")
    expect(toolResultLine.message.content[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" })
    const syntheticAssistantLine = lines[4]!
    expect(syntheticAssistantLine.type).toBe("assistant")
    expect(syntheticAssistantLine.message.content).toEqual([
      { type: "text", text: "..." },
    ])
    // Tool-result payload is crEncoded (matches user content encoding).
    const promptText = await promptToText(capturedQueryParams.prompt)
    expect(promptText).toBe("<runtime-directive>Respond based on the tool result above.</runtime-directive>")
  })

  it("wraps a trailing assistant history with the prefill directive as prompt", async () => {
    const app = createTestApp()
    await (await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      stream: false,
      messages: [
        { role: "user", content: "start" },
        { role: "assistant", content: [{ type: "text", text: "hello" }] },
      ],
    })).json()

    const uuid = resumedUuid()
    expect(uuid).toBeDefined()
    // Last message is assistant → prefill path: prompt instructs the model to
    // resume from the exact character after the previous assistant turn.
    expect(typeof capturedQueryParams.prompt).not.toBe("string")
    const promptText = await promptToText(capturedQueryParams.prompt)
    expect(promptText).toContain("Resume output starting at the exact character")

    const lines = await readJsonlLines(uuid!)
    // permission-mode + user + assistant (all N written since trailing is assistant)
    expect(lines).toHaveLength(3)
    expect(lines[2]!.type).toBe("assistant")
  })

  it("mirrors a client user cache_control onto the corresponding JSONL user row", async () => {
    const app = createTestApp()
    await (await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      stream: false,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "hello", cache_control: { type: "ephemeral", ttl: "5m" } },
          ],
        },
        { role: "assistant", content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }] },
        { role: "user", content: "go" },
      ],
    })).json()

    const uuid = resumedUuid()
    expect(uuid).toBeDefined()

    const lines = await readJsonlLines(uuid!)
    // User breakpoint borrows the client position; value normalized to our 1h ephemeral.
    expect(lines[1]!.message.content[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" })
    // Assistant row no longer receives a fallback breakpoint.
    expect(lines[2]!.message.content[0].cache_control).toBeUndefined()
  })

  it("honors MERIDIAN_USE_JSONL_SESSIONS=0 (disables jsonl path)", async () => {
    process.env.MERIDIAN_USE_JSONL_SESSIONS = "0"
    try {
      const app = createTestApp()
      await (await post(app, {
        model: "claude-sonnet-4-5",
        max_tokens: 1024,
        stream: false,
        messages: [
          { role: "user", content: "first" },
          { role: "assistant", content: [{ type: "text", text: "reply" }] },
          { role: "user", content: "second" },
        ],
      })).json()

      // Flag off → no resume UUID, prompt contains flattened history
      expect(capturedQueryParams.options.resume).toBeUndefined()
      expect(typeof capturedQueryParams.prompt).toBe("string")
      expect(capturedQueryParams.prompt).toContain("first")
      expect(capturedQueryParams.prompt).toContain("second")
    } finally {
      delete process.env.MERIDIAN_USE_JSONL_SESSIONS
    }
  })

  it("preserves multimodal image blocks structurally in the jsonl", async () => {
    const app = createTestApp()
    await (await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      stream: false,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "look" },
            { type: "image", source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" } },
          ],
        },
        { role: "assistant", content: [{ type: "text", text: "I see" }] },
        { role: "user", content: "what is it?" },
      ],
    })).json()

    const uuid = resumedUuid()
    expect(uuid).toBeDefined()

    const lines = await readJsonlLines(uuid!)
    const firstUserContent = lines[1]!.message.content
    expect(Array.isArray(firstUserContent)).toBe(true)
    const imageBlock = (firstUserContent as Array<Record<string, unknown>>).find(
      (b) => b.type === "image",
    )
    expect(imageBlock).toBeDefined()
    const source = imageBlock!.source as { media_type: string; data: string }
    expect(source.media_type).toBe("image/png")
    expect(source.data).toBe("aGVsbG8=")
  })

  it("prefixes tool_use.name with mcp__tools__ in passthrough mode JSONL", async () => {
    const originalPassthrough = process.env.MERIDIAN_PASSTHROUGH
    process.env.MERIDIAN_PASSTHROUGH = "1"
    try {
      const app = createTestApp()
      await (await post(app, {
        model: "claude-sonnet-4-5",
        max_tokens: 1024,
        stream: false,
        messages: [
          { role: "user", content: "read a.ts" },
          {
            role: "assistant",
            content: [
              { type: "tool_use", id: "toolu_1", name: "Read", input: { path: "a.ts" } },
            ],
          },
          {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "file body" }],
          },
        ],
      })).json()

      const uuid = resumedUuid()
      expect(uuid).toBeDefined()

      const lines = await readJsonlLines(uuid!)
      // Balanced slicing includes the trailing tool_result user, plus a
      // synthetic assistant text appended so the transcript ends on an
      // assistant turn.
      // permission-mode + user + assistant(tool_use) + user(tool_result)
      //   + assistant(synthetic)
      expect(lines).toHaveLength(5)
      const toolUseLine = lines[2]!
      expect(toolUseLine.type).toBe("assistant")
      expect(toolUseLine.message.content[0].type).toBe("tool_use")
      expect(toolUseLine.message.content[0].name).toBe("mcp__tools__Read")
      expect(toolUseLine.message.content[0].id).toBe("toolu_1")
      const syntheticAssistantLine = lines[4]!
      expect(syntheticAssistantLine.type).toBe("assistant")
      expect(syntheticAssistantLine.message.content).toEqual([
        { type: "text", text: "..." },
      ])
    } finally {
      if (originalPassthrough === undefined) delete process.env.MERIDIAN_PASSTHROUGH
      else process.env.MERIDIAN_PASSTHROUGH = originalPassthrough
    }
  })

  it("uses JSONL even when passthrough mode is enabled", async () => {
    const originalPassthrough = process.env.MERIDIAN_PASSTHROUGH
    process.env.MERIDIAN_PASSTHROUGH = "1"
    try {
      const app = createTestApp()
      await (await post(app, {
        model: "claude-sonnet-4-5",
        max_tokens: 1024,
        stream: false,
        messages: [
          { role: "user", content: "first" },
          { role: "assistant", content: [{ type: "text", text: "reply" }] },
          { role: "user", content: "second" },
        ],
      })).json()

      const uuid = resumedUuid()
      expect(uuid).toBeDefined()
      expect(typeof capturedQueryParams.prompt).not.toBe("string")
      const promptText = await promptToText(capturedQueryParams.prompt)
      expect(promptText).not.toContain("first")
      expect(promptText).not.toContain("reply")
      expect(promptText).toContain("second")

      const lines = await readJsonlLines(uuid!)
      expect(lines).toHaveLength(3)
      expect(lines[0]!.type).toBe("permission-mode")
      expect(lines[1]!.type).toBe("user")
      expect(lines[2]!.type).toBe("assistant")
    } finally {
      if (originalPassthrough === undefined) delete process.env.MERIDIAN_PASSTHROUGH
      else process.env.MERIDIAN_PASSTHROUGH = originalPassthrough
    }
  })

  it("preserves thinking blocks with signature in jsonl", async () => {
    const app = createTestApp()
    const thinkingBlock = {
      type: "thinking",
      thinking: "Reasoning step 1...",
      signature: "EswCClkIDBgC_test_signature",
    }
    await (await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      stream: false,
      messages: [
        { role: "user", content: "hard question" },
        { role: "assistant", content: [thinkingBlock, { type: "text", text: "answer" }] },
        { role: "user", content: "follow-up" },
      ],
    })).json()

    const uuid = resumedUuid()
    expect(uuid).toBeDefined()

    const lines = await readJsonlLines(uuid!)
    // permission-mode + user + assistant
    expect(lines).toHaveLength(3)
    const assistantLine = lines[2]!
    expect(assistantLine.type).toBe("assistant")
    expect(assistantLine.message.content).toEqual([
      thinkingBlock,
      { type: "text", text: "answer" },
    ])
    const firstBlock = assistantLine.message.content[0] as Record<string, unknown>
    expect(firstBlock.type).toBe("thinking")
    expect(firstBlock.signature).toBe(thinkingBlock.signature)
  })

  it("sets parentUuid chain correctly with isSidechain=false", async () => {
    const app = createTestApp()
    await (await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      stream: false,
      messages: [
        { role: "user", content: "m1" },
        { role: "assistant", content: [{ type: "text", text: "a1" }] },
        { role: "user", content: "m2" },
        { role: "assistant", content: [{ type: "text", text: "a2" }] },
        { role: "user", content: "m3" },
      ],
    })).json()

    const uuid = resumedUuid()
    expect(uuid).toBeDefined()

    const lines = await readJsonlLines(uuid!)
    // permission-mode + 4 history messages (last user is the prompt, not written)
    expect(lines).toHaveLength(5)
    const msgLines = lines.slice(1)
    for (const line of msgLines) {
      expect(line.isSidechain).toBe(false)
      expect(line.sessionId).toBe(uuid)
    }
    const [m0, m1, m2, m3] = msgLines
    expect(m0!.parentUuid).toBeNull()
    expect(m1!.parentUuid).toBe(m0!.uuid)
    expect(m2!.parentUuid).toBe(m1!.uuid)
    expect(m3!.parentUuid).toBe(m2!.uuid)
  })
})
