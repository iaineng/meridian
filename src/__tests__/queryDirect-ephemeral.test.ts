/**
 * Integration tests for the query-direct lone-user path under
 * MERIDIAN_EPHEMERAL_JSONL=1.
 *
 * The path bypasses prepareFreshSession (no JSONL on disk) and feeds the
 * user message(s) directly to SDK query() as an AsyncIterable. The
 * load-bearing test in this file is the byte-alignment round-trip:
 * R1 (query-direct) wire bytes for u1 must equal R2 (rebuilt JSONL) row
 * bytes for u1.
 */
import { describe, it, expect, mock, beforeEach, afterAll, beforeAll } from "bun:test"
import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

const TMP_ROOT = path.join(os.tmpdir(), `meridian-querydirect-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
const ORIGINAL_CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR
const ORIGINAL_EPHEMERAL = process.env.MERIDIAN_EPHEMERAL_JSONL

beforeAll(async () => {
  process.env.CLAUDE_CONFIG_DIR = TMP_ROOT
  await fs.mkdir(TMP_ROOT, { recursive: true })
})

afterAll(async () => {
  if (ORIGINAL_CLAUDE_CONFIG_DIR === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = ORIGINAL_CLAUDE_CONFIG_DIR
  if (ORIGINAL_EPHEMERAL === undefined) delete process.env.MERIDIAN_EPHEMERAL_JSONL
  else process.env.MERIDIAN_EPHEMERAL_JSONL = ORIGINAL_EPHEMERAL
  try { await fs.rm(TMP_ROOT, { recursive: true, force: true }) } catch {}
})

let capturedQueryParams: any = null
// Capture each request's prompt (drained from the AsyncIterable) for later
// byte-alignment assertions.
let capturedPromptMessages: any[] = []

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: (params: any) => {
    capturedQueryParams = params
    return (async function* () {
      // Drain the prompt iterable up-front so the test can inspect what
      // the proxy sent. Strings pass through untouched.
      capturedPromptMessages = []
      const p = params?.prompt
      if (p && typeof p[Symbol.asyncIterator] === "function") {
        for await (const m of p) capturedPromptMessages.push(m)
      } else if (typeof p === "string") {
        capturedPromptMessages.push({ kind: "string", value: p })
      }
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

const { createProxyServer } = await import("../proxy/server")
const { sanitizeCwdForProjectDir, buildJsonlLines, stripCacheControlDeep } = await import("../proxy/session/transcript")
const { ephemeralSessionIdPool } = await import("../proxy/session/ephemeralPool")

const SERVER_SANDBOX_DIR = path.join(os.tmpdir(), "meridian-sandbox")

function jsonlPath(uuid: string): string {
  return path.join(
    TMP_ROOT,
    "projects",
    sanitizeCwdForProjectDir(SERVER_SANDBOX_DIR),
    `${uuid}.jsonl`,
  )
}

async function fileExists(filePath: string): Promise<boolean> {
  try { await fs.stat(filePath); return true } catch { return false }
}

function createTestApp() {
  const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })
  return app
}

async function post(app: any, body: any, headers: Record<string, string> = {}) {
  const req = new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  })
  return app.fetch(req)
}

describe("Query-direct lone-user (ephemeral mode)", () => {
  beforeEach(() => {
    capturedQueryParams = null
    capturedPromptMessages = []
    ephemeralSessionIdPool._reset()
    ephemeralSessionIdPool._setReuseDelay(0)
    process.env.MERIDIAN_EPHEMERAL_JSONL = "1"
  })

  it("strict lone-user [u1] → no JSONL, no resume, AsyncIterable with 1 entry", async () => {
    const app = createTestApp()
    const res = await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      stream: false,
      messages: [{ role: "user", content: "hello" }],
    })
    expect(res.status).toBe(200)

    expect(capturedQueryParams?.options?.resume).toBeUndefined()
    expect(capturedPromptMessages.length).toBe(1)
    const m = capturedPromptMessages[0]
    expect(m.type).toBe("user")
    expect(m.parent_tool_use_id).toBe(null)
    expect(Array.isArray(m.message.content)).toBe(true)
    // Meridian sets no cache_control here. The SDK's addCacheBreakpoints
    // pass overwrites the trailing message's last block with its own value
    // anyway, so any meridian-set cc would be wasted work.
    for (const block of m.message.content) {
      expect(block?.cache_control).toBeUndefined()
    }

    // No JSONL file should land in the sandbox project dir at any UUID we
    // could have allocated (single-test scope: the only acquired UUID is
    // released by the cleanup, so just spot-check the project dir is empty
    // or contains only unrelated entries).
    const projDir = path.join(TMP_ROOT, "projects", sanitizeCwdForProjectDir(SERVER_SANDBOX_DIR))
    const exists = await fileExists(projDir)
    if (exists) {
      const entries = await fs.readdir(projDir)
      expect(entries.length).toBe(0)
    }
  })

  it("[u1, u2] (trailing user, no anchoring assistant) → AsyncIterable with 2 entries", async () => {
    const app = createTestApp()
    const res = await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      stream: false,
      messages: [
        { role: "user", content: "first" },
        { role: "user", content: "second" },
      ],
    })
    expect(res.status).toBe(200)
    expect(capturedQueryParams?.options?.resume).toBeUndefined()
    expect(capturedPromptMessages.length).toBe(2)
    // No meridian-set cache_control on either entry — SDK auto-anchors
    // the trailing message via addCacheBreakpoints.
    for (const m of capturedPromptMessages) {
      for (const block of m.message.content) {
        expect(block?.cache_control).toBeUndefined()
      }
    }
  })

  it("lone-user with cache_control on the only block → still query-direct, cc stripped (SDK will re-anchor)", async () => {
    const app = createTestApp()
    const res = await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      stream: false,
      messages: [{
        role: "user",
        content: [{ type: "text", text: "with cc", cache_control: { type: "ephemeral" } }],
      }],
    })
    expect(res.status).toBe(200)
    expect(capturedQueryParams?.options?.resume).toBeUndefined()
    // Client cc is stripped on the way through; SDK adds its own anchor.
    const block = capturedPromptMessages[0].message.content[0]
    expect(block.cache_control).toBeUndefined()
  })

  it("multimodal lone-user → still query-direct, image block passes through unchanged", async () => {
    const app = createTestApp()
    const imageData = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="
    const res = await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      stream: false,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "look at this:" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: imageData } },
        ],
      }],
    })
    expect(res.status).toBe(200)
    expect(capturedQueryParams?.options?.resume).toBeUndefined()
    expect(capturedPromptMessages.length).toBe(1)
    const blocks = capturedPromptMessages[0].message.content
    expect(blocks.length).toBe(2)
    expect(blocks[0]?.type).toBe("text")
    expect(blocks[1]?.type).toBe("image")
    expect(blocks[1]?.source?.media_type).toBe("image/png")
    expect(blocks[1]?.source?.data).toBe(imageData)
    // No meridian-set cache_control on any block.
    for (const b of blocks) expect(b?.cache_control).toBeUndefined()
  })

  it("[u1{cc}, u2] (cache_control not on last) → falls through to prepareFreshSession, resume is set", async () => {
    const app = createTestApp()
    const res = await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      stream: false,
      messages: [
        { role: "user", content: [{ type: "text", text: "anchor", cache_control: { type: "ephemeral" } }] },
        { role: "user", content: "trailing" },
      ],
    })
    expect(res.status).toBe(200)
    // Existing path: SDK gets a resume id and a JSONL was written.
    expect(typeof capturedQueryParams?.options?.resume).toBe("string")
  })

  it("byte alignment (cc-stripped): R1 wire content equals R2 JSONL u1 row content", async () => {
    // R1: lone-user [u1] via query-direct.
    const app = createTestApp()
    const r1 = await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      stream: false,
      messages: [{ role: "user", content: "shared user content" }],
    })
    expect(r1.status).toBe(200)
    expect(capturedQueryParams?.options?.resume).toBeUndefined()
    const r1UserContent = capturedPromptMessages[0].message.content

    // Now simulate R2: client returns [u1, a1, u2]. Here we directly invoke
    // buildJsonlLines (the function meridian uses on R2 inside
    // prepareFreshSession) and inspect the u1 row content.
    const r2Messages = [
      { role: "user", content: "shared user content" },
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
      { role: "user", content: "follow up" },
    ]
    const { lines } = buildJsonlLines(
      r2Messages,
      "00000000-0000-4000-8000-000000000000",
      SERVER_SANDBOX_DIR,
    )
    let r2u1Content: any = null
    for (let i = 1; i < lines.length; i++) {
      const row = JSON.parse(lines[i]!)
      if (row?.type === "user") { r2u1Content = row.message?.content; break }
    }
    expect(r2u1Content).not.toBeNull()
    // Strip cache_control on both sides: R1 has none (SDK auto-anchors);
    // R2's u1 row carries meridian's history anchor. The non-cc content
    // bytes must match for prompt cache to hit (the cc value match is a
    // separate property of the user's querySource — see ARCHITECTURE.md
    // "Query-Direct Lone-User Path").
    expect(JSON.stringify(stripCacheControlDeep(r1UserContent)))
      .toBe(JSON.stringify(stripCacheControlDeep(r2u1Content)))
  })
})
