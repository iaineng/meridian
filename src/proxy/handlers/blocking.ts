/**
 * Blocking-MCP handler.
 *
 * Dispatches between three sub-paths:
 *   1. Continuation (last message = tool_result-only user): look up the
 *      pending blocking session by header or lineage hash; validate; return
 *      a HandlerContext marking `isBlockingContinuation: true` so the
 *      streaming pipeline knows to resolve pending handlers rather than
 *      starting a fresh SDK query.
 *   2. Initial (first request of a blocking-eligible conversation): write
 *      the JSONL transcript without synthetic filler, register a new
 *      blocking session in the pool, prebuild the MCP server, and return
 *      the HandlerContext.
 *   3. Validation mismatch (hash matches but tool_result ids don't — a
 *      protocol violation): throw a BlockingProtocolMismatchError that
 *      server.ts translates to a 400 response.
 *
 * Soft fallback: hash mismatch, pool miss, or any non-protocol failure
 * returns the ephemeral handler's result so the request completes normally
 * (at the cost of the thinking chain).
 */

import { claudeLog } from "../../logger"
import { envBool } from "../../env"
import type { SharedRequestContext } from "../pipeline/context"
import type { HandlerContext } from "./types"
import { buildEphemeralHandler } from "./ephemeral"
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
import { computeMessageHashes, measurePrefixOverlap } from "../session/lineage"
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

function isToolResultOnlyUserMessage(msg: any): msg is { role: "user"; content: Array<{ type: string; tool_use_id: string; content?: unknown; is_error?: boolean }> } {
  if (!msg || msg.role !== "user" || !Array.isArray(msg.content) || msg.content.length === 0) return false
  return msg.content.every((b: any) => b && b.type === "tool_result" && typeof b.tool_use_id === "string")
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
    const state = blockingPool.lookup(key)
    const overlap = state ? measurePrefixOverlap(state.priorMessageHashes, priorMessageHashes) : 0
    const prefixOk = state ? overlap === state.priorMessageHashes.length : false
    if (state && prefixOk) {
      // Validate tool_use_id set matches pending handlers exactly.
      const incomingIds = new Set(lastMsg.content.map((b: any) => b.tool_use_id))
      const pendingIds = new Set(state.pendingTools.keys())

      // Continuation requires BOTH prefix match and tool_result set match
      // against live pending handlers. When pendingIds is empty the round
      // has already completed (handlers resolved, SDK emitted end_turn, or
      // the session is mid-teardown) — any incoming tool_result is a client
      // retry after a connection drop on the final round. Not a valid
      // continuation: release the stale session and fall through to the
      // plain ephemeral path so the client gets a fresh response.
      if (pendingIds.size === 0) {
        claudeLog("blocking.continuation.stale", {
          requestId: requestMeta.requestId,
          got_count: incomingIds.size,
          got: [...incomingIds].join(","),
        })
        await blockingPool.release(key, "stale continuation: no pending tools")
        return await buildEphemeralHandler(shared)
      }

      const sameSize = incomingIds.size === pendingIds.size
      const sameSet = sameSize && [...incomingIds].every(id => pendingIds.has(id))
      if (!sameSet) {
        const expected = [...pendingIds].join(",")
        const got = [...incomingIds].join(",")
        claudeLog("blocking.continuation.mismatch", {
          requestId: requestMeta.requestId,
          expected_count: pendingIds.size,
          got_count: incomingIds.size,
          expected,
          got,
        })
        // Tear down the stale session so the client can retry cleanly.
        await blockingPool.release(key, "tool_result id mismatch")
        throw new BlockingProtocolMismatchError(
          `tool_result count/id mismatch: expected ${pendingIds.size} (${expected}), got ${incomingIds.size} (${got})`,
        )
      }

      claudeLog("blocking.continuation.matched", {
        requestId: requestMeta.requestId,
        pending: pendingIds.size,
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

    // Continuation shape but no matching pending session — fall through to
    // initial path (will write a fresh JSONL). This path does NOT produce a
    // 400: the client may be reconnecting after a server restart, or the
    // session may have timed out.
    claudeLog("blocking.continuation.miss", {
      requestId: requestMeta.requestId,
      reason: state ? "hash_mismatch" : "not_found",
    })
    // The continuation shape means the prompt is a bunch of tool_result
    // blocks — which the SDK cannot seed from scratch. Fall back to the
    // plain ephemeral path with synthetic filler; the client's next round
    // will establish a fresh blocking session.
    return await buildEphemeralHandler(shared)
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
        blockingMode: true,
      })
      // Only forward `freshSessionId` to the SDK as a resume target when the
      // JSONL was actually written. For lone-user inputs in blocking mode the
      // sliced history is empty, no JSONL is written, and resuming a non-
      // existent session id would crash the SDK ("No conversation found").
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

  // Acquire pool slot NOW so the MCP server handlers can reference it.
  // If a terminated (stale) state exists under the same key, acquire() will
  // replace it; if an active one exists, we fall through to ephemeral to
  // avoid double-holding the key.
  const existing = blockingPool.lookup(key)
  if (existing) {
    claudeLog("blocking.initial.key_conflict", {
      requestId: requestMeta.requestId,
      reason: "active session already holds key",
    })
    await cleanup()
    return await buildEphemeralHandler(shared)
  }

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
