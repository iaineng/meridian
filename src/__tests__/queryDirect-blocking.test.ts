/**
 * Unit tests for blocking-MCP handler's query-direct branch.
 *
 * Asserts the dispatch behavior when a lone-user-shaped initial request
 * enters `buildBlockingHandler`: the handler returns `isQueryDirect: true`
 * with byte-aligned `directPromptMessages`, and the blocking pool state is
 * acquired without writing a JSONL. The non-query-direct shapes still flow
 * through `prepareFreshSession` (asserted via `useJsonlFresh: true`).
 */
import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test"
import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  createSdkMcpServer: (opts: any) => ({ type: "sdk", name: opts.name, instance: {}, tools: opts.tools ?? [] }),
  tool: (name: string, description: string, shape: any, handler: Function, extras?: any) => ({ name, description, shape, handler, extras }),
  query: () => ({ [Symbol.asyncIterator]: () => ({ next: async () => ({ value: undefined, done: true }) }) }),
}))

const { buildBlockingHandler } = await import("../proxy/handlers/blocking")
const { blockingPool } = await import("../proxy/session/blockingPool")
const { ephemeralSessionIdPool } = await import("../proxy/session/ephemeralPool")
const { sanitizeCwdForProjectDir } = await import("../proxy/session/transcript")

const TMP_ROOT = path.join(os.tmpdir(), `meridian-qd-blocking-${Date.now()}-${Math.random().toString(36).slice(2)}`)
const WORK_DIR = path.join(TMP_ROOT, "work")
const ORIGINAL_CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR

function projectDir(): string {
  return path.join(TMP_ROOT, "projects", sanitizeCwdForProjectDir(WORK_DIR))
}

async function dirEntries(): Promise<string[]> {
  try { return await fs.readdir(projectDir()) } catch { return [] }
}

function makeShared(messages: any[], overrides: Partial<any> = {}) {
  return {
    requestMeta: {
      requestId: "req-qd-blocking-unit",
      endpoint: "/v1/messages",
      queueEnteredAt: 1_000,
      queueStartedAt: 1_000,
    },
    adapter: { name: "opencode" },
    body: { model: "claude-sonnet-4-5", messages, tools: [{ name: "Read", description: "", input_schema: {} }] },
    model: "claude-sonnet-4-5",
    allMessages: messages,
    workingDirectory: WORK_DIR,
    initialPassthrough: true,
    outputFormat: undefined,
    stream: false,
    profile: { type: "oauth", env: {} },
    agentSessionId: undefined,
    ...overrides,
  } as any
}

describe("buildBlockingHandler — query-direct branch", () => {
  beforeEach(async () => {
    process.env.CLAUDE_CONFIG_DIR = TMP_ROOT
    await fs.mkdir(TMP_ROOT, { recursive: true })
    await blockingPool._reset()
    ephemeralSessionIdPool._reset()
    ephemeralSessionIdPool._setReuseDelay(0)
  })

  afterEach(async () => {
    await blockingPool._reset()
    try { await fs.rm(TMP_ROOT, { recursive: true, force: true }) } catch {}
    if (ORIGINAL_CLAUDE_CONFIG_DIR === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = ORIGINAL_CLAUDE_CONFIG_DIR
  })

  it("lone-user [u1] → isQueryDirect, no JSONL on disk, blocking state acquired", async () => {
    const shared = makeShared([{ role: "user", content: "go" }])
    const handler = await buildBlockingHandler(shared)

    expect(handler.isQueryDirect).toBe(true)
    expect(handler.useJsonlFresh).toBe(false)
    expect(handler.freshSessionId).toBeUndefined()
    expect(handler.resumeSessionId).toBeUndefined()
    expect(handler.directPromptMessages?.length).toBe(1)
    expect(handler.blockingMode).toBe(true)
    expect(handler.isBlockingContinuation).toBe(false)
    expect(handler.blockingState).toBeDefined()
    expect(handler.prebuiltPassthroughMcp).toBeDefined()

    // No meridian-set cache_control: SDK's addCacheBreakpoints will anchor
    // the trailing message via getCacheControl({querySource}) and any cc we
    // set would be unconditionally overwritten anyway.
    const m = handler.directPromptMessages![0]!
    for (const block of m.message.content) {
      expect(block?.cache_control).toBeUndefined()
    }

    // No JSONL files were written for this request.
    expect(await dirEntries()).toEqual([])
  })

  it("[u1, u2] → 2 query-direct entries, no meridian-set cache_control", async () => {
    const shared = makeShared([
      { role: "user", content: "first" },
      { role: "user", content: "second" },
    ])
    const handler = await buildBlockingHandler(shared)

    expect(handler.isQueryDirect).toBe(true)
    expect(handler.useJsonlFresh).toBe(false)
    expect(handler.directPromptMessages?.length).toBe(2)

    for (const m of handler.directPromptMessages!) {
      for (const block of m.message.content) {
        expect(block?.cache_control).toBeUndefined()
      }
    }
    expect(await dirEntries()).toEqual([])
  })

  it("[u1, a1, u2] → NOT query-direct, useJsonlFresh true, JSONL written", async () => {
    const shared = makeShared([
      { role: "user", content: "first" },
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
      { role: "user", content: "second" },
    ])
    const handler = await buildBlockingHandler(shared)

    expect(handler.isQueryDirect).toBeUndefined()
    expect(handler.useJsonlFresh).toBe(true)
    expect(typeof handler.freshSessionId).toBe("string")

    const entries = await dirEntries()
    expect(entries.some((f) => f.endsWith(".jsonl"))).toBe(true)
  })

  it("[u1{cache_control on block 0}, u2] → falls back to JSONL path", async () => {
    const shared = makeShared([
      {
        role: "user",
        content: [{ type: "text", text: "anchor", cache_control: { type: "ephemeral" } }],
      },
      { role: "user", content: "trailing" },
    ])
    const handler = await buildBlockingHandler(shared)

    expect(handler.isQueryDirect).toBeUndefined()
    expect(handler.useJsonlFresh).toBe(true)
    expect(typeof handler.freshSessionId).toBe("string")
  })

  it("query-direct cleanup releases pool id (file deletion path NOT exercised)", async () => {
    const shared = makeShared([{ role: "user", content: "x" }])
    const handler = await buildBlockingHandler(shared)

    expect(handler.blockingState).toBeDefined()
    const beforeAvailable = ephemeralSessionIdPool.stats().available
    await blockingPool.release(handler.blockingState!, "test")
    const afterAvailable = ephemeralSessionIdPool.stats().available
    expect(afterAvailable).toBe(beforeAvailable + 1)
    // No JSONL was created → no file to delete (and no ENOENT is thrown).
    expect(await dirEntries()).toEqual([])
  })
})
