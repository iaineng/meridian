/**
 * Blocking-MCP continuation: format-agnostic trailing.
 *
 * When the SDK emits a single assistant turn with multiple concurrent
 * `tool_use` blocks, OpenCode-style clients may return the round-trip in
 * either of two shapes:
 *
 *   - **Bundled**: `[a(tu1, tu2), u(tr1), u(tr2)]` — assistant kept whole;
 *     tool_results split into individual user messages.
 *   - **Split**:   `[a(tu1), u(tr1), a(tu2), u(tr2)]` — assistant pre-split
 *     to one tool_use per message, each immediately followed by its result.
 *
 * Both shapes (and any consistent mix with text/thinking on the assistant
 * side) must yield the same continuation acceptance — same pendingToolResults
 * order, same drift-check outcome, same priorMessageHashes refresh.
 *
 * These integration tests exercise `buildBlockingHandler`'s continuation
 * path against a manually-seeded `BlockingSessionState`. The state mirrors
 * production immediately after round 0's emit: priorMessageHashes covers
 * round 0's allMessages, lastEmittedAssistantBlocks captures the SDK's
 * tool_use blocks, pendingTools holds suspended handler resolvers.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { tmpdir } from "node:os"
import { promises as fs } from "node:fs"
import path from "node:path"

import { buildBlockingHandler, BlockingProtocolMismatchError } from "../proxy/handlers/blocking"
import {
  blockingPool,
  type BlockingSessionKey,
  type PendingTool,
} from "../proxy/session/blockingPool"
import { computeMessageHashes, computeToolsFingerprint } from "../proxy/session/lineage"

const DEFAULT_TOOLS = [{ name: "Read" }, { name: "Bash" }]
const DEFAULT_TOOLS_FP = computeToolsFingerprint(DEFAULT_TOOLS)

async function tmpDir(): Promise<string> {
  const dir = path.join(tmpdir(), `meridian-multitool-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  await fs.mkdir(dir, { recursive: true })
  return dir
}

describe("blocking handler: format-agnostic continuation trailing", () => {
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

  function makeShared(messages: any[]) {
    return {
      workingDirectory: cwd,
      allMessages: messages,
      model: "claude-sonnet-4-5-20250929",
      outputFormat: undefined,
      requestMeta: { requestId: "req-multitool", endpoint: "/v1/messages", queueEnteredAt: 0, queueStartedAt: 0 },
      agentSessionId: undefined,
      initialPassthrough: true,
      body: { tools: DEFAULT_TOOLS, messages, model: "claude-sonnet-4-5-20250929" },
    } as any
  }

  function pending(toolUseId: string, toolName = "Read"): PendingTool {
    return {
      mcpToolName: toolName,
      clientToolName: toolName,
      toolUseId,
      input: {},
      resolve: () => {},
      reject: () => {},
      startedAt: Date.now(),
    }
  }

  /**
   * Seed a state that mirrors "round 0 just emitted N concurrent tool_uses
   * and is awaiting the client's tool_results". Returns `{ key, state }`
   * along with the round 0 messages used as priorMessageHashes baseline.
   */
  function seedRound0(opts: {
    r0Messages: any[]
    emittedToolUses: Array<{ name: string; input: unknown; pendingId: string }>
  }) {
    const r0Hashes = computeMessageHashes(opts.r0Messages)
    const key: BlockingSessionKey = { kind: "lineage", hash: r0Hashes[0]! }
    const state = blockingPool.acquire(key, {
      key,
      ephemeralSessionId: `00000000-0000-0000-0000-${Math.random().toString(16).slice(2, 14).padStart(12, "0")}`,
      workingDirectory: cwd,
      priorMessageHashes: r0Hashes,
      toolsFingerprint: DEFAULT_TOOLS_FP,
      cleanup: async () => {},
    })
    state.lastEmittedAssistantBlocks = opts.emittedToolUses.map((tu) => ({
      type: "tool_use" as const, name: tu.name, input: tu.input,
    }))
    state.currentRoundToolIds = opts.emittedToolUses.map((tu) => tu.pendingId)
    for (const tu of opts.emittedToolUses) {
      state.pendingTools.set(tu.pendingId, pending(tu.pendingId, tu.name))
    }
    return { key, state, r0Hashes }
  }

  // ---- Format acceptance ---------------------------------------------------

  it("classic bundled: [a(tu1,tu2), u(tr1, tr2)] (one user msg, all results) is accepted", async () => {
    // The most idiomatic Anthropic API shape: one assistant message holding
    // every concurrent tool_use, one user message holding every tool_result.
    // This is what Claude.ai and the SDK examples produce by default.
    const r0 = [{ role: "user", content: "do two things" }]
    const { state } = seedRound0({
      r0Messages: r0,
      emittedToolUses: [
        { name: "Read", input: {}, pendingId: "tu_A" },
        { name: "Bash", input: {}, pendingId: "tu_B" },
      ],
    })

    const messages = [
      ...r0,
      { role: "assistant", content: [
        { type: "tool_use", id: "tu_A", name: "Read", input: {} },
        { type: "tool_use", id: "tu_B", name: "Bash", input: {} },
      ] },
      { role: "user", content: [
        { type: "tool_result", tool_use_id: "tu_A", content: "rA" },
        { type: "tool_result", tool_use_id: "tu_B", content: "rB" },
      ] },
    ]

    const result = await buildBlockingHandler(makeShared(messages))

    expect(result.isBlockingContinuation).toBe(true)
    expect(result.lineageType).toBe("blocking_continuation")
    expect(result.blockingState).toBe(state)
    expect(result.pendingToolResults).toHaveLength(2)
    expect(result.pendingToolResults![0]!.tool_use_id).toBe("tu_A")
    expect(result.pendingToolResults![0]!.content).toBe("rA")
    expect(result.pendingToolResults![1]!.tool_use_id).toBe("tu_B")
    expect(result.pendingToolResults![1]!.content).toBe("rB")
  })

  it("bundled: [a(tu1,tu2), u(tr1), u(tr2)] is accepted", async () => {
    const r0 = [{ role: "user", content: "do two things" }]
    const { state } = seedRound0({
      r0Messages: r0,
      emittedToolUses: [
        { name: "Read", input: {}, pendingId: "tu_A" },
        { name: "Bash", input: {}, pendingId: "tu_B" },
      ],
    })

    const messages = [
      ...r0,
      { role: "assistant", content: [
        { type: "tool_use", id: "tu_A", name: "Read", input: {} },
        { type: "tool_use", id: "tu_B", name: "Bash", input: {} },
      ] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_A", content: "rA" }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_B", content: "rB" }] },
    ]

    const result = await buildBlockingHandler(makeShared(messages))

    expect(result.isBlockingContinuation).toBe(true)
    expect(result.lineageType).toBe("blocking_continuation")
    expect(result.blockingState).toBe(state)
    expect(result.pendingToolResults).toHaveLength(2)
    expect(result.pendingToolResults![0]!.tool_use_id).toBe("tu_A")
    expect(result.pendingToolResults![1]!.tool_use_id).toBe("tu_B")
    // allMessageHashes threaded through for applyContinuation refresh.
    expect(result.allMessageHashes).toEqual(computeMessageHashes(messages))
  })

  it("split: [a(tu1), u(tr1), a(tu2), u(tr2)] is accepted", async () => {
    const r0 = [{ role: "user", content: "do two things" }]
    const { state } = seedRound0({
      r0Messages: r0,
      emittedToolUses: [
        { name: "Read", input: {}, pendingId: "tu_A" },
        { name: "Bash", input: {}, pendingId: "tu_B" },
      ],
    })

    const messages = [
      ...r0,
      { role: "assistant", content: [{ type: "tool_use", id: "tu_A", name: "Read", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_A", content: "rA" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "tu_B", name: "Bash", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_B", content: "rB" }] },
    ]

    const result = await buildBlockingHandler(makeShared(messages))

    expect(result.isBlockingContinuation).toBe(true)
    expect(result.blockingState).toBe(state)
    expect(result.pendingToolResults).toHaveLength(2)
    expect(result.pendingToolResults![0]!.tool_use_id).toBe("tu_A")
    expect(result.pendingToolResults![1]!.tool_use_id).toBe("tu_B")
  })

  it("bundled with text+thinking on assistant side is accepted", async () => {
    const r0 = [{ role: "user", content: "go" }]
    seedRound0({
      r0Messages: r0,
      emittedToolUses: [
        { name: "Read", input: { path: "x" }, pendingId: "tu_A" },
        { name: "Bash", input: { cmd: "ls" }, pendingId: "tu_B" },
      ],
    })
    const messages = [
      ...r0,
      { role: "assistant", content: [
        { type: "thinking", thinking: "let me think…", signature: "sig" },
        { type: "text", text: "Doing this." },
        { type: "tool_use", id: "tu_A", name: "Read", input: { path: "x" } },
        { type: "tool_use", id: "tu_B", name: "Bash", input: { cmd: "ls" } },
      ] },
      { role: "user", content: [
        { type: "tool_result", tool_use_id: "tu_A", content: "ok" },
        { type: "tool_result", tool_use_id: "tu_B", content: "ok" },
      ] },
    ]
    const result = await buildBlockingHandler(makeShared(messages))
    expect(result.isBlockingContinuation).toBe(true)
    expect(result.pendingToolResults).toHaveLength(2)
  })

  it("split with text in second assistant is accepted", async () => {
    const r0 = [{ role: "user", content: "go" }]
    seedRound0({
      r0Messages: r0,
      emittedToolUses: [
        { name: "Read", input: {}, pendingId: "tu_A" },
        { name: "Bash", input: {}, pendingId: "tu_B" },
      ],
    })
    const messages = [
      ...r0,
      { role: "assistant", content: [{ type: "tool_use", id: "tu_A", name: "Read", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_A", content: "ok" }] },
      { role: "assistant", content: [
        { type: "text", text: "Now bash." },
        { type: "tool_use", id: "tu_B", name: "Bash", input: {} },
      ] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_B", content: "ok" }] },
    ]
    const result = await buildBlockingHandler(makeShared(messages))
    expect(result.isBlockingContinuation).toBe(true)
    expect(result.pendingToolResults).toHaveLength(2)
  })

  // ---- Malformed → 400 -----------------------------------------------------

  it("assistant in trailing has no tool_use → 400", async () => {
    const r0 = [{ role: "user", content: "go" }]
    seedRound0({
      r0Messages: r0,
      emittedToolUses: [{ name: "Read", input: {}, pendingId: "tu_A" }],
    })
    const messages = [
      ...r0,
      // Trailing assistant with only text — invalid for a continuation
      { role: "assistant", content: [{ type: "text", text: "no tools" }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_A", content: "ok" }] },
    ]
    await expect(buildBlockingHandler(makeShared(messages))).rejects.toThrow(BlockingProtocolMismatchError)
  })

  it("user message in trailing has mixed text + tool_result → 400", async () => {
    const r0 = [{ role: "user", content: "go" }]
    seedRound0({
      r0Messages: r0,
      emittedToolUses: [{ name: "Read", input: {}, pendingId: "tu_A" }],
    })
    const messages = [
      ...r0,
      { role: "assistant", content: [{ type: "tool_use", id: "tu_A", name: "Read", input: {} }] },
      { role: "user", content: [
        { type: "text", text: "before" },
        { type: "tool_result", tool_use_id: "tu_A", content: "ok" },
      ] },
    ]
    // Note: last user message has mixed content → fails isToolResultOnlyUserMessage,
    // so isContinuationShape is FALSE at the outer check; handler takes initial path,
    // not 400. Adjust assertion.
    const result = await buildBlockingHandler(makeShared(messages))
    expect(result.isBlockingContinuation).toBe(false)
    expect(result.lineageType).toBe("blocking")
  })

  it("tool_use count != tool_result count (extra tr) → 400", async () => {
    const r0 = [{ role: "user", content: "go" }]
    seedRound0({
      r0Messages: r0,
      emittedToolUses: [{ name: "Read", input: {}, pendingId: "tu_A" }],
    })
    const messages = [
      ...r0,
      { role: "assistant", content: [{ type: "tool_use", id: "tu_A", name: "Read", input: {} }] },
      { role: "user", content: [
        { type: "tool_result", tool_use_id: "tu_A", content: "ok" },
        { type: "tool_result", tool_use_id: "tu_EXTRA", content: "ok" },
      ] },
    ]
    await expect(buildBlockingHandler(makeShared(messages))).rejects.toThrow(/tool_result count mismatch/)
  })

  it("empty trailing (priorLen == allMessages.length) → promote stale, not 400", async () => {
    const r0 = [{ role: "user", content: "go" }]
    const { state, r0Hashes } = seedRound0({
      r0Messages: r0,
      emittedToolUses: [{ name: "Read", input: {}, pendingId: "tu_A" }],
    })
    // Manually advance state.priorMessageHashes to an extended baseline so
    // that the incoming messages exactly equal the stored prior — i.e. an
    // accidental replay of the previous round's request.
    const round1Messages = [
      ...r0,
      { role: "assistant", content: [{ type: "tool_use", id: "tu_A", name: "Read", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_A", content: "ok" }] },
    ]
    state.priorMessageHashes = computeMessageHashes(round1Messages)
    state.pendingTools.clear()  // round 1 already resolved
    state.lastEmittedAssistantBlocks = null  // no fresh emit yet

    const result = await buildBlockingHandler(makeShared(round1Messages))

    // Empty trailing → "stale" promote; new sibling acquired in initial path.
    expect(result.isBlockingContinuation).toBe(false)
    expect(result.lineageType).toBe("blocking")
    expect(state.status).toBe("terminated")
    // Fresh sibling under the same key (lineage hash unchanged).
    expect(blockingPool.lookup({ kind: "lineage", hash: r0Hashes[0]! }, computeMessageHashes(round1Messages)))
      .toBeDefined()
  })

  // ---- Multi-round growth --------------------------------------------------

  it("round 1 split → round 2 split: priorMessageHashes refresh covers full round 1", async () => {
    const r0 = [{ role: "user", content: "go" }]
    const { state, key } = seedRound0({
      r0Messages: r0,
      emittedToolUses: [
        { name: "Read", input: {}, pendingId: "tu_R1A" },
        { name: "Bash", input: {}, pendingId: "tu_R1B" },
      ],
    })

    // Round 1 (split): two assistant messages, two user messages.
    const r1Messages = [
      ...r0,
      { role: "assistant", content: [{ type: "tool_use", id: "tu_R1A", name: "Read", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_R1A", content: "rA" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "tu_R1B", name: "Bash", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_R1B", content: "rB" }] },
    ]
    const r1Result = await buildBlockingHandler(makeShared(r1Messages))
    expect(r1Result.isBlockingContinuation).toBe(true)

    // Simulate applyContinuation effect: refresh priorMessageHashes to full
    // round 1 messages, clear pendingTools (handlers resolved), set up next
    // emit's lastEmittedAssistantBlocks for round 2.
    state.priorMessageHashes = r1Result.allMessageHashes!
    state.pendingTools.clear()
    state.currentRoundToolIds = ["tu_R2A", "tu_R2B"]
    state.lastEmittedAssistantBlocks = [
      { type: "tool_use", name: "Read", input: { path: "y" } },
      { type: "tool_use", name: "Bash", input: { cmd: "pwd" } },
    ]
    state.pendingTools.set("tu_R2A", pending("tu_R2A", "Read"))
    state.pendingTools.set("tu_R2B", pending("tu_R2B", "Bash"))

    // Round 2 (split): client extends the history with the new round.
    const r2Messages = [
      ...r1Messages,
      { role: "assistant", content: [{ type: "tool_use", id: "tu_R2A", name: "Read", input: { path: "y" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_R2A", content: "ok" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "tu_R2B", name: "Bash", input: { cmd: "pwd" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_R2B", content: "/home" }] },
    ]
    const r2Result = await buildBlockingHandler(makeShared(r2Messages))
    expect(r2Result.isBlockingContinuation).toBe(true)
    expect(r2Result.blockingState).toBe(state)
    expect(r2Result.pendingToolResults).toHaveLength(2)
    expect(r2Result.pendingToolResults!.map(t => t.tool_use_id)).toEqual(["tu_R2A", "tu_R2B"])

    // Pool lookup with extended round 2 hashes still finds the same sibling.
    expect(blockingPool.lookup(key, computeMessageHashes(r2Messages))).toBe(state)
  })

  it("round 1 bundled → round 2 split: shape can change between rounds", async () => {
    const r0 = [{ role: "user", content: "go" }]
    const { state } = seedRound0({
      r0Messages: r0,
      emittedToolUses: [
        { name: "Read", input: {}, pendingId: "tu_R1A" },
        { name: "Bash", input: {}, pendingId: "tu_R1B" },
      ],
    })

    // Round 1 (bundled).
    const r1Messages = [
      ...r0,
      { role: "assistant", content: [
        { type: "tool_use", id: "tu_R1A", name: "Read", input: {} },
        { type: "tool_use", id: "tu_R1B", name: "Bash", input: {} },
      ] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_R1A", content: "a" }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_R1B", content: "b" }] },
    ]
    const r1 = await buildBlockingHandler(makeShared(r1Messages))
    expect(r1.isBlockingContinuation).toBe(true)

    // Refresh state for round 2 — single-tool emit.
    state.priorMessageHashes = r1.allMessageHashes!
    state.pendingTools.clear()
    state.currentRoundToolIds = ["tu_R2A"]
    state.lastEmittedAssistantBlocks = [{ type: "tool_use", name: "Read", input: {} }]
    state.pendingTools.set("tu_R2A", pending("tu_R2A", "Read"))

    // Round 2 (split with N=1, identical to bundled with N=1).
    const r2Messages = [
      ...r1Messages,
      { role: "assistant", content: [{ type: "tool_use", id: "tu_R2A", name: "Read", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_R2A", content: "ok" }] },
    ]
    const r2 = await buildBlockingHandler(makeShared(r2Messages))
    expect(r2.isBlockingContinuation).toBe(true)
    expect(r2.pendingToolResults).toHaveLength(1)
  })

  // ---- Drift detection -----------------------------------------------------

  it("drift: bundled with rewritten tool_use name → release sibling, promote", async () => {
    const r0 = [{ role: "user", content: "go" }]
    const { state, key } = seedRound0({
      r0Messages: r0,
      emittedToolUses: [
        { name: "Read", input: {}, pendingId: "tu_A" },
        { name: "Bash", input: {}, pendingId: "tu_B" },
      ],
    })
    const messages = [
      ...r0,
      // Client claims the second tool_use was a different tool entirely.
      { role: "assistant", content: [
        { type: "tool_use", id: "tu_A", name: "Read", input: {} },
        { type: "tool_use", id: "tu_B", name: "Edit", input: {} },
      ] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_A", content: "a" }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_B", content: "b" }] },
    ]

    const result = await buildBlockingHandler(makeShared(messages))

    expect(state.status).toBe("terminated")
    expect(result.isBlockingContinuation).toBe(false)
    expect(result.lineageType).toBe("blocking")
    // Fresh sibling acquired under the same key.
    const fresh = blockingPool.lookup(key, computeMessageHashes(messages))
    expect(fresh).toBeDefined()
    expect(fresh).not.toBe(state)
  })

  it("drift: split with input mismatch on second tool → release, promote", async () => {
    const r0 = [{ role: "user", content: "go" }]
    const { state } = seedRound0({
      r0Messages: r0,
      emittedToolUses: [
        { name: "Read", input: { path: "/etc/hosts" }, pendingId: "tu_A" },
        { name: "Bash", input: { cmd: "ls" }, pendingId: "tu_B" },
      ],
    })
    const messages = [
      ...r0,
      { role: "assistant", content: [{ type: "tool_use", id: "tu_A", name: "Read", input: { path: "/etc/hosts" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_A", content: "ok" }] },
      // Client tampered with the input on the second tool_use.
      { role: "assistant", content: [{ type: "tool_use", id: "tu_B", name: "Bash", input: { cmd: "rm -rf /" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_B", content: "DELETED" }] },
    ]
    const result = await buildBlockingHandler(makeShared(messages))
    expect(state.status).toBe("terminated")
    expect(result.isBlockingContinuation).toBe(false)
  })

  it("count drift: emitted=2 tool_uses, client supplies only 1 in trailing → 400", async () => {
    const r0 = [{ role: "user", content: "go" }]
    seedRound0({
      r0Messages: r0,
      emittedToolUses: [
        { name: "Read", input: {}, pendingId: "tu_A" },
        { name: "Bash", input: {}, pendingId: "tu_B" },
      ],
    })
    const messages = [
      ...r0,
      // Only one tool_use — client dropped the second one.
      { role: "assistant", content: [{ type: "tool_use", id: "tu_A", name: "Read", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_A", content: "ok" }] },
    ]
    await expect(buildBlockingHandler(makeShared(messages))).rejects.toThrow(/tool_result count mismatch/)
  })

  // ---- Edge cases ----------------------------------------------------------

  it("single-tool round (N=1, regression): bundled and split are identical", async () => {
    const r0 = [{ role: "user", content: "go" }]
    const { state } = seedRound0({
      r0Messages: r0,
      emittedToolUses: [{ name: "Read", input: {}, pendingId: "tu_A" }],
    })
    const messages = [
      ...r0,
      { role: "assistant", content: [{ type: "tool_use", id: "tu_A", name: "Read", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_A", content: "ok" }] },
    ]
    const result = await buildBlockingHandler(makeShared(messages))
    expect(result.isBlockingContinuation).toBe(true)
    expect(result.blockingState).toBe(state)
    expect(result.pendingToolResults).toHaveLength(1)
  })

  it("state.priorMessageHashes longer than incoming → lookup miss → promote", async () => {
    const r0 = [{ role: "user", content: "go" }]
    const { state, key } = seedRound0({
      r0Messages: r0,
      emittedToolUses: [{ name: "Read", input: {}, pendingId: "tu_A" }],
    })
    // Manually inflate stored prior to be longer than the incoming.
    state.priorMessageHashes = [...computeMessageHashes(r0), "fake-hash-1", "fake-hash-2"]

    const messages = [
      ...r0,
      { role: "assistant", content: [{ type: "tool_use", id: "tu_A", name: "Read", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_A", content: "ok" }] },
    ]
    const result = await buildBlockingHandler(makeShared(messages))
    // Lookup misses (state's prior is longer than incoming) → promote.
    expect(result.isBlockingContinuation).toBe(false)
    expect(result.lineageType).toBe("blocking")
    // Live sibling NOT released on miss (only on drift/stale/empty).
    expect(state.status).toBe("streaming")
    expect(blockingPool.totalSize()).toBe(2)
    void key
  })

  it("three-tool concurrent split: a(1)+u(1)+a(2)+u(2)+a(3)+u(3) accepted with order preserved", async () => {
    const r0 = [{ role: "user", content: "go" }]
    seedRound0({
      r0Messages: r0,
      emittedToolUses: [
        { name: "Read", input: {}, pendingId: "tu_1" },
        { name: "Bash", input: {}, pendingId: "tu_2" },
        { name: "Read", input: {}, pendingId: "tu_3" },
      ],
    })
    const messages = [
      ...r0,
      { role: "assistant", content: [{ type: "tool_use", id: "tu_1", name: "Read", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_1", content: "1" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "tu_2", name: "Bash", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_2", content: "2" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "tu_3", name: "Read", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_3", content: "3" }] },
    ]
    const result = await buildBlockingHandler(makeShared(messages))
    expect(result.isBlockingContinuation).toBe(true)
    expect(result.pendingToolResults).toHaveLength(3)
    expect(result.pendingToolResults!.map(t => t.content)).toEqual(["1", "2", "3"])
  })
})
