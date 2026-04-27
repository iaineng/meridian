/**
 * Integration tests for the ephemeral one-shot JSONL mode.
 *
 * When MERIDIAN_EPHEMERAL_JSONL is set, every /v1/messages request:
 *   1. Acquires a UUID from the ephemeral pool.
 *   2. Writes a fresh JSONL transcript at that UUID.
 *   3. Calls the SDK with resume: <uuid> + last user message as prompt.
 *   4. Deletes the transcript (or renames to .bak) after the response finishes.
 *   5. Releases the UUID back into the pool.
 *
 * The session cache / lineage / recovery paths are completely bypassed.
 */
import { describe, it, expect, mock, beforeEach, afterAll, beforeAll } from "bun:test"
import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

const TMP_ROOT = path.join(os.tmpdir(), `meridian-ephemeral-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
const ORIGINAL_CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR
const ORIGINAL_EPHEMERAL = process.env.MERIDIAN_EPHEMERAL_JSONL
const ORIGINAL_EPHEMERAL_BACKUP = process.env.MERIDIAN_EPHEMERAL_JSONL_BACKUP

beforeAll(async () => {
  process.env.CLAUDE_CONFIG_DIR = TMP_ROOT
  await fs.mkdir(TMP_ROOT, { recursive: true })
})

afterAll(async () => {
  if (ORIGINAL_CLAUDE_CONFIG_DIR === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = ORIGINAL_CLAUDE_CONFIG_DIR
  if (ORIGINAL_EPHEMERAL === undefined) delete process.env.MERIDIAN_EPHEMERAL_JSONL
  else process.env.MERIDIAN_EPHEMERAL_JSONL = ORIGINAL_EPHEMERAL
  if (ORIGINAL_EPHEMERAL_BACKUP === undefined) delete process.env.MERIDIAN_EPHEMERAL_JSONL_BACKUP
  else process.env.MERIDIAN_EPHEMERAL_JSONL_BACKUP = ORIGINAL_EPHEMERAL_BACKUP
  try { await fs.rm(TMP_ROOT, { recursive: true, force: true }) } catch {}
})

// Capture SDK query params across every call (latest only).
let capturedQueryParams: any = null

// Track path of JSONL at SDK-call time so we can assert "file existed then got
// removed". Must snapshot inside the generator BEFORE the proxy's finally runs.
let jsonlExistedDuringQuery = false
let jsonlPathDuringQuery: string | null = null

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: (params: any) => {
    capturedQueryParams = params
    return (async function* () {
      // Best-effort: snapshot whether the JSONL exists at this moment.
      const resume = typeof params?.options?.resume === "string" ? params.options.resume : null
      if (resume) {
        const filePath = path.join(
          TMP_ROOT,
          "projects",
          sanitizeCwdForProjectDir(SERVER_SANDBOX_DIR),
          `${resume}.jsonl`,
        )
        jsonlPathDuringQuery = filePath
        try {
          await fs.stat(filePath)
          jsonlExistedDuringQuery = true
        } catch {
          jsonlExistedDuringQuery = false
        }
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
const { sanitizeCwdForProjectDir } = await import("../proxy/session/transcript")
const { ephemeralSessionIdPool } = await import("../proxy/session/ephemeralPool")
const { telemetryStore } = await import("../telemetry")

// The proxy's default workingDirectory is tmpdir()/meridian-sandbox.
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

function resumedUuid(): string | undefined {
  const r = capturedQueryParams?.options?.resume
  return typeof r === "string" ? r : undefined
}

describe("Ephemeral one-shot JSONL mode", () => {
  beforeEach(() => {
    capturedQueryParams = null
    jsonlExistedDuringQuery = false
    jsonlPathDuringQuery = null
    ephemeralSessionIdPool._reset()
    // The integration scenarios assert pool state synchronously right after
    // the request; disable the 10 s quarantine window so released ids land
    // in `available` immediately. A dedicated describe block in
    // ephemeral-pool.test.ts covers the delay behavior.
    ephemeralSessionIdPool._setReuseDelay(0)
    telemetryStore.clear()
    delete process.env.MERIDIAN_EPHEMERAL_JSONL_BACKUP
  })

  it("writes a JSONL, resumes from it, then deletes after the response", async () => {
    process.env.MERIDIAN_EPHEMERAL_JSONL = "1"
    try {
      const app = createTestApp()
      const res = await post(app, {
        model: "claude-sonnet-4-5",
        max_tokens: 1024,
        stream: false,
        messages: [
          { role: "user", content: "first" },
          { role: "assistant", content: [{ type: "text", text: "hi" }] },
          { role: "user", content: "follow-up" },
        ],
      })
      await res.json()

      const uuid = resumedUuid()
      expect(uuid).toBeDefined()

      // The JSONL existed at the moment the SDK was invoked.
      expect(jsonlExistedDuringQuery).toBe(true)

      // After response completes, file is deleted.
      expect(await fileExists(jsonlPath(uuid!))).toBe(false)

      // Pool: released UUID goes back to `available` for reuse on the next request.
      const stats = ephemeralSessionIdPool.stats()
      expect(stats.inUse).toBe(0)
      expect(stats.available).toBe(1)
    } finally {
      delete process.env.MERIDIAN_EPHEMERAL_JSONL
    }
  })

  it("single-message lone-user request goes query-direct: no JSONL, no resume, AsyncIterable prompt", async () => {
    process.env.MERIDIAN_EPHEMERAL_JSONL = "1"
    try {
      const app = createTestApp()
      await (await post(app, {
        model: "claude-sonnet-4-5",
        max_tokens: 1024,
        stream: false,
        messages: [{ role: "user", content: "one-shot request" }],
      })).json()

      // Lone-user shape now takes the query-direct path: no JSONL is written
      // and no resume id is passed to the SDK. The user message is delivered
      // as an AsyncIterable<SDKUserMessage> instead.
      expect(resumedUuid()).toBeUndefined()
      expect(jsonlExistedDuringQuery).toBe(false)
      expect(typeof capturedQueryParams.prompt).not.toBe("string")
      // Pool slot returns to available after cleanup; no file to delete.
      expect(ephemeralSessionIdPool.stats()).toEqual({ available: 1, inUse: 0, pending: 0 })
    } finally {
      delete process.env.MERIDIAN_EPHEMERAL_JSONL
    }
  })

  it("backs up the JSONL to .bak when EPHEMERAL_JSONL_BACKUP=1", async () => {
    process.env.MERIDIAN_EPHEMERAL_JSONL = "1"
    process.env.MERIDIAN_EPHEMERAL_JSONL_BACKUP = "1"
    try {
      const app = createTestApp()
      await (await post(app, {
        model: "claude-sonnet-4-5",
        max_tokens: 1024,
        stream: false,
        messages: [
          { role: "user", content: "a" },
          { role: "assistant", content: [{ type: "text", text: "b" }] },
          { role: "user", content: "c" },
        ],
      })).json()

      const uuid = resumedUuid()!
      const filePath = jsonlPath(uuid)

      // Original file is gone; a uniquely-suffixed .bak exists.
      expect(await fileExists(filePath)).toBe(false)
      const dir = path.dirname(filePath)
      const entries = await fs.readdir(dir)
      const baks = entries.filter(e => e.startsWith(`${uuid}.jsonl.`) && e.endsWith(".bak"))
      expect(baks.length).toBe(1)
    } finally {
      delete process.env.MERIDIAN_EPHEMERAL_JSONL
      delete process.env.MERIDIAN_EPHEMERAL_JSONL_BACKUP
    }
  })

  it("reuses a single pool UUID across serial requests (content-agnostic)", async () => {
    process.env.MERIDIAN_EPHEMERAL_JSONL = "1"
    try {
      const app = createTestApp()
      const uuids = new Set<string>()
      for (let i = 0; i < 3; i++) {
        capturedQueryParams = null
        await (await post(app, {
          model: "claude-sonnet-4-5",
          max_tokens: 1024,
          stream: false,
          messages: [
            { role: "user", content: `turn ${i}` },
            { role: "assistant", content: [{ type: "text", text: "ack" }] },
            { role: "user", content: `follow ${i}` },
          ],
        })).json()
        uuids.add(resumedUuid()!)
      }
      // Serial requests release then re-acquire the same pool slot, so
      // the UUID is reused. Reuse is safe because each request fully
      // overwrites the JSONL before the SDK reads it.
      expect(uuids.size).toBe(1)
      expect(ephemeralSessionIdPool.stats()).toEqual({ available: 1, inUse: 0, pending: 0 })
    } finally {
      delete process.env.MERIDIAN_EPHEMERAL_JSONL
    }
  })

  it("bypasses session cache — pool UUID is the same regardless of conversation content", async () => {
    process.env.MERIDIAN_EPHEMERAL_JSONL = "1"
    try {
      const app = createTestApp()
      capturedQueryParams = null
      await (await post(app, {
        model: "claude-sonnet-4-5",
        max_tokens: 1024,
        stream: false,
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: [{ type: "text", text: "hello" }] },
          { role: "user", content: "next" },
        ],
      }, { "x-opencode-session": "sess-abc" })).json()
      const firstResume = resumedUuid()

      capturedQueryParams = null
      await (await post(app, {
        model: "claude-sonnet-4-5",
        max_tokens: 1024,
        stream: false,
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: [{ type: "text", text: "hello" }] },
          { role: "user", content: "next" },
          { role: "assistant", content: [{ type: "text", text: "ok" }] },
          { role: "user", content: "more" },
        ],
      }, { "x-opencode-session": "sess-abc" })).json()
      const secondResume = resumedUuid()

      capturedQueryParams = null
      await (await post(app, {
        model: "claude-sonnet-4-5",
        max_tokens: 1024,
        stream: false,
        messages: [
          { role: "user", content: "bye" },
          { role: "assistant", content: [{ type: "text", text: "later" }] },
          { role: "user", content: "again" },
        ],
      }, { "x-opencode-session": "sess-abc" })).json()
      const thirdResume = resumedUuid()

      expect(firstResume).toBeDefined()
      expect(secondResume).toBeDefined()
      expect(thirdResume).toBeDefined()
      // Pool allocation is content-agnostic: serial requests release then
      // re-acquire the same slot, so all three share one UUID.
      expect(secondResume).toBe(firstResume)
      expect(thirdResume).toBe(firstResume)
    } finally {
      delete process.env.MERIDIAN_EPHEMERAL_JSONL
    }
  })

  it("records isEphemeral=true in telemetry and increments ephemeralCount", async () => {
    process.env.MERIDIAN_EPHEMERAL_JSONL = "1"
    try {
      const app = createTestApp()
      await (await post(app, {
        model: "claude-sonnet-4-5",
        max_tokens: 1024,
        stream: false,
        messages: [
          { role: "user", content: "q1" },
          { role: "assistant", content: [{ type: "text", text: "a1" }] },
          { role: "user", content: "q2" },
        ],
      })).json()

      const recent = telemetryStore.getRecent({ limit: 1 })
      expect(recent[0]?.isEphemeral).toBe(true)
      const summary = telemetryStore.summarize()
      expect(summary.ephemeralCount).toBe(1)
    } finally {
      delete process.env.MERIDIAN_EPHEMERAL_JSONL
    }
  })

  it("default (no env) keeps legacy behavior — no ephemeral pool use", async () => {
    // env unset → isEphemeral=false
    const app = createTestApp()
    await (await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      stream: false,
      messages: [{ role: "user", content: "plain request" }],
    })).json()

    expect(ephemeralSessionIdPool.stats()).toEqual({ available: 0, inUse: 0, pending: 0 })
    const recent = telemetryStore.getRecent({ limit: 1 })
    expect(recent[0]?.isEphemeral).toBe(false)
  })
})
