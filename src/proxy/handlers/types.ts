import type { LineageResult, SessionState, TokenUsage } from "../session/lineage"
import type { BlockingSessionKey, BlockingSessionState } from "../session/blockingPool"
import type { createBlockingPassthroughMcpServer } from "../passthroughTools"

/** Log-line classification. `diverged` never reaches this field — classic
 *  handler rewrites it to `new`; ephemeral synthesises `ephemeral` directly. */
export type HandlerLineageType = "continuation" | "compaction" | "undo" | "new" | "ephemeral" | "blocking" | "blocking_continuation"

/**
 * Per-request session-lifecycle state produced by either the classic or the
 * ephemeral handler. Downstream SDK execution and prompt building read from
 * this bundle without knowing which path produced it.
 */
export interface HandlerContext {
  isEphemeral: boolean

  // Session resolution
  lineageResult: LineageResult
  isResume: boolean
  isUndo: boolean
  cachedSession: SessionState | undefined
  resumeSessionId: string | undefined
  undoRollbackUuid: string | undefined
  lineageType: HandlerLineageType

  // Messages narrowed for conversion (what becomes the prompt)
  messagesToConvert: Array<{ role: string; content: any }>

  // JSONL prewarm outcome (both ephemeral and classic-diverged can produce these)
  freshSessionId: string | undefined
  freshMessageUuids: Array<string | null> | undefined
  /**
   * True when `prepareFreshSession` was *attempted* (not necessarily successful).
   * Kept separate from `freshSessionId` so the prompt builder's "JSONL path"
   * detection mirrors the pre-refactor behavior: the JSONL-structured prompt
   * branch only fires when the prewarm produced a 1-message shim, which
   * requires both `useJsonlFresh === true` and `freshSessionId` being set.
   */
  useJsonlFresh: boolean

  // Cleanup — ephemeral-only; classic returns an async no-op.
  cleanup: () => Promise<void>

  // --- Blocking-MCP mode (optional) ---
  /** True when the request is being handled by the blocking-MCP pipeline. */
  blockingMode?: boolean
  /** True when this request is a continuation of an existing blocking session. */
  isBlockingContinuation?: boolean
  /** Key used to look up / register the blocking session. */
  blockingSessionKey?: BlockingSessionKey
  /** Live state for continuation requests — already acquired from pool. */
  blockingState?: BlockingSessionState
  /** Pre-built passthrough MCP server (blocking mode stashes it on the handler). */
  prebuiltPassthroughMcp?: ReturnType<typeof createBlockingPassthroughMcpServer>
  /**
   * Continuation-only: tool_result content blocks extracted from the last
   * user message, in the order the client sent them. `tool_use_id` is
   * optional — clients may rewrite or omit the value, so the streaming
   * pipeline routes results positionally via `state.currentRoundToolIds`
   * and only consults `tool_use_id` as a hint.
   */
  pendingToolResults?: Array<{ tool_use_id?: string; content: unknown; is_error?: boolean }>
}

export interface ClassicRetryResult {
  prompt: string | AsyncIterable<any>
  resumeSessionId: string | undefined
}

export type TokenUsageBag = TokenUsage | undefined
