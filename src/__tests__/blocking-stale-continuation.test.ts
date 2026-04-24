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
import { computeMessageHashes } from "../proxy/session/lineage"

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
      body: { tools: [{ name: "Read" }], messages: opts.messages, model: "claude-sonnet-4-5-20250929" },
    } as any
  }

  it("retry on final round: pendingTools empty → release + ephemeral fall-through (no 400)", async () => {
    const messages = [
      { role: "user", content: "read README" },
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_X", name: "mcp__tools__Read", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_X", content: "ok" }] },
    ]
    const priorHashes = computeMessageHashes(messages.slice(0, -1))
    const firstUserHash = priorHashes[0]!
    const key = { kind: "lineage", hash: firstUserHash } as const

    const state = blockingPool.acquire(key, {
      key,
      ephemeralSessionId: "00000000-0000-0000-0000-000000000001",
      workingDirectory: cwd,
      priorMessageHashes: priorHashes,
      cleanup: async () => {},
    })
    expect(state.pendingTools.size).toBe(0)

    const result = await buildBlockingHandler(makeShared({ messages }))

    // Stale blocking session released — the key is gone from the pool.
    expect(blockingPool.lookup(key)).toBeUndefined()
    // Returned context is the ephemeral shape, not the blocking_continuation one.
    expect(result.isBlockingContinuation).toBeFalsy()
    expect(result.blockingMode).toBeFalsy()
  })

  // Undo / rewritten-history scenarios: the first-user hash matches (same
  // conversation root) so the pool key collides, but prefix overlap against
  // the stored priorMessageHashes fails → continuation branch is NOT entered
  // (goes to the initial / else path instead of resolving pending tools with
  // wrong data). None of these should throw 400.
  describe("undo does not falsely trigger continuation", () => {
    // Helper: populate a blocking state representing a multi-round conversation
    // already in progress, with pending tool_use Z outstanding.
    function seedLiveState(original: any[]) {
      const priorHashes = computeMessageHashes(original.slice(0, -1))
      const firstUserHash = priorHashes[0]!
      const key = { kind: "lineage", hash: firstUserHash } as const
      const state = blockingPool.acquire(key, {
        key,
        ephemeralSessionId: "00000000-0000-0000-0000-000000000099",
        workingDirectory: cwd,
        priorMessageHashes: priorHashes,
        cleanup: async () => {},
      })
      state.pendingTools.set("toolu_Z", {
        mcpToolName: "Read", clientToolName: "Read", toolUseId: "toolu_Z",
        input: {}, resolve: () => {}, reject: () => {}, startedAt: Date.now(),
      })
      return { key, state }
    }

    it("undo shortens history → prefix miss → falls through (no continuation, no 400)", async () => {
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

      // prefix miss → continuation branch not entered; handler must not have
      // resolved the pending tool with the undo's tool_result. Falls through
      // to ephemeral (or initial); in either case the result is NOT a
      // blocking_continuation.
      expect(result.isBlockingContinuation).toBeFalsy()
      // The live state's pending handler must NOT have been resolved or
      // rejected by the undo request — it's still waiting for its real
      // tool_result.
      expect(pendingRejected).toBe(false)
      // Live state may remain (key_conflict path) or get torn down, but if
      // it remains, pending is untouched.
      const after = blockingPool.lookup(key)
      if (after) expect(after.pendingTools.has("toolu_Z")).toBe(true)
    })

    it("undo rewrites middle of history → prefix miss → falls through", async () => {
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

      expect(result.isBlockingContinuation).toBeFalsy()
      expect(pendingRejected).toBe(false)
      const after = blockingPool.lookup(key)
      if (after) expect(after.pendingTools.has("toolu_Z")).toBe(true)
    })
  })

  it("non-stale mismatch (pending non-empty, ids differ) still throws 400", async () => {
    const messages = [
      { role: "user", content: "read README" },
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_X", name: "mcp__tools__Read", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_WRONG", content: "ok" }] },
    ]
    const priorHashes = computeMessageHashes(messages.slice(0, -1))
    const firstUserHash = priorHashes[0]!
    const key = { kind: "lineage", hash: firstUserHash } as const

    const state = blockingPool.acquire(key, {
      key,
      ephemeralSessionId: "00000000-0000-0000-0000-000000000002",
      workingDirectory: cwd,
      priorMessageHashes: priorHashes,
      cleanup: async () => {},
    })
    state.pendingTools.set("toolu_X", {
      mcpToolName: "Read", clientToolName: "Read", toolUseId: "toolu_X",
      input: {}, resolve: () => {}, reject: () => {}, startedAt: Date.now(),
    })

    await expect(buildBlockingHandler(makeShared({ messages }))).rejects.toThrow(
      /tool_result count\/id mismatch: expected 1 \(toolu_X\), got 1 \(toolu_WRONG\)/,
    )
    expect(blockingPool.lookup(key)).toBeUndefined()
  })
})
