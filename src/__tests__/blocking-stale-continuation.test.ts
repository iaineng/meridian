/**
 * Regression test for the stale-continuation fall-through.
 *
 * Scenario: the client finishes the final tool_result round, the server
 * resolves pendingTools and the SDK emits `end_turn`, but the HTTP connection
 * drops before `message_stop` reaches the client. The client retries with the
 * same tool_result. At this point:
 *   - `priorMessageHashes` on the state was already refreshed to the extended
 *     prefix, so `prefixOk === true`
 *   - `pendingTools` is empty (handlers resolved, not re-armed)
 *   - `incomingIds.size > 0`
 *
 * Old behavior: 400 "tool_result count/id mismatch: expected 0 (...)".
 * New behavior: continuation requires BOTH prefix match AND a non-empty pending
 * set that the tool_result ids hit exactly. Empty pending means "not a valid
 * continuation" → release the stale blocking session and fall through to the
 * plain ephemeral handler so the client still gets a response.
 *
 * Note: we don't mock `buildEphemeralHandler` because `mock.module` in bun
 * leaks across test files. Instead we sandbox CLAUDE_CONFIG_DIR and a dummy
 * working directory so ephemeral's JSONL write lands in a throwaway temp dir,
 * and assert on pool state + the non-blocking shape of the returned handler.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { tmpdir } from "node:os"
import { promises as fs } from "node:fs"
import path from "node:path"

import { buildBlockingHandler } from "../proxy/handlers/blocking"
import { blockingPool } from "../proxy/session/blockingPool"
import { computeMessageHashes, computeToolsFingerprint } from "../proxy/session/lineage"

const DEFAULT_TOOLS = [{ name: "Read" }]
const DEFAULT_TOOLS_FP = computeToolsFingerprint(DEFAULT_TOOLS)

async function tmpDir(): Promise<string> {
  const dir = path.join(tmpdir(), `meridian-stale-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  await fs.mkdir(dir, { recursive: true })
  return dir
}

describe("blocking handler: stale continuation fall-through", () => {
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
      requestMeta: { requestId: "req-test", endpoint: "/v1/messages", queueEnteredAt: 0, queueStartedAt: 0 },
      agentSessionId: opts.agentSessionId,
      initialPassthrough: true,
      body: { tools: DEFAULT_TOOLS, messages: opts.messages, model: "claude-sonnet-4-5-20250929" },
    } as any
  }

  it("retry on final round: pendingTools empty → release stale sibling + promote to blocking initial", async () => {
    const messages = [
      { role: "user", content: "read README" },
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_X", name: "mcp__tools__Read", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_X", content: "ok" }] },
    ]
    const allHashes = computeMessageHashes(messages)
    const firstUserHash = allHashes[0]!
    const key = { kind: "lineage", hash: firstUserHash } as const

    // Stale state: the previous round (round 1) completed, applyContinuation
    // refreshed priorMessageHashes to the FULL allMessages of that round.
    // Client now retries the same round 1 messages — empty trailing →
    // promote stale.
    const stale = blockingPool.acquire(key, {
      key,
      ephemeralSessionId: "00000000-0000-0000-0000-000000000001",
      workingDirectory: cwd,
      priorMessageHashes: allHashes,
      toolsFingerprint: DEFAULT_TOOLS_FP,
      cleanup: async () => {},
    })
    expect(stale.pendingTools.size).toBe(0)

    const result = await buildBlockingHandler(makeShared({ messages }))

    // Stale sibling was released; a fresh blocking sibling now occupies the key.
    expect(stale.status).toBe("terminated")
    expect(result.isBlockingContinuation).toBe(false)
    expect(result.blockingMode).toBe(true)
    expect(result.lineageType).toBe("blocking")
    expect(blockingPool.totalSize()).toBe(1)
    const fresh = blockingPool.lookup(key, allHashes)
    expect(fresh).toBeDefined()
    expect(fresh).not.toBe(stale)
  })

  // Undo / rewritten-history scenarios: the first-user hash matches (same
  // conversation root) so the pool key collides, but prefix overlap against
  // the live sibling's stored priorMessageHashes fails → continuation
  // lookup misses → handler PROMOTES to the initial path, appending a NEW
  // sibling alongside the live one. The live sibling's pending handler
  // stays untouched. None of these should throw 400.
  describe("undo does not falsely trigger continuation", () => {
    // Helper: populate a blocking state representing a multi-round conversation
    // already in progress, with pending tool_use Z outstanding.
    function seedLiveState(original: any[]) {
      // Live state's priorMessageHashes = full allMessages of the previous
      // accepted round (new convention). Using `original` directly (not
      // sliced) reflects "round 1 completed; awaiting next round".
      const allHashes = computeMessageHashes(original)
      const firstUserHash = allHashes[0]!
      const key = { kind: "lineage", hash: firstUserHash } as const
      const state = blockingPool.acquire(key, {
        key,
        ephemeralSessionId: "00000000-0000-0000-0000-000000000099",
        workingDirectory: cwd,
        priorMessageHashes: allHashes,
        toolsFingerprint: DEFAULT_TOOLS_FP,
        cleanup: async () => {},
      })
      state.pendingTools.set("toolu_Z", {
        mcpToolName: "Read", clientToolName: "Read", toolUseId: "toolu_Z",
        input: {}, resolve: () => {}, reject: () => {}, startedAt: Date.now(),
      })
      return { key, state }
    }

    it("undo shortens history → prefix miss → promotes to a new sibling alongside live", async () => {
      // State reflects the live conversation up through asst3(tool_use Z).
      const live = [
        { role: "user", content: "q0" },
        { role: "assistant", content: [{ type: "text", text: "a1" }] },
        { role: "user", content: "q1" },
        { role: "assistant", content: [{ type: "tool_use", id: "toolu_Z", name: "mcp__tools__Read", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_Z", content: "ok" }] },
      ]
      const { key, state } = seedLiveState(live)
      const pendingBefore = state.pendingTools.get("toolu_Z")!
      let pendingRejected = false
      pendingBefore.reject = () => { pendingRejected = true }

      // Client undoes back to just [q0], then issues a fabricated tool_use+result round.
      const undoShort = [
        { role: "user", content: "q0" },
        { role: "assistant", content: [{ type: "tool_use", id: "toolu_Z", name: "mcp__tools__Read", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_Z", content: "ok" }] },
      ]
      const result = await buildBlockingHandler(makeShared({ messages: undoShort }))

      // prefix miss → continuation branch not entered; promoted to initial
      // path → a new sibling appended. The live sibling stays untouched.
      expect(result.blockingMode).toBe(true)
      expect(result.isBlockingContinuation).toBe(false)
      expect(result.lineageType).toBe("blocking")
      expect(pendingRejected).toBe(false)
      expect(state.status).toBe("streaming")
      expect(state.pendingTools.has("toolu_Z")).toBe(true)
      // The live sibling is still the one that matches its own priors.
      expect(blockingPool.lookup(key, state.priorMessageHashes)).toBe(state)
      // Two siblings now coexist under the same key.
      expect(blockingPool.totalSize()).toBe(2)
    })

    it("undo rewrites middle of history → prefix miss → promotes to a new sibling alongside live", async () => {
      const live = [
        { role: "user", content: "q0" },
        { role: "assistant", content: [{ type: "text", text: "a1" }] },
        { role: "user", content: "q1" },
        { role: "assistant", content: [{ type: "tool_use", id: "toolu_Z", name: "mcp__tools__Read", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_Z", content: "ok" }] },
      ]
      const { key, state } = seedLiveState(live)
      const pendingBefore = state.pendingTools.get("toolu_Z")!
      let pendingRejected = false
      pendingBefore.reject = () => { pendingRejected = true }

      // Client edits a1 (middle of history) then issues a tool_result round.
      const undoEdited = [
        { role: "user", content: "q0" },
        { role: "assistant", content: [{ type: "text", text: "a1-EDITED" }] },
        { role: "user", content: "q1" },
        { role: "assistant", content: [{ type: "tool_use", id: "toolu_Z", name: "mcp__tools__Read", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_Z", content: "ok" }] },
      ]
      const result = await buildBlockingHandler(makeShared({ messages: undoEdited }))

      expect(result.blockingMode).toBe(true)
      expect(result.isBlockingContinuation).toBe(false)
      expect(result.lineageType).toBe("blocking")
      expect(pendingRejected).toBe(false)
      expect(state.status).toBe("streaming")
      expect(state.pendingTools.has("toolu_Z")).toBe(true)
      expect(blockingPool.lookup(key, state.priorMessageHashes)).toBe(state)
      expect(blockingPool.totalSize()).toBe(2)
    })
  })

  it("count mismatch (incoming count != pending count) promotes to fresh blocking initial", async () => {
    const r0Messages = [{ role: "user", content: "read README" }]
    const r0Hashes = computeMessageHashes(r0Messages)
    const firstUserHash = r0Hashes[0]!
    const key = { kind: "lineage", hash: firstUserHash } as const

    // Round 0 acquire view: priorMessageHashes = round 0 allMessages,
    // lastEmittedAssistantBlocks captures what the SDK just emitted.
    const state = blockingPool.acquire(key, {
      key,
      ephemeralSessionId: "00000000-0000-0000-0000-000000000002",
      workingDirectory: cwd,
      priorMessageHashes: r0Hashes,
      toolsFingerprint: DEFAULT_TOOLS_FP,
      cleanup: async () => {},
    })
    state.lastEmittedAssistantBlocks = [{ type: "tool_use", name: "Read", input: {} }]
    state.pendingTools.set("toolu_X", {
      mcpToolName: "Read", clientToolName: "Read", toolUseId: "toolu_X",
      input: {}, resolve: () => {}, reject: () => {}, startedAt: Date.now(),
    })

    // Two tool_results when the model only emitted one tool_use.
    const messages = [
      ...r0Messages,
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_X", name: "mcp__tools__Read", input: {} }] },
      { role: "user", content: [
        { type: "tool_result", tool_use_id: "toolu_X", content: "ok" },
        { type: "tool_result", tool_use_id: "toolu_EXTRA", content: "ok" },
      ] },
    ]

    const result = await buildBlockingHandler(makeShared({ messages }))

    expect(state.status).toBe("streaming")
    expect(result.isBlockingContinuation).toBe(false)
    expect(result.lineageType).toBe("blocking")
    expect(result.blockingState).not.toBe(state)
    expect(state.pendingTools.has("toolu_X")).toBe(true)
    expect(blockingPool.totalSize()).toBe(2)
    expect(blockingPool.lookup(key, computeMessageHashes(messages))).toBe(result.blockingState)
  })

  it("incoming tool_use_id differs from pending (count matches) → continuation accepted; resolve routes positionally", async () => {
    const r0Messages = [{ role: "user", content: "read README" }]
    const r0Hashes = computeMessageHashes(r0Messages)
    const firstUserHash = r0Hashes[0]!
    const key = { kind: "lineage", hash: firstUserHash } as const

    const state = blockingPool.acquire(key, {
      key,
      ephemeralSessionId: "00000000-0000-0000-0000-000000000003",
      workingDirectory: cwd,
      priorMessageHashes: r0Hashes,
      toolsFingerprint: DEFAULT_TOOLS_FP,
      cleanup: async () => {},
    })
    // SDK emitted a tool_use Read with empty input; the client echoes the
    // assistant turn faithfully but rewrites the tool_use_id on the result.
    state.lastEmittedAssistantBlocks = [{ type: "tool_use", name: "mcp__tools__Read", input: {} }]
    state.pendingTools.set("toolu_X", {
      mcpToolName: "Read", clientToolName: "Read", toolUseId: "toolu_X",
      input: {}, resolve: () => {}, reject: () => {}, startedAt: Date.now(),
    })

    const messages = [
      ...r0Messages,
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_X", name: "mcp__tools__Read", input: {} }] },
      // Client rewrote the tool_use_id to something else; count still matches.
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_REWRITTEN", content: "ok" }] },
    ]

    const result = await buildBlockingHandler(makeShared({ messages }))

    expect(result.isBlockingContinuation).toBe(true)
    expect(result.lineageType).toBe("blocking_continuation")
    expect(result.blockingState).toBe(state)
    // Live sibling untouched; the resolve happens later in blockingStream.
    expect(state.status).toBe("streaming")
    expect(state.pendingTools.has("toolu_X")).toBe(true)
  })

  it("incoming tool_result with no tool_use_id field is still recognized as continuation shape", async () => {
    const r0Messages = [{ role: "user", content: "read README" }]
    const r0Hashes = computeMessageHashes(r0Messages)
    const firstUserHash = r0Hashes[0]!
    const key = { kind: "lineage", hash: firstUserHash } as const

    const state = blockingPool.acquire(key, {
      key,
      ephemeralSessionId: "00000000-0000-0000-0000-000000000004",
      workingDirectory: cwd,
      priorMessageHashes: r0Hashes,
      toolsFingerprint: DEFAULT_TOOLS_FP,
      cleanup: async () => {},
    })
    state.lastEmittedAssistantBlocks = [{ type: "tool_use", name: "mcp__tools__Read", input: {} }]
    state.pendingTools.set("toolu_X", {
      mcpToolName: "Read", clientToolName: "Read", toolUseId: "toolu_X",
      input: {}, resolve: () => {}, reject: () => {}, startedAt: Date.now(),
    })

    const messages = [
      ...r0Messages,
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_X", name: "mcp__tools__Read", input: {} }] },
      // No tool_use_id at all on the tool_result block.
      { role: "user", content: [{ type: "tool_result", content: "ok" }] },
    ]

    const result = await buildBlockingHandler(makeShared({ messages }))

    expect(result.isBlockingContinuation).toBe(true)
    expect(result.lineageType).toBe("blocking_continuation")
  })
})
