import type { TokenUsage } from "../session/lineage"
import type { BlockingSessionKey, BlockingSessionState } from "../session/blockingPool"
import type { createBlockingPassthroughMcpServer } from "../passthroughTools"
import type { QueryDirectMessage } from "../session/queryDirect"

/** Log-line classification used by the dispatcher. */
export type HandlerLineageType = "blocking" | "blocking_continuation"

/**
 * Per-request session-lifecycle state produced by the blocking handler.
 */
export interface HandlerContext {
  /** Initial vs continuation. */
  lineageType: HandlerLineageType

  /** Messages narrowed for conversion (what becomes the prompt). */
  messagesToConvert: Array<{ role: string; content: any }>

  /** JSONL prewarm outcome. `freshSessionId` is set only when the transcript
   *  was actually written to disk; the SDK uses it as the resume target. */
  freshSessionId: string | undefined
  freshMessageUuids: Array<string | null> | undefined

  /** Idempotent transcript/pool cleanup — fires from the dispatcher's outer
   *  finally for non-stream / errors, deferred to the stream's finally for SSE. */
  cleanup: () => Promise<void>

  // --- Blocking-MCP state ---
  /** True when this request is a continuation of an existing blocking session. */
  isBlockingContinuation: boolean
  /** Key used to look up / register the blocking session. */
  blockingSessionKey: BlockingSessionKey
  /** Live state shared between consumer task, sink, and round-close logic. */
  blockingState: BlockingSessionState
  /** Pre-built passthrough MCP server (used by hooks.ts when wiring SDK options). */
  prebuiltPassthroughMcp?: ReturnType<typeof createBlockingPassthroughMcpServer>
  /** Continuation-only: tool_result content blocks flattened across the
   *  trailing region. */
  pendingToolResults?: Array<{ tool_use_id?: string; content: unknown; is_error?: boolean }>
  /** Continuation-only: precomputed per-message hashes of the full incoming
   *  `allMessages`. Threaded so `applyContinuation` can refresh
   *  `state.priorMessageHashes` without recomputing. */
  allMessageHashes?: string[]

  // --- Query-direct lone-user path (optional) ---
  isQueryDirect?: boolean
  directPromptMessages?: QueryDirectMessage[]

  /**
   * When true the JSONL prewrite skipped the synthetic assistant filler
   * and `messagesToConvert` carries an empty-content sentinel that
   * `buildPromptBundle` lowers to an immediately-closing AsyncIterable —
   * no user frame reaches claude.exe stdin. The SDK is expected to
   * consume the trailing JSONL user row as the next turn's prompt via
   * `CLAUDE_CODE_RESUME_INTERRUPTED_TURN=1`.
   */
  resumeInterruptedTurn?: boolean
}

export type TokenUsageBag = TokenUsage | undefined
