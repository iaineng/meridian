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
 *      via `prepareFreshSession` — the synthetic "Proceed as appropriate."
 *      filler can seed a tool_result-tail conversation — then `acquire`
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
import { computeMessageHashes, verifyEmittedAssistant } from "../session/lineage"
import {
  blockingPool,
  type BlockingSessionKey,
} from "../session/blockingPool"
import type { LineageResult } from "../session"

export class BlockingProtocolMismatchError extends Error {
  readonly kind = "blocking_protocol_mismatch" as const
  readonly status = 400 as const
  constructor(message: string) {
    super(message)
    this.name = "BlockingProtocolMismatchError"
  }
}

function isToolResultOnlyUserMessage(msg: any): msg is { role: "user"; content: Array<{ type: string; tool_use_id?: string; content?: unknown; is_error?: boolean }> } {
  if (!msg || msg.role !== "user" || !Array.isArray(msg.content) || msg.content.length === 0) return false
  // Shape detection only requires every block to be a tool_result. The
  // `tool_use_id` field on each block is intentionally NOT required: many
  // clients rewrite or omit IDs between rounds. Routing back to the
  // suspended handler is done positionally by `state.currentRoundToolIds`,
  // not by ID equality (see blockingStream.ts continuation resolve loop).
  return msg.content.every((b: any) => b && b.type === "tool_result")
}

export async function buildBlockingHandler(shared: SharedRequestContext): Promise<HandlerContext> {
  const { workingDirectory, allMessages, model, outputFormat, requestMeta, agentSessionId } = shared

  const lastMsg = allMessages[allMessages.length - 1]
  const isContinuationShape = isToolResultOnlyUserMessage(lastMsg)

  // Per-message hashes of the "prior" (everything except the trailing
  // tool_result user, if any). Used for prefix-overlap validation across
  // rounds because the conversation grows by 2 messages (assistant + user)
  // between each HTTP so an equality check on an aggregate hash is useless.
  const priorMessages = isContinuationShape ? allMessages.slice(0, -1) : allMessages
  const priorMessageHashes = computeMessageHashes(priorMessages)

  // Session key: explicit header > fingerprint-style first-user hash.
  // We deliberately avoid hashing `priorMessages` here because that grows
  // every round; the first user-message hash is stable for the whole chat.
  const firstUserHash = priorMessageHashes[0] ?? ""
  const key: BlockingSessionKey = agentSessionId
    ? { kind: "header", value: agentSessionId }
    : { kind: "lineage", hash: firstUserHash }

  // --- Continuation path ---
  if (isContinuationShape) {
    // Prefix-aware lookup: among siblings sharing this conversation-identity
    // key, pick the one whose stored priors are the longest strict prefix of
    // the incoming. Siblings model forked branches — the longest-prefix
    // winner is the actively-advancing branch.
    const state = blockingPool.lookup(key, priorMessageHashes)
    if (state) {
      // Drift check: the assistant turn the client reports in priorMessages
      // must match what the SDK actually emitted on the prior round (text
      // and tool_use blocks only — thinking is filtered). If the client
      // fabricated or rewrote the assistant turn, routing the trailing
      // tool_results into the live handler would feed the model garbage
      // labelled as the wrong tool. On drift we release the live sibling
      // and promote to a fresh blocking initial; the new sibling's JSONL
      // is built from the client's view of history (synthetic-filler
      // `prepareFreshSession` seeds the tool_result tail).
      let drifted = false
      const clientAssistant = priorMessages[priorMessages.length - 1] as any
      if (state.lastEmittedAssistantBlocks && clientAssistant?.role === "assistant") {
        const verdict = verifyEmittedAssistant(state.lastEmittedAssistantBlocks, clientAssistant.content)
        if (!verdict.match) {
          claudeLog("blocking.continuation.assistant_drift", {
            requestId: requestMeta.requestId,
            reason: verdict.reason,
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
        // Validate tool_result count matches pending handler count. We do
        // NOT check that the incoming tool_use_id values match pending —
        // many clients rewrite or omit IDs between rounds. The resolve loop
        // in blockingStream.ts routes positionally via
        // `state.currentRoundToolIds`, falling back to ID match when the
        // incoming ID happens to be valid.
        const incomingCount = lastMsg.content.length
        const pendingCount = state.pendingTools.size

        // When pendingTools is empty the round has already completed
        // (handlers resolved, SDK emitted end_turn, or the session is
        // mid-teardown) — any incoming tool_result is a client retry after
        // a connection drop on the final round. Not a valid continuation
        // against THIS sibling: release the stale state and fall through
        // to the initial path, which `acquire`s a fresh sibling under the
        // same key (synthetic-filler `prepareFreshSession` can seed a
        // tool_result-tail conversation).
        if (pendingCount === 0) {
          claudeLog("blocking.continuation.stale", {
            requestId: requestMeta.requestId,
            got_count: incomingCount,
          })
          await blockingPool.release(state, "stale continuation: no pending tools")
          claudeLog("blocking.continuation.promoted", {
            requestId: requestMeta.requestId,
            from: "stale",
          })
          // fall through to the initial path below
        } else {
          if (incomingCount !== pendingCount) {
            claudeLog("blocking.continuation.mismatch", {
              requestId: requestMeta.requestId,
              expected_count: pendingCount,
              got_count: incomingCount,
            })
            // Tear down the stale session so the client can retry cleanly.
            // Count mismatch is a genuinely malformed conversation: the
            // model emitted N tool_use blocks but the client returned M ≠
            // N tool_result blocks. Promoting cannot recover — the JSONL
            // would carry the same imbalance and Anthropic would reject
            // it. 400 is the right signal.
            await blockingPool.release(state, "tool_result count mismatch")
            throw new BlockingProtocolMismatchError(
              `tool_result count mismatch: expected ${pendingCount}, got ${incomingCount}`,
            )
          }

          claudeLog("blocking.continuation.matched", {
            requestId: requestMeta.requestId,
            pending: pendingCount,
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
            pendingToolResults: lastMsg.content.map((b: any) => ({
              tool_use_id: b.tool_use_id,
              content: b.content,
              is_error: b.is_error,
            })),
          }
        }
      }
    } else {
      // No sibling's priors are a prefix of the incoming — pool empty at
      // this key, session timed out, server restarted, or client forked
      // from an unseen point. NOT a 400: promote to the initial path so
      // a fresh blocking sibling is established (synthetic-filler
      // `prepareFreshSession` seeds a tool_result-tail conversation via
      // the "Proceed as appropriate." prompt).
      claudeLog("blocking.continuation.miss", {
        requestId: requestMeta.requestId,
        reason: "not_found",
      })
      claudeLog("blocking.continuation.promoted", {
        requestId: requestMeta.requestId,
        from: "miss",
      })
      // fall through to the initial path below
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
    priorMessageHashes,
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
