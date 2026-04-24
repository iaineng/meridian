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
 * A 30-minute janitor reaps sessions that go idle without a continuation
 * HTTP request.
 */

import { claudeLog } from "../../logger"
import type { TokenUsage } from "./lineage"

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
  /** Absolute ms timestamp (Date.now() + 30min). Janitor reaps past this. */
  expiresAt: number
  status: BlockingSessionStatus

  /**
   * Per-message hashes of the "prior" messages from the most recent accepted
   * request (initial: full incoming; continuation: messages minus the trailing
   * tool_result user). Used with `measurePrefixOverlap` on the next
   * continuation so that the verification survives the natural growth of the
   * conversation (client appends an assistant turn + tool_result user between
   * rounds, so an equality check on a single aggregate hash cannot work).
   */
  priorMessageHashes: string[]

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

  /** Cleanup closure — deletes JSONL + releases pool id. Called on terminate. */
  cleanup: () => Promise<void>
  /** Optional abort handle to interrupt the SDK query on terminate. */
  abort?: () => void
}

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1_000
const JANITOR_TICK_MS = 60_000

class BlockingPool {
  private readonly sessions = new Map<string, BlockingSessionState>()
  private janitor: ReturnType<typeof setInterval> | null = null
  private timeoutMs = DEFAULT_TIMEOUT_MS

  /**
   * Acquire a new session state. Throws if the key is already occupied —
   * callers are expected to have checked `lookup` first.
   */
  acquire(
    key: BlockingSessionKey,
    init: Omit<
      BlockingSessionState,
      | "status" | "bindingsByToolName" | "pendingTools" | "currentRoundToolIds"
      | "pendingRoundClose" | "cumulativeUsage"
      | "eventBuffer" | "activeSink" | "sdkEnded" | "createdAt" | "expiresAt"
      | "inputJsonAccum" | "toolUseIdBySdkIdx"
    >,
  ): BlockingSessionState {
    const id = stringifyBlockingKey(key)
    const existing = this.sessions.get(id)
    if (existing) {
      // If the existing session is already terminated, replace it.
      if (existing.status === "terminated") {
        this.sessions.delete(id)
      } else {
        throw new Error(`blockingPool.acquire: key already in use: ${id}`)
      }
    }
    const now = Date.now()
    const state: BlockingSessionState = {
      ...init,
      createdAt: now,
      expiresAt: now + this.timeoutMs,
      status: "streaming",
      bindingsByToolName: new Map(),
      pendingTools: new Map(),
      currentRoundToolIds: [],
      pendingRoundClose: null,
      inputJsonAccum: new Map(),
      toolUseIdBySdkIdx: new Map(),
      cumulativeUsage: {},
      eventBuffer: [],
      activeSink: null,
      sdkEnded: false,
    }
    this.sessions.set(id, state)
    this.startJanitorIfNeeded()
    claudeLog("blocking.session.acquired", { key: id, ephemeralSessionId: init.ephemeralSessionId })
    return state
  }

  lookup(key: BlockingSessionKey): BlockingSessionState | undefined {
    const state = this.sessions.get(stringifyBlockingKey(key))
    if (!state) return undefined
    if (state.status === "terminated") return undefined
    return state
  }

  /**
   * Renew a session's deadline. Called on every HTTP attach / SDK event so
   * idle sessions time out but active ones do not.
   */
  touch(key: BlockingSessionKey): void {
    const state = this.sessions.get(stringifyBlockingKey(key))
    if (!state) return
    state.expiresAt = Date.now() + this.timeoutMs
  }

  /**
   * Remove a session. Rejects all pending tools and runs cleanup closure.
   * Idempotent.
   */
  async release(key: BlockingSessionKey, reason: string): Promise<void> {
    const id = stringifyBlockingKey(key)
    const state = this.sessions.get(id)
    if (!state) return
    if (state.status !== "terminated") {
      state.status = "terminated"
      state.pendingRoundClose = null
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
      try { state.abort?.() } catch {}
    }
    this.sessions.delete(id)
    try { await state.cleanup() } catch (e) {
      claudeLog("blocking.cleanup_failed", { key: id, error: e instanceof Error ? e.message : String(e) })
    }
    claudeLog("blocking.session.released", { key: id, reason })
    if (this.sessions.size === 0) this.stopJanitor()
  }

  size(): number {
    return this.sessions.size
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
    const expired: BlockingSessionKey[] = []
    for (const state of this.sessions.values()) {
      if (state.expiresAt <= now) expired.push(state.key)
    }
    for (const key of expired) {
      await this.release(key, "timeout")
    }
  }

  /** Test-only: override the 30-min window. */
  _setTimeoutMs(ms: number): void { this.timeoutMs = ms }
  /** Test-only: run janitor immediately. */
  async _runJanitor(): Promise<void> { await this.tick() }
  /** Test-only: full reset. */
  async _reset(): Promise<void> {
    for (const state of Array.from(this.sessions.values())) {
      await this.release(state.key, "reset")
    }
    this.timeoutMs = DEFAULT_TIMEOUT_MS
    this.stopJanitor()
  }
}

export const blockingPool = new BlockingPool()
export { defer, type Deferred }
