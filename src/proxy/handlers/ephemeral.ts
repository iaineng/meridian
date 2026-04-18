import { claudeLog } from "../../logger"
import { envBool } from "../../env"
import type { SharedRequestContext } from "../pipeline/context"
import type { HandlerContext } from "./types"
import { prepareFreshSession, deleteSessionTranscript, backupSessionTranscript } from "../session/transcript"
import { ephemeralSessionIdPool } from "../session/ephemeralPool"
import { PASSTHROUGH_MCP_PREFIX } from "../passthroughTools"
import type { LineageResult } from "../session"

/**
 * Build the session-lifecycle context for the **ephemeral one-shot JSONL** path.
 *
 * Ephemeral mode:
 * - Synthesises a `diverged` lineage result (bypasses the session cache).
 * - Acquires a pooled UUID from `ephemeralSessionIdPool`.
 * - Writes a fresh JSONL transcript for the current request.
 * - Returns an idempotent cleanup closure that deletes (or backs up) the
 *   transcript and releases the pooled UUID.
 *
 * Notes:
 * - Stale-session retry and `storeSession` are explicitly NOT applicable here.
 * - The cleanup closure must be executed from the dispatcher's outer finally,
 *   EXCEPT for the streaming path which defers it to the stream's own finally
 *   (the dispatcher tracks this via a local flag after handing the cleanup
 *   closure to `runStream`).
 */
export async function buildEphemeralHandler(shared: SharedRequestContext): Promise<HandlerContext> {
  const { workingDirectory, allMessages, model, outputFormat, requestMeta } = shared

  const ephemeralBackup = envBool("EPHEMERAL_JSONL_BACKUP")

  // Pool-allocated session id: reuse a previously-released UUID if the
  // pool has one, otherwise mint a fresh one. The JSONL file at this id is
  // fully overwritten by prepareFreshSession before the SDK subprocess is
  // invoked, so reuse across serial requests is safe.
  let ephemeralId: string | undefined = ephemeralSessionIdPool.acquire()
  claudeLog("session.ephemeral.acquired", {
    sessionId: ephemeralId,
    poolStats: ephemeralSessionIdPool.stats(),
  })

  // Passthrough for tool-name prefixing in the JSONL must match the value
  // the live request will use so resume tool_use names align.
  const passthroughForJsonl = shared.initialPassthrough

  // Ephemeral always writes a JSONL when allMessages has at least one message.
  // buildJsonlLines emits [user, synthetic-assistant] for the lone-user case
  // so resume has a valid chain and the user row receives the cache breakpoint.
  const useJsonlFresh = allMessages.length >= 1

  let messagesToConvert: Array<{ role: string; content: any }> = allMessages
  let freshSessionId: string | undefined
  let freshMessageUuids: Array<string | null> | undefined

  if (useJsonlFresh) {
    try {
      const prep = await prepareFreshSession(allMessages, workingDirectory, {
        model,
        toolPrefix: passthroughForJsonl ? PASSTHROUGH_MCP_PREFIX : undefined,
        sessionId: ephemeralId,
        outputFormat: !!outputFormat,
      })
      freshSessionId = prep.sessionId
      freshMessageUuids = prep.messageUuids
      messagesToConvert = [{ role: "user", content: prep.lastUserPrompt }]
      claudeLog("session.jsonl_fresh", {
        sessionId: prep.sessionId,
        messageCount: allMessages.length,
        wroteTranscript: prep.wroteTranscript,
        ephemeral: true,
      })
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e)
      console.error(`[PROXY] ${requestMeta.requestId} jsonl_fresh_failed, fallback to flat text: ${errMsg}`)
      claudeLog("session.jsonl_fresh_failed", { error: errMsg, ephemeral: true })
      freshSessionId = undefined
      freshMessageUuids = undefined
      // Keep messagesToConvert = allMessages
      // Pool ID stays acquired — cleanup will release it (no file to delete).
    }
  }

  // Idempotent cleanup: delete-or-backup transcript, release pool id.
  let cleanupDone = false
  const cleanup = async () => {
    if (cleanupDone || !ephemeralId) return
    cleanupDone = true
    const cleanupId = ephemeralId
    try {
      if (ephemeralBackup) await backupSessionTranscript(workingDirectory, cleanupId)
      else await deleteSessionTranscript(workingDirectory, cleanupId)
    } catch (e) {
      claudeLog("session.ephemeral.cleanup_failed", {
        sessionId: cleanupId,
        error: e instanceof Error ? e.message : String(e),
      })
    }
    ephemeralSessionIdPool.release(cleanupId)
    claudeLog("session.ephemeral.released", { sessionId: cleanupId, poolStats: ephemeralSessionIdPool.stats() })
    ephemeralId = undefined
  }

  const lineageResult: LineageResult = { type: "ephemeral" }

  return {
    isEphemeral: true,
    lineageResult,
    isResume: false,
    isUndo: false,
    cachedSession: undefined,
    resumeSessionId: undefined,
    undoRollbackUuid: undefined,
    lineageType: "ephemeral",
    messagesToConvert,
    freshSessionId,
    freshMessageUuids,
    useJsonlFresh,
    cleanup,
  }
}
