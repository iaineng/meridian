/**
 * Blocking-MCP handler.
 *
 * Dispatches between three sub-paths:
 *   1. Continuation (last message = tool_result-only user, lookup matched a
 *      sibling whose pending tool_use_ids equal the incoming): return a
 *      HandlerContext marking `isBlockingContinuation: true` so the
 *      streaming pipeline resolves the suspended MCP handlers instead of
 *      starting a fresh SDK query.
 *   2. Initial (first request of a blocking-eligible conversation, OR a
 *      continuation that was promoted because no live sibling matched
 *      (`miss`), the matched sibling had no pending handlers (`stale`),
 *      or the client's reported assistant turn drifted from the SDK's
 *      actual emission (`assistant_drift`)): write the JSONL transcript
 *      via `prepareFreshSession` — the synthetic "Continue from where you
 *      left off." filler can seed a tool_result-tail conversation — then `acquire`
 *      a new sibling under the conversation key and prebuild the MCP
 *      server.
 *   3. Validation mismatch (sibling matched on prefix but the incoming
 *      tool_result COUNT differs from pending handler count): throw a
 *      BlockingProtocolMismatchError that server.ts translates to 400.
 *      NOT promoted — the imbalance would carry over to a fresh sibling's
 *      JSONL and Anthropic would reject it. Note: tool_use_id values are
 *      NOT compared (clients may rewrite or omit them); routing is
 *      positional via `state.currentRoundToolIds`.
 *
 * Promotion semantics: continuation miss / stale fall through to the
 * initial path so the new sibling preserves the interleaved-thinking
 * signature chain. Only the protocol-mismatch case still hard-fails.
 */

import { claudeLog } from "../../logger"
import { envBool } from "../../env"
import type { SharedRequestContext } from "../pipeline/context"
import type { HandlerContext } from "./types"
import {
  prepareFreshSession,
  deleteSessionTranscript,
  backupSessionTranscript,
} from "../session/transcript"
import { ephemeralSessionIdPool } from "../session/ephemeralPool"
import {
  PASSTHROUGH_MCP_PREFIX,
  createBlockingPassthroughMcpServer,
} from "../passthroughTools"
import {
  computeMessageHashes,
  computeToolsFingerprint,
  verifyEmittedAssistant,
  isToolResultOnlyUserMessage,
  extractContinuationTrailing,
} from "../session/lineage"
import {
  blockingPool,
  type BlockingSessionKey,
} from "../session/blockingPool"
import { classifyQueryDirect, buildQueryDirectMessages } from "../session/queryDirect"
import type { LineageResult } from "../session"

export class BlockingProtocolMismatchError extends Error {
  readonly kind = "blocking_protocol_mismatch" as const
  readonly status = 400 as const
  constructor(message: string) {
    super(message)
    this.name = "BlockingProtocolMismatchError"
  }
}

export async function buildBlockingHandler(shared: SharedRequestContext): Promise<HandlerContext> {
  const { workingDirectory, allMessages, model, outputFormat, requestMeta, agentSessionId } = shared

  const lastMsg = allMessages[allMessages.length - 1]
  const isContinuationShape = isToolResultOnlyUserMessage(lastMsg)

  // Per-message hashes of every incoming message. The new "client-confirmed
  // prior" baseline stored on `state.priorMessageHashes` after each round
  // covers the FULL allMessages of that round — so the next round's lookup
  // matches state's stored hashes positionally against allMessageHashes
  // here, and the trailing region is exactly `slice(state.length)`. This
  // works regardless of whether the client uses split or bundled shape for
  // concurrent tool calls (`extractContinuationTrailing` flattens either).
  //
  // For initial requests (non-continuation shape) the same array doubles as
  // the round-0 `priorMessageHashes` we hand to `acquire`.
  const allMessageHashes = computeMessageHashes(allMessages)

  // Session key: explicit header > fingerprint-style first-user hash.
  // We deliberately avoid hashing `priorMessages` here because that grows
  // every round; the first user-message hash is stable for the whole chat.
  const firstUserHash = allMessageHashes[0] ?? ""
  const key: BlockingSessionKey = agentSessionId
    ? { kind: "header", value: agentSessionId }
    : { kind: "lineage", hash: firstUserHash }

  // Fingerprint of the incoming request's tools array. Compared against the
  // matched sibling's stored fingerprint at continuation time — a change in
  // tool definitions (name/description/input_schema/type added, removed, or
  // modified, or order changed) invalidates the live SDK iterator's
  // in-process MCP server (tool list is baked in at query() start and not
  // re-enumerated mid-iterator), so we promote to a fresh blocking initial
  // rather than feed the model a stale tool set.
  const incomingToolsFingerprint = computeToolsFingerprint(shared.body?.tools)

  // --- Continuation path ---
  if (isContinuationShape) {
    // Prefix-aware lookup: among siblings sharing this conversation-identity
    // key, pick the one whose stored priors are the longest strict prefix of
    // the incoming. Siblings model forked branches — the longest-prefix
    // winner is the actively-advancing branch.
    const state = blockingPool.lookup(key, allMessageHashes)
    if (!state) {
      // No sibling's priors are a prefix of the incoming — pool empty at
      // this key, session timed out, server restarted, or client forked
      // from an unseen point. NOT a 400: promote to the initial path so
      // a fresh blocking sibling is established (synthetic-filler
      // `prepareFreshSession` seeds a tool_result-tail conversation via
      // the "Continue from where you left off." prompt).
      claudeLog("blocking.continuation.miss", {
        requestId: requestMeta.requestId,
        reason: "not_found",
      })
      claudeLog("blocking.continuation.promoted", {
        requestId: requestMeta.requestId,
        from: "miss",
      })
      // fall through to the initial path below
    } else {
      // Slice the trailing region using the stored boundary. Everything
      // beyond `state.priorMessageHashes.length` is the client's delivery
      // of the previous round (echoed assistant turn(s) plus tool_results).
      const priorLen = state.priorMessageHashes.length
      const trailing = allMessages.slice(priorLen)
      const expected = state.lastEmittedAssistantBlocks?.length ?? 0
      const verdict = extractContinuationTrailing(trailing, expected)

      if (verdict.kind === "empty") {
        // priorLen === allMessages.length: client sent the same allMessages
        // as the last accepted round — replay/retry of the previous HTTP.
        // pendingTools is necessarily empty (the prior round resolved them);
        // release the stale sibling and promote to initial under the same
        // key, mirroring the "stale" path semantics.
        claudeLog("blocking.continuation.stale", {
          requestId: requestMeta.requestId,
          reason: "empty_trailing",
        })
        await blockingPool.release(state, "stale continuation: empty trailing (replay)")
        claudeLog("blocking.continuation.promoted", {
          requestId: requestMeta.requestId,
          from: "stale",
        })
        // fall through to the initial path below
      } else if (verdict.kind === "malformed") {
        // Structural problem with the trailing — count mismatch, missing
        // assistant tool_use, or non-tool-only user content. Promoting
        // can't recover; the JSONL would carry the same imbalance and
        // Anthropic would reject it. 400 is the right signal.
        claudeLog("blocking.continuation.mismatch", {
          requestId: requestMeta.requestId,
          expected_count: expected,
          reason: verdict.reason,
          trailing_count: trailing.length,
        })
        await blockingPool.release(state, verdict.reason)
        throw new BlockingProtocolMismatchError(verdict.reason)
      } else if (state.toolsFingerprint !== incomingToolsFingerprint) {
        // Tools-set change: the incoming request declares a different tool
        // list than the one baked into the live SDK iterator's MCP server.
        // We cannot patch the live server's registry from here (the SDK
        // does not re-enumerate `tools/list` across resumes within one
        // query()), so feeding tool_results into the suspended handlers
        // would let the model continue thinking against a stale schema.
        // Release the live sibling and promote to a fresh blocking initial,
        // mirroring the drift / miss / stale promotion paths.
        claudeLog("blocking.continuation.tools_changed", {
          requestId: requestMeta.requestId,
          stored: state.toolsFingerprint,
          incoming: incomingToolsFingerprint,
        })
        await blockingPool.release(state, "tools definition changed mid-conversation")
        claudeLog("blocking.continuation.promoted", {
          requestId: requestMeta.requestId,
          from: "tools_changed",
        })
        // fall through to the initial path below
      } else {
        // Drift check: the tool_use blocks the client echoed across the
        // trailing region must match what the SDK actually emitted (text
        // and thinking blocks are filtered by `verifyEmittedAssistant`).
        // If the client fabricated or rewrote the assistant turn, routing
        // the trailing tool_results into the live handler would feed the
        // model garbage labelled as the wrong tool. On drift we release
        // the live sibling and promote to a fresh blocking initial.
        let drifted = false
        if (state.lastEmittedAssistantBlocks) {
          const driftCheckContent = verdict.toolUses.map((tu) => ({
            type: "tool_use" as const,
            name: tu.name,
            input: tu.input,
          }))
          const v = verifyEmittedAssistant(state.lastEmittedAssistantBlocks, driftCheckContent)
          if (!v.match) {
            claudeLog("blocking.continuation.assistant_drift", {
              requestId: requestMeta.requestId,
              reason: v.reason,
            })
            await blockingPool.release(state, "assistant turn drifted from server emission")
            claudeLog("blocking.continuation.promoted", {
              requestId: requestMeta.requestId,
              from: "assistant_drift",
            })
            drifted = true
          }
        }

        if (!drifted) {
          // When pendingTools is empty the round has already completed
          // (handlers resolved, SDK emitted end_turn, or the session is
          // mid-teardown) — any incoming tool_result is a client retry
          // after a connection drop on the final round. Not a valid
          // continuation against THIS sibling: release the stale state
          // and fall through to the initial path.
          if (state.pendingTools.size === 0) {
            claudeLog("blocking.continuation.stale", {
              requestId: requestMeta.requestId,
              reason: "no_pending_tools",
              got_count: verdict.toolResults.length,
            })
            await blockingPool.release(state, "stale continuation: no pending tools")
            claudeLog("blocking.continuation.promoted", {
              requestId: requestMeta.requestId,
              from: "stale",
            })
            // fall through to the initial path below
          } else {
            claudeLog("blocking.continuation.matched", {
              requestId: requestMeta.requestId,
              pending: state.pendingTools.size,
              prior_len: priorLen,
              trailing_count: trailing.length,
              tool_results: verdict.toolResults.length,
            })

            const lineageResult: LineageResult = { type: "ephemeral" }
            return {
              isEphemeral: true,
              lineageResult,
              isResume: false,
              isUndo: false,
              cachedSession: undefined,
              resumeSessionId: undefined,
              undoRollbackUuid: undefined,
              lineageType: "blocking_continuation",
              messagesToConvert: [],            // unused on continuation path
              freshSessionId: undefined,
              freshMessageUuids: undefined,
              useJsonlFresh: false,
              cleanup: async () => {},          // cleanup deferred to session terminate
              blockingMode: true,
              isBlockingContinuation: true,
              blockingSessionKey: key,
              blockingState: state,
              pendingToolResults: verdict.toolResults,
              allMessageHashes,
            }
          }
        }
      }
    }
  }

  // --- Initial path ---
  const ephemeralBackup = envBool("EPHEMERAL_JSONL_BACKUP")
  let ephemeralId: string | undefined = ephemeralSessionIdPool.acquire()
  claudeLog("session.ephemeral.acquired", {
    sessionId: ephemeralId,
    poolStats: ephemeralSessionIdPool.stats(),
    blocking: true,
  })

  // Query-direct lone-user shortcut (parallel to ephemeral.ts). When the
  // request shape qualifies, skip prepareFreshSession entirely. The blocking
  // SDK iterator stays alive across HTTP rounds (in-memory tool_result
  // injection), so no JSONL is needed for multi-turn coherence.
  const qdVerdict = classifyQueryDirect(allMessages)
  if (qdVerdict.eligible) {
    claudeLog("session.query_direct", {
      reason: qdVerdict.reason,
      messageCount: allMessages.length,
      ephemeral: true,
      blocking: true,
    })
    let cleanupDone = false
    const capturedIdQd = ephemeralId
    const queryDirectCleanup = async () => {
      if (cleanupDone || !capturedIdQd) return
      cleanupDone = true
      ephemeralSessionIdPool.release(capturedIdQd)
      claudeLog("session.ephemeral.released", {
        sessionId: capturedIdQd,
        poolStats: ephemeralSessionIdPool.stats(),
        blocking: true,
        queryDirect: true,
      })
    }
    const stateQd = blockingPool.acquire(key, {
      key,
      ephemeralSessionId: capturedIdQd!,
      workingDirectory,
      priorMessageHashes: allMessageHashes,
      toolsFingerprint: incomingToolsFingerprint,
      cleanup: queryDirectCleanup,
    })
    const prebuiltPassthroughMcpQd = Array.isArray(shared.body?.tools) && shared.body.tools.length > 0
      ? createBlockingPassthroughMcpServer(shared.body.tools, stateQd)
      : undefined
    const lineageResultQd: LineageResult = { type: "ephemeral" }
    return {
      isEphemeral: true,
      lineageResult: lineageResultQd,
      isResume: false,
      isUndo: false,
      cachedSession: undefined,
      resumeSessionId: undefined,
      undoRollbackUuid: undefined,
      lineageType: "blocking",
      messagesToConvert: [],
      freshSessionId: undefined,
      freshMessageUuids: undefined,
      useJsonlFresh: false,
      cleanup: async () => {},
      blockingMode: true,
      isBlockingContinuation: false,
      blockingSessionKey: key,
      blockingState: stateQd,
      prebuiltPassthroughMcp: prebuiltPassthroughMcpQd,
      isQueryDirect: true,
      directPromptMessages: buildQueryDirectMessages(allMessages),
    }
  }

  const passthroughForJsonl = shared.initialPassthrough
  const useJsonlFresh = allMessages.length >= 1

  let messagesToConvert: Array<{ role: string; content: any }> = allMessages
  let freshSessionId: string | undefined
  let freshMessageUuids: Array<string | null> | undefined

  let effectiveUseJsonlFresh = useJsonlFresh
  if (useJsonlFresh) {
    try {
      const prep = await prepareFreshSession(allMessages, workingDirectory, {
        model,
        toolPrefix: passthroughForJsonl ? PASSTHROUGH_MCP_PREFIX : undefined,
        sessionId: ephemeralId,
        outputFormat: !!outputFormat,
        hasOtherTools: Array.isArray(shared.body?.tools) && shared.body.tools.length > 0,
      })
      // Only forward `freshSessionId` to the SDK as a resume target when the
      // JSONL was actually written. Empty message inputs short-circuit
      // transcript writes; resuming a non-existent session id would crash
      // the SDK ("No conversation found").
      freshSessionId = prep.wroteTranscript ? prep.sessionId : undefined
      freshMessageUuids = prep.wroteTranscript ? prep.messageUuids : undefined
      effectiveUseJsonlFresh = prep.wroteTranscript
      messagesToConvert = [{ role: "user", content: prep.lastUserPrompt }]
      claudeLog("session.jsonl_fresh", {
        sessionId: prep.sessionId,
        messageCount: allMessages.length,
        wroteTranscript: prep.wroteTranscript,
        ephemeral: true,
        blocking: true,
      })
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e)
      console.error(`[PROXY] ${requestMeta.requestId} jsonl_fresh_failed (blocking), fallback: ${errMsg}`)
      claudeLog("session.jsonl_fresh_failed", { error: errMsg, ephemeral: true, blocking: true })
      freshSessionId = undefined
      freshMessageUuids = undefined
      effectiveUseJsonlFresh = false
    }
  }

  // Idempotent cleanup — only runs when session fully terminates (SDK done
  // or janitor timeout). Stashed on the pool state so both paths can trigger
  // it via blockingPool.release.
  let cleanupDone = false
  const capturedId = ephemeralId
  const cleanup = async () => {
    if (cleanupDone || !capturedId) return
    cleanupDone = true
    try {
      if (ephemeralBackup) await backupSessionTranscript(workingDirectory, capturedId)
      else await deleteSessionTranscript(workingDirectory, capturedId)
    } catch (e) {
      claudeLog("session.ephemeral.cleanup_failed", {
        sessionId: capturedId,
        error: e instanceof Error ? e.message : String(e),
        blocking: true,
      })
    }
    ephemeralSessionIdPool.release(capturedId)
    claudeLog("session.ephemeral.released", {
      sessionId: capturedId,
      poolStats: ephemeralSessionIdPool.stats(),
      blocking: true,
    })
  }

  // Acquire a new sibling state. The pool allows multiple live siblings per
  // key — forked branches of the same conversation coexist and are
  // disambiguated at continuation time by longest-prefix-overlap on
  // `priorMessageHashes`.
  const state = blockingPool.acquire(key, {
    key,
    ephemeralSessionId: ephemeralId!,
    workingDirectory,
    priorMessageHashes: allMessageHashes,
    toolsFingerprint: incomingToolsFingerprint,
    cleanup,
  })

  // Prebuild the blocking MCP server so hooks.ts uses it verbatim.
  const prebuiltPassthroughMcp = Array.isArray(shared.body?.tools) && shared.body.tools.length > 0
    ? createBlockingPassthroughMcpServer(shared.body.tools, state)
    : undefined

  const lineageResult: LineageResult = { type: "ephemeral" }
  return {
    isEphemeral: true,
    lineageResult,
    isResume: false,
    isUndo: false,
    cachedSession: undefined,
    resumeSessionId: undefined,
    undoRollbackUuid: undefined,
    lineageType: "blocking",
    messagesToConvert,
    freshSessionId,
    freshMessageUuids,
    useJsonlFresh: effectiveUseJsonlFresh,
    // Cleanup is owned by the pool — the handler's cleanup is a no-op so
    // server.ts's outer finally doesn't double-fire.
    cleanup: async () => {},
    blockingMode: true,
    isBlockingContinuation: false,
    blockingSessionKey: key,
    blockingState: state,
    prebuiltPassthroughMcp,
  }
}
