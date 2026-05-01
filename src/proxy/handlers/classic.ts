import { claudeLog } from "../../logger"
import { envBoolOptOut } from "../../env"
import { diagnosticLog } from "../../telemetry"
import type { SharedRequestContext } from "../pipeline/context"
import type { HandlerContext, HandlerLineageType, ClassicRetryResult } from "./types"
import { lookupSession, storeSession, evictSession } from "../session"
import { prepareFreshSession } from "../session/transcript"
import { lookupSessionRecovery } from "../sessionStore"
import { getLastUserMessage } from "../messages"
import { buildFreshPrompt } from "../pipeline/prompt"
import { PASSTHROUGH_MCP_PREFIX } from "../passthroughTools"
import type { LineageResult, SessionState, TokenUsage } from "../session/lineage"

function buildFreshSessionOpts(shared: SharedRequestContext) {
  return {
    model: shared.model,
    toolPrefix: shared.initialPassthrough ? PASSTHROUGH_MCP_PREFIX : undefined,
    outputFormat: !!shared.outputFormat,
    hasOtherTools: Array.isArray(shared.body?.tools) && shared.body.tools.length > 0,
  }
}

/**
 * Build the session-lifecycle context for the **classic** path (non-ephemeral).
 *
 * - Performs `lookupSession` against the LRU cache and classifies the lineage
 *   (continuation / compaction / undo / diverged).
 * - Emits the session recovery log line when the session has diverged.
 * - Selects `messagesToConvert` for resume/undo slicing.
 * - Optionally prewarms a JSONL transcript for diverged-multi-message requests
 *   when `USE_JSONL_SESSIONS` is enabled (default on).
 * - Returns a no-op cleanup (classic path has nothing to release).
 */
export async function buildClassicHandler(shared: SharedRequestContext): Promise<HandlerContext> {
  const { workingDirectory, allMessages,
          profileSessionId, profileScopedCwd, requestMeta } = shared

  const lineageResult: LineageResult = lookupSession(
    profileSessionId,
    allMessages,
    profileScopedCwd,
  )
  const isResume = lineageResult.type === "continuation" || lineageResult.type === "compaction"
  const isUndo = lineageResult.type === "undo"
  const cachedSession: SessionState | undefined =
    (lineageResult.type === "continuation"
      || lineageResult.type === "compaction"
      || lineageResult.type === "undo")
      ? lineageResult.session : undefined
  const resumeSessionId = cachedSession?.claudeSessionId
  const undoRollbackUuid = isUndo && lineageResult.type === "undo" ? lineageResult.rollbackUuid : undefined
  // `diverged` never carries a session (see LineageResult); treat it as `new`
  // in log lines and telemetry.
  const lineageType: HandlerLineageType = lineageResult.type === "diverged" ? "new" : lineageResult.type

  // Recovery logging: when a session diverges, surface the previous session ID.
  if (lineageResult.type === "diverged" && profileSessionId) {
    const recovery = lookupSessionRecovery(profileSessionId)
    if (recovery) {
      const prevId = recovery.previousClaudeSessionId || recovery.claudeSessionId
      const recoveryMsg = `${requestMeta.requestId} SESSION RECOVERY: previous conversation available. Run: claude --resume ${prevId}`
      console.error(`[PROXY] ${recoveryMsg}`)
      diagnosticLog.session(recoveryMsg, requestMeta.requestId)
    }
  }

  // When resuming, only send new messages the SDK doesn't have.
  let messagesToConvert: Array<{ role: string; content: any }>
  if ((isResume || isUndo) && cachedSession) {
    if (isUndo && undoRollbackUuid) {
      messagesToConvert = getLastUserMessage(allMessages)
    } else if (isResume) {
      const knownCount = cachedSession.messageCount || 0
      if (knownCount > 0 && knownCount < allMessages.length) {
        messagesToConvert = allMessages.slice(knownCount)
      } else {
        messagesToConvert = getLastUserMessage(allMessages)
      }
    } else {
      messagesToConvert = getLastUserMessage(allMessages)
    }
  } else {
    messagesToConvert = allMessages
  }

  // Optional JSONL prewarm for diverged-multi-message requests.
  const useJsonlFresh = lineageResult.type === "diverged" && envBoolOptOut("USE_JSONL_SESSIONS") && allMessages.length > 1

  let freshSessionId: string | undefined
  let freshMessageUuids: Array<string | null> | undefined

  if (useJsonlFresh) {
    try {
      const prep = await prepareFreshSession(allMessages, workingDirectory, buildFreshSessionOpts(shared))
      freshSessionId = prep.sessionId
      freshMessageUuids = prep.messageUuids
      messagesToConvert = [{ role: "user", content: prep.lastUserPrompt }]
      claudeLog("session.jsonl_fresh", {
        sessionId: prep.sessionId,
        messageCount: allMessages.length,
        wroteTranscript: prep.wroteTranscript,
        ephemeral: false,
      })
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e)
      console.error(`[PROXY] ${requestMeta.requestId} jsonl_fresh_failed, fallback to flat text: ${errMsg}`)
      claudeLog("session.jsonl_fresh_failed", { error: errMsg, ephemeral: false })
      freshSessionId = undefined
      freshMessageUuids = undefined
    }
  }

  return {
    isEphemeral: false,
    lineageResult,
    isResume,
    isUndo,
    cachedSession,
    resumeSessionId,
    undoRollbackUuid,
    lineageType,
    messagesToConvert,
    freshSessionId,
    freshMessageUuids,
    useJsonlFresh,
    cleanup: async () => {},
  }
}

/**
 * Persist a completed classic-path session to the cache. No-op if sdkSessionId
 * is missing (the SDK did not return one). This is the ONLY site that calls
 * `storeSession` post-refactor.
 */
export function persistClassicSession(
  shared: SharedRequestContext,
  sdkSessionId: string | undefined,
  sdkUuidMap: Array<string | null>,
  usage: TokenUsage | undefined,
): void {
  if (!sdkSessionId) return
  storeSession(
    shared.profileSessionId,
    shared.allMessages,
    sdkSessionId,
    shared.profileScopedCwd,
    sdkUuidMap,
    usage,
  )
}

/**
 * Classic-only stale-UUID retry: evict the cached session, rebuild the prompt
 * via JSONL prewarm (preferred) or flat-text fallback. Mutates `sdkUuidMap`
 * in place to match today's behavior — the executor reads this array during
 * UUID accumulation.
 */
export async function staleSessionRetryClassic(
  shared: SharedRequestContext,
  sdkUuidMap: Array<string | null>,
  mode: 'stream' | 'non_stream',
  undoRollbackUuid: string | undefined,
  resumeSessionId: string | undefined,
): Promise<ClassicRetryResult> {
  const { allMessages, workingDirectory, requestMeta,
          profileSessionId, profileScopedCwd } = shared

  claudeLog("session.stale_uuid_retry", {
    mode,
    rollbackUuid: undoRollbackUuid,
    resumeSessionId,
  })
  console.error(`[PROXY] Stale session UUID, evicting and retrying as fresh session`)
  evictSession(profileSessionId, profileScopedCwd, allMessages)

  // Reset the shared UUID map — the executor will repopulate from the retry.
  sdkUuidMap.length = 0
  for (let i = 0; i < allMessages.length; i++) sdkUuidMap.push(null)

  const retryViaJsonl = envBoolOptOut("USE_JSONL_SESSIONS") && allMessages.length > 1
  const flatTextToolPrefix = shared.initialPassthrough ? PASSTHROUGH_MCP_PREFIX : ""

  let retryResumeId: string | undefined
  let retryPrompt: string | AsyncIterable<any>

  if (retryViaJsonl) {
    try {
      const prep = await prepareFreshSession(allMessages, workingDirectory, buildFreshSessionOpts(shared))
      retryResumeId = prep.sessionId
      for (let i = 0; i < prep.messageUuids.length; i++) sdkUuidMap[i] = prep.messageUuids[i] ?? null
      retryPrompt = typeof prep.lastUserPrompt === "string"
        ? prep.lastUserPrompt
        : (async function* () {
            yield { type: "user" as const, message: { role: "user" as const, content: prep.lastUserPrompt }, parent_tool_use_id: null }
          })()
    } catch (retryErr) {
      console.error(`[PROXY] ${requestMeta.requestId} stale-retry jsonl_fresh_failed, using flat text: ${retryErr instanceof Error ? retryErr.message : String(retryErr)}`)
      retryResumeId = undefined
      retryPrompt = buildFreshPrompt(allMessages, flatTextToolPrefix)
    }
  } else {
    retryPrompt = buildFreshPrompt(allMessages, flatTextToolPrefix)
  }

  return { prompt: retryPrompt, resumeSessionId: retryResumeId }
}
