/**
 * Multi-sibling fork semantics for the blocking-MCP pool.
 *
 * Two branches of the same conversation can share a stringified key
 * (`l:<firstUserHash>` or `h:<agentSessionId>`) but diverge in their stored
 * `priorMessageHashes`. The pool keeps one sibling per branch and the
 * handler picks the right one at continuation time via longest strict
 * prefix overlap.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { tmpdir } from "node:os"
import { promises as fs } from "node:fs"
import path from "node:path"

import { buildBlockingHandler } from "../proxy/handlers/blocking"
import {
  blockingPool,
  type BlockingSessionKey,
  type PendingTool,
} from "../proxy/session/blockingPool"
import { computeMessageHashes } from "../proxy/session/lineage"

async function tmpDir(): Promise<string> {
  const dir = path.join(tmpdir(), `meridian-fork-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  await fs.mkdir(dir, { recursive: true })
  return dir
}

function seedState(key: BlockingSessionKey, priorMessageHashes: string[], cwd: string, tag: string) {
  return blockingPool.acquire(key, {
    key,
    ephemeralSessionId: `00000000-0000-0000-0000-0000000000${tag}`,
    workingDirectory: cwd,
    priorMessageHashes,
    cleanup: async () => {},
  })
}

function seedPending(overrides: Partial<PendingTool> & { toolUseId: string }): PendingTool {
  return {
    mcpToolName: "Read",
    clientToolName: "Read",
    input: {},
    resolve: () => {},
    reject: () => {},
    startedAt: Date.now(),
    ...overrides,
  }
}

describe("blocking pool: multi-sibling forks", () => {
  let cwd: string
  let prevClaudeConfig: string | undefined

  beforeEach(async () => {
    await blockingPool._reset()
    cwd = await tmpDir()
    prevClaudeConfig = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = await tmpDir()
  })
  afterEach(async () => {
    await blockingPool._reset()
    if (prevClaudeConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = prevClaudeConfig
  })

  function makeShared(opts: { messages: any[]; agentSessionId?: string }) {
    return {
      workingDirectory: cwd,
      allMessages: opts.messages,
      model: "claude-sonnet-4-5-20250929",
      outputFormat: undefined,
      requestMeta: { requestId: "req-fork", endpoint: "/v1/messages", queueEnteredAt: 0, queueStartedAt: 0 },
      agentSessionId: opts.agentSessionId,
      initialPassthrough: true,
      body: { tools: [{ name: "Read" }], messages: opts.messages, model: "claude-sonnet-4-5-20250929" },
    } as any
  }

  it("siblings coexist under the same key", () => {
    const key: BlockingSessionKey = { kind: "lineage", hash: "h0" }
    const sA = seedState(key, ["h0"], cwd, "a1")
    const sB = seedState(key, ["h0", "h1a", "h2a"], cwd, "b1")
    expect(sA).not.toBe(sB)
    expect(blockingPool.size()).toBe(1)
    expect(blockingPool.totalSize()).toBe(2)
  })

  it("lookup picks the longest-prefix sibling", () => {
    const key: BlockingSessionKey = { kind: "lineage", hash: "h0" }
    const sA = seedState(key, ["h0"], cwd, "a2")
    const sB = seedState(key, ["h0", "h1a", "h2a"], cwd, "b2")

    // Incoming extends sB.
    expect(blockingPool.lookup(key, ["h0", "h1a", "h2a", "h3a"])).toBe(sB)
    // Incoming diverges from sB at position 1, still prefix-matches sA.
    expect(blockingPool.lookup(key, ["h0", "h1b", "h2b"])).toBe(sA)
    // Unknown root.
    expect(blockingPool.lookup(key, ["root", "x"])).toBeUndefined()
  })

  it("release of one sibling leaves the other intact", async () => {
    const key: BlockingSessionKey = { kind: "lineage", hash: "h0" }
    const sA = seedState(key, ["h0"], cwd, "a3")
    const sB = seedState(key, ["h0", "h1a"], cwd, "b3")
    let rejectedA = false
    let rejectedB = false
    sA.pendingTools.set("tu_A", seedPending({ toolUseId: "tu_A", reject: () => { rejectedA = true } }))
    sB.pendingTools.set("tu_B", seedPending({ toolUseId: "tu_B", reject: () => { rejectedB = true } }))

    await blockingPool.release(sB, "test_cleanup")
    expect(sB.status).toBe("terminated")
    expect(rejectedB).toBe(true)
    expect(sA.status).toBe("streaming")
    expect(rejectedA).toBe(false)
    expect(sA.pendingTools.has("tu_A")).toBe(true)
    expect(blockingPool.totalSize()).toBe(1)
    expect(blockingPool.lookup(key, ["h0"])).toBe(sA)
  })

  it("append-after-tool_result initial request creates a new sibling and does not touch existing ones", async () => {
    // Seed two live siblings: sA waits for tu_A; sB waits for tu_B.
    const messagesForKey = [{ role: "user", content: "root-user" }]
    const priorA = computeMessageHashes(messagesForKey)
    const key = { kind: "lineage", hash: priorA[0]! } as const
    const sA = seedState(key, priorA, cwd, "a4")
    sA.pendingTools.set("tu_A", seedPending({ toolUseId: "tu_A" }))
    const sB = seedState(key, [...priorA, "fakeassthash"], cwd, "b4")
    sB.pendingTools.set("tu_B", seedPending({ toolUseId: "tu_B" }))
    expect(blockingPool.totalSize()).toBe(2)

    // Client appends new rounds AFTER a prior tool_result — shape is NOT
    // tool-result-only, so the handler takes the initial path. Should
    // append a third sibling without disturbing the existing two.
    const appended = [
      { role: "user", content: "root-user" },
      { role: "assistant", content: [{ type: "tool_use", id: "tu_A", name: "mcp__tools__Read", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_A", content: "ok" }] },
      { role: "assistant", content: [{ type: "text", text: "follow-up text" }] },
      { role: "user", content: "next question" },
    ]
    const result = await buildBlockingHandler(makeShared({ messages: appended }))

    expect(result.blockingMode).toBe(true)
    expect(result.isBlockingContinuation).toBe(false)
    expect(sA.status).toBe("streaming")
    expect(sB.status).toBe("streaming")
    expect(sA.pendingTools.has("tu_A")).toBe(true)
    expect(sB.pendingTools.has("tu_B")).toBe(true)
    expect(blockingPool.totalSize()).toBe(3)
  })

  it("continuation miss with no siblings promotes to a fresh blocking initial", async () => {
    // First user message hash determines the lineage key. No siblings yet.
    const messages = [
      { role: "user", content: "list files" },
      { role: "assistant", content: [{ type: "tool_use", id: "tu_A", name: "mcp__tools__Read", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_A", content: "ok" }] },
    ]
    const priorHashes = computeMessageHashes(messages.slice(0, -1))
    const allHashes = computeMessageHashes(messages)
    const key = { kind: "lineage", hash: priorHashes[0]! } as const
    expect(blockingPool.lookup(key, priorHashes)).toBeUndefined()

    const result = await buildBlockingHandler(makeShared({ messages }))

    expect(result.blockingMode).toBe(true)
    expect(result.isBlockingContinuation).toBe(false)
    expect(result.lineageType).toBe("blocking")
    expect(blockingPool.totalSize()).toBe(1)
    // New sibling stores priorMessageHashes = full allMessages (new convention),
    // so lookup must use the full hash array as the prefix candidate.
    expect(blockingPool.lookup(key, allHashes)).toBeDefined()
  })

  it("client fabricates an unrelated assistant turn → drift detected → release live + promote", async () => {
    // Server emitted Read with input {path:"x"}. Client sends a continuation
    // whose assistant turn is a totally different Bash call.
    const messages = [
      { role: "user", content: "first request" },
      { role: "assistant", content: [{ type: "tool_use", id: "tu_FAKE", name: "Bash", input: { cmd: "rm -rf /" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_FAKE", content: "DELETED" }] },
    ]
    const priorHashes = computeMessageHashes(messages.slice(0, -1))
    const key = { kind: "lineage", hash: priorHashes[0]! } as const

    // Live sibling acquired at round 1: stored priors = [hash(first request)],
    // pending tu_REAL waits, snapshot of the SDK-emitted assistant is set.
    const live = blockingPool.acquire(key, {
      key,
      ephemeralSessionId: "00000000-0000-0000-0000-000000000aaa",
      workingDirectory: cwd,
      priorMessageHashes: [priorHashes[0]!],
      cleanup: async () => {},
    })
    live.pendingTools.set("tu_REAL", {
      mcpToolName: "Read", clientToolName: "Read", toolUseId: "tu_REAL",
      input: { path: "x" }, resolve: () => {}, reject: () => {}, startedAt: Date.now(),
    })
    live.lastEmittedAssistantBlocks = [
      { type: "tool_use", name: "Read", input: { path: "x" } },
    ]

    const result = await buildBlockingHandler(makeShared({ messages }))

    // Drift caught: live sibling released; new sibling acquired in its place.
    expect(live.status).toBe("terminated")
    expect(result.blockingMode).toBe(true)
    expect(result.isBlockingContinuation).toBe(false)
    expect(result.lineageType).toBe("blocking")
    expect(blockingPool.totalSize()).toBe(1)
    // New sibling's priorMessageHashes = full allMessages (3 hashes here),
    // so use the full message hash array for lookup.
    const fresh = blockingPool.lookup(key, computeMessageHashes(messages))
    expect(fresh).toBeDefined()
    expect(fresh).not.toBe(live)
  })

  it("client preserves assistant turn faithfully (matching name + canonical input) → continuation accepted", async () => {
    const messages = [
      { role: "user", content: "look it up" },
      { role: "assistant", content: [{ type: "tool_use", id: "tu_X", name: "Read", input: { path: "/etc/hosts" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_X", content: "ok" }] },
    ]
    const priorHashes = computeMessageHashes(messages.slice(0, -1))
    const key = { kind: "lineage", hash: priorHashes[0]! } as const

    const live = blockingPool.acquire(key, {
      key,
      ephemeralSessionId: "00000000-0000-0000-0000-000000000bbb",
      workingDirectory: cwd,
      priorMessageHashes: [priorHashes[0]!],
      cleanup: async () => {},
    })
    live.pendingTools.set("tu_X", {
      mcpToolName: "Read", clientToolName: "Read", toolUseId: "tu_X",
      input: { path: "/etc/hosts" }, resolve: () => {}, reject: () => {}, startedAt: Date.now(),
    })
    live.lastEmittedAssistantBlocks = [
      { type: "tool_use", name: "Read", input: { path: "/etc/hosts" } },
    ]

    const result = await buildBlockingHandler(makeShared({ messages }))

    expect(result.isBlockingContinuation).toBe(true)
    expect(result.lineageType).toBe("blocking_continuation")
    expect(result.blockingState).toBe(live)
    expect(live.status).toBe("streaming")
  })

  it("text + tool_use assistant turn with non-matching text content → still continuation", async () => {
    // Regression: previously, if the SDK emitted [text, tool_use] and the
    // client's echo of the assistant turn had any byte-level text difference
    // (whitespace normalisation, content_block_start.text vs text_delta
    // accumulation drift, etc.), drift was reported and the request got
    // promoted to `blocking` instead of `blocking_continuation`. text and
    // thinking blocks no longer participate in drift detection — only
    // tool_use name + canonical input.
    const messages = [
      { role: "user", content: "look it up" },
      { role: "assistant", content: [
        { type: "thinking", thinking: "let me think...", signature: "sig" },
        { type: "text", text: "Looking now.\n" },
        { type: "tool_use", id: "tu_X", name: "Read", input: { path: "/etc/hosts" } },
      ] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_X", content: "ok" }] },
    ]
    const priorHashes = computeMessageHashes(messages.slice(0, -1))
    const key = { kind: "lineage", hash: priorHashes[0]! } as const

    const live = blockingPool.acquire(key, {
      key,
      ephemeralSessionId: "00000000-0000-0000-0000-000000000ddd",
      workingDirectory: cwd,
      priorMessageHashes: [priorHashes[0]!],
      cleanup: async () => {},
    })
    live.pendingTools.set("tu_X", {
      mcpToolName: "Read", clientToolName: "Read", toolUseId: "tu_X",
      input: { path: "/etc/hosts" }, resolve: () => {}, reject: () => {}, startedAt: Date.now(),
    })
    // Server snapshot captures only tool_use; the client echoes a different
    // text body ("Looking now.\n" with a trailing newline) but the same tool_use.
    live.lastEmittedAssistantBlocks = [
      { type: "tool_use", name: "Read", input: { path: "/etc/hosts" } },
    ]

    const result = await buildBlockingHandler(makeShared({ messages }))

    expect(result.isBlockingContinuation).toBe(true)
    expect(result.lineageType).toBe("blocking_continuation")
    expect(result.blockingState).toBe(live)
    expect(live.status).toBe("streaming")
  })

  it("count mismatch does NOT promote — still throws 400", async () => {
    const messages = [
      { role: "user", content: "list files" },
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_X", name: "mcp__tools__Read", input: {} }] },
      // Two results when only one tool_use was emitted.
      { role: "user", content: [
        { type: "tool_result", tool_use_id: "toolu_X", content: "ok" },
        { type: "tool_result", tool_use_id: "toolu_X2", content: "ok" },
      ] },
    ]
    const priorHashes = computeMessageHashes(messages.slice(0, -1))
    const key = { kind: "lineage", hash: priorHashes[0]! } as const
    const live = seedState(key, priorHashes, cwd, "01")
    live.pendingTools.set("toolu_X", seedPending({ toolUseId: "toolu_X" }))

    await expect(buildBlockingHandler(makeShared({ messages }))).rejects.toThrow(
      /tool_result count mismatch/,
    )
    // Live sibling released; no promote happened.
    expect(live.status).toBe("terminated")
    expect(blockingPool.totalSize()).toBe(0)
  })

  it("janitor reaps one stale sibling while leaving a fresh one", async () => {
    blockingPool._setTimeoutMs(50_000)
    const key: BlockingSessionKey = { kind: "lineage", hash: "h0" }
    const sA = seedState(key, ["h0"], cwd, "a5")
    const sB = seedState(key, ["h0", "h1"], cwd, "b5")
    sB.expiresAt = Date.now() - 1

    await blockingPool._runJanitor()

    expect(sA.status).toBe("streaming")
    expect(sB.status).toBe("terminated")
    expect(blockingPool.totalSize()).toBe(1)
    expect(blockingPool.lookup(key, ["h0"])).toBe(sA)
  })
})
