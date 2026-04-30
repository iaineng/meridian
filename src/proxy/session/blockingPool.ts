/**
 * Global registry for blocking-MCP sessions.
 *
 * A blocking session persists across multiple HTTP requests for the same
 * logical conversation: the SDK async iterator stays alive while meridian
 * holds MCP tool handlers suspended on Promises, waiting for the client's
 * next HTTP request to arrive with `tool_result`s.
 *
 * Keyed by either:
 *  - `header`:  an adapter-supplied session id (e.g. `x-opencode-session`)
 *  - `lineage`: a hash of the conversation history prefix (messages minus the
 *               trailing `tool_result` user message)
 *
 * A 10-minute janitor reaps sessions that go idle without a continuation
 * HTTP request. The pool also installs process-termination hooks on first
 * use so that SIGINT / SIGTERM / natural exit drains all live sessions
 * (rejects pending handlers, deletes JSONL transcripts, stops the janitor).
 */

import { claudeLog } from "../../logger"
import { measurePrefixOverlap, type TokenUsage } from "./lineage"

export type BlockingSessionKey =
  | { kind: "header"; value: string }
  | { kind: "lineage"; hash: string }

export function stringifyBlockingKey(key: BlockingSessionKey): string {
  return key.kind === "header" ? `h:${key.value}` : `l:${key.hash}`
}

export type CallToolResultContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }

/**
 * Structural match for `@modelcontextprotocol/sdk`'s `CallToolResult`. The
 * `[k: string]: unknown` index signature comes from its `Result` parent and
 * is required so our handlers typecheck against the SDK's `tool()` helper.
 */
export interface CallToolResult {
  content: CallToolResultContent[]
  isError?: boolean
  [key: string]: unknown
}

export interface PendingTool {
  /** SDK-visible name `mcp__tools__<name>` */
  mcpToolName: string
  /** Client-visible name (prefix stripped) */
  clientToolName: string
  /** Anthropic tool_use id (source: stream_event.content_block_start) */
  toolUseId: string
  /** Aggregated input from stream_event input_json_delta */
  input: unknown
  /** Resolver for the MCP handler's suspended Promise */
  resolve: (result: CallToolResult) => void
  /** Rejector for error paths (session terminate / timeout) */
  reject: (err: Error) => void
  /** Moment the handler was called */
  startedAt: number
}

export interface ToolUseBinding {
  toolUseId: string
  input: unknown
}

type Deferred<T> = {
  promise: Promise<T>
  resolve: (v: T) => void
  reject: (e: Error) => void
}

function defer<T>(): Deferred<T> {
  let resolve!: (v: T) => void
  let reject!: (e: Error) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

export type BlockingSessionStatus =
  | "streaming"
  | "awaiting_results"
  | "terminated"

export type BufferedEvent =
  | { kind: "sse"; frame: Uint8Array }
  | { kind: "close_round"; stopReason: "tool_use" }
  | { kind: "end"; reason: "end_turn" | "max_tokens" | "error" }
  | { kind: "error"; error: Error }

/**
 * Compact form of an assistant tool_use block, used for verifying that the
 * client's reported assistant turn matches what the SDK actually emitted.
 * Only `tool_use` is tracked — `text` and `thinking` blocks do not affect
 * tool routing or SDK in-memory state, and forcing exact text equality
 * across server accumulation vs client SSE-replay is too brittle (whitespace
 * normalization, content_block_start.text vs text_delta accumulation drift,
 * etc.). See `lastEmittedAssistantBlocks` on `BlockingSessionState`.
 */
export type EmittedAssistantBlock =
  | { type: "tool_use"; name: string; input: unknown }

/**
 * Per-tool-name rendezvous slot: `bindings` are producer-first (pre-resolved
 * by the consumer task); `waiters` are handler-first (unresolved, awaiting
 * the stream event's tool_use_id).
 */
export interface BindingSlot {
  bindings: Array<Deferred<ToolUseBinding>>
  waiters: Array<Deferred<ToolUseBinding>>
}

export interface BlockingSessionState {
  key: BlockingSessionKey
  ephemeralSessionId: string
  workingDirectory: string
  createdAt: number
  /** Absolute ms timestamp (Date.now() + 10min). Janitor reaps past this. */
  expiresAt: number
  status: BlockingSessionStatus

  /**
   * Per-message hashes of every message the client delivered in the most
   * recent accepted request (initial OR continuation). Acts as a stable
   * "client-confirmed prior" boundary marker: the next round's handler
   * slices its trailing region as `allMessages.slice(this.length)` and
   * validates the prefix via `measurePrefixOverlap`. The boundary covers
   * the assistant turn(s) and tool_result user(s) the client just sent,
   * so concurrent-tool-call rounds work for either split (`a, u, a, u, …`)
   * or bundled (`a, u, u, …`) shapes — `extractContinuationTrailing`
   * flattens either after slicing.
   */
  priorMessageHashes: string[]

  /**
   * Fingerprint of the `body.tools` array supplied at session acquisition.
   * Compared against the incoming request's tools fingerprint at
   * continuation time — a mismatch means the live SDK iterator's in-process
   * MCP server has the OLD tool definitions baked in (the SDK does not
   * re-enumerate `tools/list` across resumes within one query()), so the
   * sibling cannot serve the new tool set. The handler releases the live
   * sibling and promotes to a fresh blocking initial under the same key.
   * Empty string when no tools were supplied; see `computeToolsFingerprint`.
   */
  toolsFingerprint: string

  /**
   * Fingerprint of the `body.system` field supplied at session acquisition.
   * Compared against the incoming request's system fingerprint at
   * continuation time — a mismatch means the live SDK iterator was started
   * with the OLD system prompt and the model has been operating under it.
   * Switching mid-stream requires a fresh `query()`; the handler releases
   * the live sibling and promotes to a fresh blocking initial. Empty string
   * when no system prompt was supplied; see `computeSystemFingerprint`.
   */
  systemFingerprint: string

  /** FIFO rendezvous per tool name for binding stream_event tool_use_id → handler. */
  bindingsByToolName: Map<string, BindingSlot>

  /** Map of tool_use_id → PendingTool (handlers awaiting a tool_result). */
  pendingTools: Map<string, PendingTool>
  currentRoundToolIds: string[]
  /**
   * Set when the SDK emits `message_delta(stop_reason:"tool_use")` for the
   * current turn. `expectedIds` captures the tool_use_ids the API requested
   * (from the turn's `content_block_start` events). close_round fires
   * precisely when every expected id is present in `pendingTools` — i.e.
   * every handler has entered and is ready to receive its tool_result.
   * Cleared on close_round and on continuation.
   */
  pendingRoundClose: { expectedIds: Set<string> } | null

  /** Input-json accumulator per SDK block index, for tool_use bindings. */
  inputJsonAccum: Map<number, string>
  /** tool_use info keyed by SDK block index, captured at content_block_start. */
  toolUseIdBySdkIdx: Map<number, { toolName: string; toolUseId: string }>
  /**
   * Snapshot of the most recent assistant turn's tool_use blocks the SDK
   * emitted. Captured at `message_delta(stop_reason="tool_use")` and used by
   * the next continuation request to verify the client's view of the
   * assistant turn matches what we actually emitted. Only tool_use blocks
   * are tracked — text and thinking are intentionally excluded (see the
   * `EmittedAssistantBlock` type). Mismatch = client desynced (forked
   * locally, fabricated tool_use, etc.) → release + promote to a fresh
   * sibling rather than feed bogus tool_results into the live handler.
   */
  lastEmittedAssistantBlocks: Array<EmittedAssistantBlock> | null
  /** Lifetime usage accumulator — summed across all SDK turns. Diagnostic only;
   *  the wire protocol relies on the SDK's native `message_start` / `message_delta`
   *  frames being forwarded verbatim, so meridian no longer synthesises usage. */
  cumulativeUsage: TokenUsage

  /** Buffer events when no HTTP is attached. */
  eventBuffer: BufferedEvent[]
  /** 0 or 1 active HTTP sink. */
  activeSink: ((evt: BufferedEvent) => void) | null
  sdkEnded: boolean
  sdkEndReason?: "end_turn" | "max_tokens" | "error"
  sdkError?: Error

  /**
   * True when `hooks.useBuiltinWebSearch` was set for this session — i.e.
   * `body.tools` carried a `web_search_*` typed tool. The translator uses
   * this to (a) skip the model's client-side `tool_use { name: "WebSearch" }`
   * blocks (the SDK runs WebSearch locally as a client tool) and (b) drain
   * the synthetic `server_tool_use` / `web_search_tool_result` frames
   * captured by the PostToolUse hook into `pendingWebSearchResults`.
   */
  useBuiltinWebSearch: boolean
  /**
   * Capture buffer shared with the hooks bundle's PostToolUse webSearchHook.
   * The translator drains this on subsequent (non-first) message_start
   * frames within a round and on round close, mirroring the executor's
   * behaviour for non-blocking paths. Reference is bound at consumer start.
   */
  pendingWebSearchResults: Array<{
    query: string
    results: Array<{ tool_use_id: string; content: Array<{ title: string; url: string }> }>
  }>
  /**
   * Indices (SDK-block-index) the translator has elected to skip — used to
   * silence content_block_delta / content_block_stop frames that follow the
   * client-side WebSearch tool_use's content_block_start. Cleared at
   * message_start so each turn starts fresh.
   */
  webSearchSkipIndices: Set<number>
  /**
   * True when the originating request carried `output_config.format` (i.e.
   * StructuredOutput is in play). The translator uses this to convert the
   * SDK's terminal `tool_use { name: "StructuredOutput" }` block into a
   * client-visible `text` block — the JSON-schema-conformant payload is
   * forwarded as text via `input_json_delta` → `text_delta` rewriting.
   * Bound at consumer start, mirroring `useBuiltinWebSearch`.
   */
  outputFormatActive: boolean
  /**
   * SDK-block indices the translator has tagged as the StructuredOutput
   * tool_use → text translation. content_block_delta on these indices
   * rewrites `input_json_delta` to `text_delta`. Cleared at message_start
   * so each turn starts fresh.
   */
  structuredOutputIndices: Set<number>
  /**
   * SDK-block indices for raw `text` content blocks the translator is
   * suppressing because `outputFormatActive` is true — the client only
   * wants the schema-conformant StructuredOutput payload, not any prose
   * the model produced alongside it. Cleared at message_start (per-turn
   * SDK reset) and at round close.
   */
  outputFormatTextSkipIndices: Set<number>
  /**
   * When `outputFormatActive` is true, intermediate non-tool_use
   * `message_delta` events from SDK retry attempts are buffered (latest
   * wins) instead of being forwarded — otherwise the client would see a
   * premature `stop_reason: "end_turn"` from a turn where the model failed
   * to call StructuredOutput. The buffered event's usage is reused when
   * the consumer's finally block synthesises a terminal frame in the
   * total-failure path. Round-scoped: cleared on round close.
   */
  outputFormatLastDelta: any
  /**
   * Set true once the translator has emitted a terminal `message_delta`
   * for the current round (either via the StructuredOutput-emission
   * rewrite or the consumer's synthetic finally-block frame). The
   * spawnConsumer's terminal synthesiser checks this so a successfully
   * emitted StructuredOutput round does not get a duplicate terminal
   * delta on `end`. Round-scoped: cleared on round close.
   */
  outputFormatTerminalForwarded: boolean
  /**
   * Monotonic block-index counter for the current blocking round. SDK
   * indices reset to 0 at every internal message_start; meridian remaps
   * them onto a single client-visible Anthropic message whose indices must
   * grow monotonically from 0. Synthetic WebSearch frames consume slots
   * here too. Reset to 0 on round close.
   */
  nextClientBlockIndex: number
  /**
   * Per-turn SDK-index → client-index mapping. Populated at content_block_start,
   * read at content_block_delta / content_block_stop. Cleared on every
   * message_start so the next turn's `index: 0` does not alias the previous
   * turn's index 0.
   */
  sdkToClientIndex: Map<number, number>
  /**
   * Tracks whether the translator has already emitted a `message_start` SSE
   * frame for the current blocking round. Subsequent SDK message_starts
   * within the same round (which happen when the SDK runs an internal
   * follow-up turn after a built-in WebSearch call) are coalesced into the
   * existing client-visible message — the translator drains
   * `pendingWebSearchResults` to synthetic frames and skips the duplicate
   * message_start so the client only sees one Anthropic Message per HTTP.
   * Reset on round close (passthroughTools.maybeCloseRound) and on
   * applyContinuation; flipped true the first time message_start is
   * forwarded.
   */
  messageStartEmittedThisRound: boolean

  /** Cleanup closure — deletes JSONL + releases pool id. Called on terminate. */
  cleanup: () => Promise<void>
  /** Optional abort handle to interrupt the SDK query on terminate. */
  abort?: () => void
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1_000
const JANITOR_TICK_MS = 60_000

class BlockingPool {
  /**
   * Multi-sibling storage: a single stringified conversation-identity key
   * can map to several concurrent live states. This models forked branches
   * of the same conversation (same `firstUserHash` or `agentSessionId` but
   * divergent `priorMessageHashes`). A lookup selects the sibling whose
   * stored prior-hash array is the longest strict prefix of the incoming.
   */
  private readonly siblings = new Map<string, BlockingSessionState[]>()
  private janitor: ReturnType<typeof setInterval> | null = null
  private timeoutMs = DEFAULT_TIMEOUT_MS
  private shutdownInstalled = false

  /**
   * Acquire a new session state. Never throws on key collision — appends a
   * sibling to the array at this key. Janitor and shutdown handlers are
   * installed on first use.
   */
  acquire(
    key: BlockingSessionKey,
    init: Omit<
      BlockingSessionState,
      | "status" | "bindingsByToolName" | "pendingTools" | "currentRoundToolIds"
      | "pendingRoundClose" | "cumulativeUsage"
      | "eventBuffer" | "activeSink" | "sdkEnded" | "createdAt" | "expiresAt"
      | "inputJsonAccum" | "toolUseIdBySdkIdx"
      | "lastEmittedAssistantBlocks"
      | "toolsFingerprint" | "systemFingerprint"
      | "useBuiltinWebSearch" | "pendingWebSearchResults"
      | "webSearchSkipIndices" | "messageStartEmittedThisRound"
      | "nextClientBlockIndex" | "sdkToClientIndex"
      | "outputFormatActive" | "structuredOutputIndices"
      | "outputFormatLastDelta" | "outputFormatTerminalForwarded"
      | "outputFormatTextSkipIndices"
    > & {
      toolsFingerprint?: string
      systemFingerprint?: string
      useBuiltinWebSearch?: boolean
      pendingWebSearchResults?: BlockingSessionState["pendingWebSearchResults"]
      outputFormatActive?: boolean
    },
  ): BlockingSessionState {
    const id = stringifyBlockingKey(key)
    const arr = this.siblings.get(id) ?? []
    // Defensive prune: drop any terminated residue that a bypass path may
    // have left behind. `release` already splices on teardown, so this is
    // belt-and-braces for tests and unusual shutdown sequences.
    for (let i = arr.length - 1; i >= 0; i--) {
      if (arr[i]!.status === "terminated") arr.splice(i, 1)
    }
    const now = Date.now()
    const state: BlockingSessionState = {
      ...init,
      toolsFingerprint: init.toolsFingerprint ?? "",
      systemFingerprint: init.systemFingerprint ?? "",
      useBuiltinWebSearch: init.useBuiltinWebSearch ?? false,
      pendingWebSearchResults: init.pendingWebSearchResults ?? [],
      webSearchSkipIndices: new Set(),
      outputFormatActive: init.outputFormatActive ?? false,
      structuredOutputIndices: new Set(),
      outputFormatTextSkipIndices: new Set(),
      outputFormatLastDelta: undefined,
      outputFormatTerminalForwarded: false,
      nextClientBlockIndex: 0,
      sdkToClientIndex: new Map(),
      messageStartEmittedThisRound: false,
      createdAt: now,
      expiresAt: now + this.timeoutMs,
      status: "streaming",
      bindingsByToolName: new Map(),
      pendingTools: new Map(),
      currentRoundToolIds: [],
      pendingRoundClose: null,
      inputJsonAccum: new Map(),
      toolUseIdBySdkIdx: new Map(),
      lastEmittedAssistantBlocks: null,
      cumulativeUsage: {},
      eventBuffer: [],
      activeSink: null,
      sdkEnded: false,
    }
    arr.push(state)
    this.siblings.set(id, arr)
    this.startJanitorIfNeeded()
    this.installShutdownHandlers()
    claudeLog("blocking.session.acquired", {
      key: id,
      ephemeralSessionId: init.ephemeralSessionId,
      siblingCount: arr.length,
    })
    if (arr.length > 4) {
      claudeLog("blocking.siblings.high_water", { key: id, siblingCount: arr.length })
    }
    return state
  }

  /**
   * Find the sibling at `key` whose stored `priorMessageHashes` is the
   * longest strict prefix of `priorMessageHashes`. Returns undefined when
   * no sibling's stored priors are a prefix of the incoming.
   *
   * Tiebreaker on equal prefix length: the sibling with the larger
   * `createdAt` (most recently acquired).
   */
  lookup(key: BlockingSessionKey, priorMessageHashes: string[]): BlockingSessionState | undefined {
    const arr = this.siblings.get(stringifyBlockingKey(key))
    if (!arr || arr.length === 0) return undefined
    let best: BlockingSessionState | undefined
    for (const s of arr) {
      if (s.status === "terminated") continue
      const overlap = measurePrefixOverlap(s.priorMessageHashes, priorMessageHashes)
      if (overlap !== s.priorMessageHashes.length) continue
      if (!best) { best = s; continue }
      if (s.priorMessageHashes.length > best.priorMessageHashes.length) { best = s; continue }
      if (s.priorMessageHashes.length === best.priorMessageHashes.length && s.createdAt > best.createdAt) {
        best = s
      }
    }
    return best
  }

  /**
   * Renew a session's deadline. Called on every HTTP attach / SDK event so
   * idle sessions time out but active ones do not. Per-state (not per-key)
   * because sibling states under one key have independent expiry.
   */
  touch(state: BlockingSessionState): void {
    if (state.status === "terminated") return
    state.expiresAt = Date.now() + this.timeoutMs
  }

  /**
   * Remove a specific sibling state. Rejects all pending tools and runs
   * cleanup closure. Identified by reference (not by key) because multiple
   * siblings can coexist under one key. Idempotent.
   */
  async release(state: BlockingSessionState, reason: string): Promise<void> {
    const id = stringifyBlockingKey(state.key)
    const arr = this.siblings.get(id)
    const wasMember = arr ? arr.indexOf(state) >= 0 : false
    if (state.status === "terminated" && !wasMember) return
    if (state.status !== "terminated") {
      state.status = "terminated"
      state.pendingRoundClose = null
      // Abort the SDK query BEFORE rejecting pending handlers. Rejecting a
      // handler's Promise causes the MCP SDK to serialise an error
      // CallToolResult back to the Claude subprocess, which would then post
      // that tool_result to the API as a billable follow-up turn whose
      // response nobody reads. Killing the subprocess first closes the stdio
      // transport so the error results never leave this process.
      try { state.abort?.() } catch {}
      const err = new Error(`blocking session released: ${reason}`)
      for (const [, pending] of state.pendingTools) {
        try { pending.reject(err) } catch {}
      }
      state.pendingTools.clear()
      for (const [, slot] of state.bindingsByToolName) {
        for (const d of slot.bindings) { try { d.reject(err) } catch {} }
        for (const d of slot.waiters) { try { d.reject(err) } catch {} }
      }
      state.bindingsByToolName.clear()
    }
    if (arr) {
      const i = arr.indexOf(state)
      if (i >= 0) arr.splice(i, 1)
      if (arr.length === 0) this.siblings.delete(id)
    }
    try { await state.cleanup() } catch (e) {
      claudeLog("blocking.cleanup_failed", { key: id, error: e instanceof Error ? e.message : String(e) })
    }
    claudeLog("blocking.session.released", { key: id, reason })
    if (this.totalSize() === 0) this.stopJanitor()
  }

  /**
   * Release every sibling under a key. For admin/drain paths; not used by
   * the normal request pipeline. Snapshots the array before iterating
   * because `release` mutates it.
   */
  async releaseAll(key: BlockingSessionKey, reason: string): Promise<void> {
    const arr = this.siblings.get(stringifyBlockingKey(key))
    if (!arr || arr.length === 0) return
    const snapshot = [...arr]
    for (const s of snapshot) {
      try { await this.release(s, reason) } catch {}
    }
  }

  /** Number of distinct conversation-identity keys currently live. */
  size(): number {
    return this.siblings.size
  }

  /** Total number of live sibling states across all keys. */
  totalSize(): number {
    let n = 0
    for (const arr of this.siblings.values()) n += arr.length
    return n
  }

  /**
   * Drain all live sessions. Idempotent — safe to call multiple times and
   * from process-termination paths where async awaits may not complete.
   */
  async shutdown(reason: string): Promise<void> {
    const all: BlockingSessionState[] = []
    for (const arr of this.siblings.values()) all.push(...arr)
    for (const s of all) {
      try { await this.release(s, reason) } catch {}
    }
    this.stopJanitor()
  }

  /**
   * Register process-termination hooks once per pool lifetime. On SIGINT /
   * SIGTERM we best-effort drain sessions and then re-exit with the signal's
   * conventional code; on `beforeExit` (natural shutdown) we await the drain
   * fully. Installed lazily on first `acquire` so the hooks are absent when
   * blocking mode is never used.
   */
  private installShutdownHandlers(): void {
    if (this.shutdownInstalled) return
    if (typeof process === "undefined" || typeof process.once !== "function") return
    this.shutdownInstalled = true

    const onSignal = (signal: "SIGINT" | "SIGTERM"): void => {
      const code = signal === "SIGINT" ? 130 : 143
      this.shutdown(`process_${signal.toLowerCase()}`).finally(() => {
        process.exit(code)
      })
    }
    process.once("SIGINT", () => onSignal("SIGINT"))
    process.once("SIGTERM", () => onSignal("SIGTERM"))
    process.once("beforeExit", () => { void this.shutdown("before_exit") })
  }

  private startJanitorIfNeeded(): void {
    if (this.janitor) return
    this.janitor = setInterval(() => this.tick(), JANITOR_TICK_MS)
    this.janitor.unref?.()
  }

  private stopJanitor(): void {
    if (this.janitor) { clearInterval(this.janitor); this.janitor = null }
  }

  private async tick(): Promise<void> {
    const now = Date.now()
    // Flat-snapshot before release: release() splices the shared sibling
    // array, so a direct iteration would skip neighbours after a splice.
    const expired: BlockingSessionState[] = []
    for (const arr of this.siblings.values()) {
      for (const s of arr) {
        if (s.expiresAt <= now) expired.push(s)
      }
    }
    for (const s of expired) {
      await this.release(s, "timeout")
    }
  }

  /** Test-only: override the 30-min window. */
  _setTimeoutMs(ms: number): void { this.timeoutMs = ms }
  /** Test-only: run janitor immediately. */
  async _runJanitor(): Promise<void> { await this.tick() }
  /** Test-only: full reset. */
  async _reset(): Promise<void> {
    const all: BlockingSessionState[] = []
    for (const arr of this.siblings.values()) all.push(...arr)
    for (const s of all) {
      await this.release(s, "reset")
    }
    this.timeoutMs = DEFAULT_TIMEOUT_MS
    this.stopJanitor()
  }
}

export const blockingPool = new BlockingPool()
export { defer, type Deferred }
