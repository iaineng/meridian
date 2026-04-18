import type { LineageResult, SessionState, TokenUsage } from "../session/lineage"

/** Log-line classification. `diverged` never reaches this field — classic
 *  handler rewrites it to `new`; ephemeral synthesises `ephemeral` directly. */
export type HandlerLineageType = "continuation" | "compaction" | "undo" | "new" | "ephemeral"

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
}

export interface ClassicRetryResult {
  prompt: string | AsyncIterable<any>
  resumeSessionId: string | undefined
}

export type TokenUsageBag = TokenUsage | undefined
