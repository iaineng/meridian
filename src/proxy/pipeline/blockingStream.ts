/**
 * Blocking-MCP streaming pipeline.
 *
 * Replaces `runStream` for requests that carry `handler.blockingMode === true`.
 * The SDK query is started once (on the first HTTP) and lives across many
 * HTTP requests: each "round" of tool_use → tool_result corresponds to one
 * HTTP response, but the underlying async iterator and MCP handler Promises
 * stay alive in meridian memory between them.
 *
 * Key invariants:
 *   - One BlockingSessionState per logical conversation (keyed by header /
 *     lineage hash). Stored in `blockingPool`.
 *   - Exactly one consumer task per state, spawned on the first HTTP. Reads
 *     the SDK iterator, translates messages to SSE frames, pushes them to
 *     the active HTTP sink or to an internal buffer when detached.
 *   - Each HTTP round corresponds to exactly one SDK internal turn. The
 *     SDK's native `message_start` / `message_delta` frames carry real
 *     `msg_id`, `model`, and `usage` and are forwarded verbatim. Only
 *     `message_stop` is suppressed and re-emitted synthetically after the
 *     two-gate round closer fires — meridian needs the HTTP to stay open
 *     until every MCP handler has registered its PendingTool.
 *   - The round closer in `passthroughTools.ts:maybeCloseRound` flushes a
 *     `close_round` event when the API emits `message_delta(stop_reason:
 *     "tool_use")` AND every expected handler has entered (its PendingTool
 *     is registered). No timer — the two-gate condition is deterministic.
 */

import { homedir } from "node:os"
import { query } from "@anthropic-ai/claude-agent-sdk"
import { claudeLog } from "../../logger"
import { buildQueryOptions } from "../query"
import {
  resolveClaudeOauthEnv,
  CLAUDE_OAUTH_ENV_KEYS,
} from "../claudeOauthEnv"
import { isClosedControllerError } from "../models"
import { classifyError, isMaxTurnsError, isMaxOutputTokensError } from "../errors"
import { PASSTHROUGH_MCP_PREFIX, stripMcpPrefix, registerToolUseBinding, maybeCloseRound } from "../passthroughTools"
import { normalizeToolResultForMcp } from "../session/transcript"
import { computeMessageHashes } from "../session/lineage"
import { recordRequestSuccess, recordRequestError } from "./telemetry"
import {
  blockingPool,
  stringifyBlockingKey,
  type BlockingSessionState,
  type BufferedEvent,
} from "../session/blockingPool"
import type { SharedRequestContext } from "./context"
import type { HandlerContext } from "../handlers/types"
import type { PromptBundle } from "./prompt"
import type { HookBundle } from "./hooks"
import type { ExecutorEnv } from "./executor"
import type { TokenUsage } from "../session/lineage"

/** Additive merge of two TokenUsage records. Missing fields treated as 0. */
function sumUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  const out: TokenUsage = { ...a }
  const add = (k: keyof TokenUsage): void => {
    const av = a[k]
    const bv = b[k]
    if (av === undefined && bv === undefined) return
    out[k] = (av ?? 0) + (bv ?? 0)
  }
  add("input_tokens")
  add("output_tokens")
  add("cache_read_input_tokens")
  add("cache_creation_input_tokens")
  return out
}

// --- Sink attach / detach ---

function attachSink(
  state: BlockingSessionState,
  sink: (evt: BufferedEvent) => void,
): void {
  state.activeSink = sink
  if (state.eventBuffer.length > 0) {
    const buf = state.eventBuffer
    state.eventBuffer = []
    for (const evt of buf) sink(evt)
  }
}

function detachSink(state: BlockingSessionState): void {
  state.activeSink = null
}

function pushEvent(state: BlockingSessionState, evt: BufferedEvent): void {
  if (state.status === "terminated") return
  const sink = state.activeSink
  if (sink) sink(evt)
  else state.eventBuffer.push(evt)
}

// --- SDK event translation ---
//
// Translates an SDK stream message into zero or more SSE frames. Uses the
// shared `state` (not a per-HTTP translation state) so the consumer task
// keeps emitting correctly across HTTP attach/detach transitions.
//
// Philosophy: each blocking HTTP round corresponds to exactly one SDK
// internal turn (the next turn cannot begin until the client delivers the
// tool_result that resolves this turn's pending MCP handlers). Every SDK
// turn already emits its own `message_start` (with real `msg_id`, `model`,
// and `usage`) and `message_delta` (with real `output_tokens` + stop_reason),
// so meridian forwards them verbatim.
//
// The only SDK event meridian has to withhold is `message_stop`: the SDK
// emits it as soon as the API marks the turn complete, but meridian cannot
// close the HTTP until every MCP handler has entered its pending state
// (gate 2 of the two-gate round closer). `message_stop` is therefore
// re-emitted synthetically from `close_round` / `end` in runBlockingStream.

export function translateBlockingMessage(
  msg: any,
  state: BlockingSessionState,
  encoder: TextEncoder,
): Uint8Array[] {
  if (msg?.type !== "stream_event") return []
  const event = msg.event
  const eventType = event?.type as string
  const eventIndex = event?.index as number | undefined
  const frames: Uint8Array[] = []

  if (eventType === "message_start") {
    // New SDK turn → new HTTP round's message. Reset per-turn tool_use
    // tracking (input_json accumulators, SDK-index → tool_use_id map) so
    // the next turn's bindings don't see stale entries. Forward verbatim.
    state.inputJsonAccum.clear()
    state.toolUseIdBySdkIdx.clear()
    const startUsage = event.message?.usage as TokenUsage | undefined
    if (startUsage) state.cumulativeUsage = sumUsage(state.cumulativeUsage, startUsage)
    frames.push(encoder.encode(`event: message_start\ndata: ${JSON.stringify(event)}\n\n`))
    return frames
  }

  // Suppressed — meridian emits a synthetic `message_stop` at close_round /
  // end once all pending handlers have entered.
  if (eventType === "message_stop") return frames

  if (eventType === "message_delta") {
    const u = event.usage as TokenUsage | undefined
    if (u) state.cumulativeUsage = sumUsage(state.cumulativeUsage, { output_tokens: u.output_tokens })
    // API signal: assistant turn finished with tool_use — arm the round
    // closer. `expectedIds` is the set of tool_use ids observed in the
    // turn's content_block_start events. close_round will fire as soon as
    // every handler has registered its PendingTool (whichever gate edge
    // completes last) — the caller runs `maybeCloseRound` AFTER pushing
    // these frames to the sink. Calling it here would race: if handlers
    // are already pending, close_round would fire first, detach the sink,
    // then the message_delta frame returned from this function would miss
    // it and land in the buffer → delivered at the start of the next HTTP.
    const stopReason = event.delta?.stop_reason as string | undefined
    if (stopReason === "tool_use") {
      const expectedIds = new Set<string>()
      for (const [, v] of state.toolUseIdBySdkIdx) expectedIds.add(v.toolUseId)
      if (expectedIds.size > 0) state.pendingRoundClose = { expectedIds }
    }
    frames.push(encoder.encode(`event: message_delta\ndata: ${JSON.stringify(event)}\n\n`))
    return frames
  }

  if (eventType === "content_block_start") {
    const block = event.content_block
    if (block?.type === "tool_use" && typeof block.name === "string" && block.name.startsWith(PASSTHROUGH_MCP_PREFIX)) {
      const clientName = stripMcpPrefix(block.name)
      if (block.id && typeof block.id === "string") {
        // Bind by the un-prefixed name to match the handler's lookup key in
        // createBlockingPassthroughMcpServer (which uses the raw OpenCode
        // tool name). Mismatch here strands the handler in consumeBinding,
        // which prevents the round closer from firing and leaves the HTTP
        // hung after the tool_use's content_block_stop.
        registerToolUseBinding(state, clientName, { toolUseId: block.id, input: {} })
        if (eventIndex !== undefined) {
          state.toolUseIdBySdkIdx.set(eventIndex, { toolName: clientName, toolUseId: block.id })
          state.inputJsonAccum.set(eventIndex, "")
        }
      }
      // Forward with the MCP prefix stripped; keep SDK's native block index.
      frames.push(encoder.encode(`event: content_block_start\ndata: ${JSON.stringify({
        ...event,
        content_block: { ...block, name: clientName, input: {} },
      })}\n\n`))
      return frames
    }
    frames.push(encoder.encode(`event: content_block_start\ndata: ${JSON.stringify(event)}\n\n`))
    return frames
  }

  if (eventType === "content_block_delta") {
    if (eventIndex !== undefined) {
      const delta = event.delta
      if (delta?.type === "input_json_delta" && typeof delta.partial_json === "string"
          && state.inputJsonAccum.has(eventIndex)) {
        const prev = state.inputJsonAccum.get(eventIndex) ?? ""
        state.inputJsonAccum.set(eventIndex, prev + delta.partial_json)
      }
    }
    frames.push(encoder.encode(`event: content_block_delta\ndata: ${JSON.stringify(event)}\n\n`))
    return frames
  }

  if (eventType === "content_block_stop") {
    if (eventIndex !== undefined) {
      const tu = state.toolUseIdBySdkIdx.get(eventIndex)
      if (tu) {
        const raw = state.inputJsonAccum.get(eventIndex) ?? ""
        let input: unknown = {}
        if (raw) { try { input = JSON.parse(raw) } catch {} }
        const pending = state.pendingTools.get(tu.toolUseId)
        if (pending) pending.input = input
      }
    }
    frames.push(encoder.encode(`event: content_block_stop\ndata: ${JSON.stringify(event)}\n\n`))
    return frames
  }

  frames.push(encoder.encode(`event: ${eventType}\ndata: ${JSON.stringify(event)}\n\n`))
  return frames
}

const MESSAGE_STOP_FRAME = new TextEncoder().encode(`event: message_stop\ndata: {"type":"message_stop"}\n\n`)

function makeMessageStopFrame(encoder: TextEncoder): Uint8Array {
  // Allocate per-call so the outer safeEnqueue's buffer ownership is clean;
  // encoder arg is accepted for symmetry / future testability even though we
  // could return the module-scoped constant.
  void encoder
  return MESSAGE_STOP_FRAME
}

async function spawnConsumer(
  state: BlockingSessionState,
  iterator: AsyncIterable<unknown>,
  encoder: TextEncoder,
): Promise<void> {
  try {
    for await (const msg of iterator) {
      if (state.status === "terminated") break
      const frames = translateBlockingMessage(msg, state, encoder)
      for (const f of frames) pushEvent(state, { kind: "sse", frame: f })
      // Check the round-closer gate AFTER pushing this iteration's frames
      // to the sink. translateBlockingMessage only arms `pendingRoundClose`
      // when it sees `message_delta(stop_reason:"tool_use")`; calling
      // maybeCloseRound inside translate would let close_round detach the
      // sink before the SDK's own message_delta frame (returned by this
      // same call) had a chance to reach the client, so that frame would
      // get buffered and replayed at the start of the next HTTP round.
      maybeCloseRound(state)
    }
    if (!state.sdkEnded) {
      state.sdkEnded = true
      state.sdkEndReason = "end_turn"
    }
  } catch (e) {
    if (isClosedControllerError(e)) return
    state.sdkEnded = true
    const errMsg = e instanceof Error ? e.message : String(e)
    if (isMaxTurnsError(errMsg) || isMaxOutputTokensError(errMsg)) {
      state.sdkEndReason = "end_turn"
    } else {
      state.sdkEndReason = "error"
      state.sdkError = e instanceof Error ? e : new Error(String(e))
      pushEvent(state, { kind: "error", error: state.sdkError })
    }
  } finally {
    pushEvent(state, { kind: "end", reason: state.sdkEndReason ?? "end_turn" })
  }
}

// --- Public entrypoint ---

export function runBlockingStream(
  shared: SharedRequestContext,
  handler: HandlerContext,
  promptBundle: PromptBundle,
  hooks: HookBundle,
  env: ExecutorEnv,
): Response {
  const encoder = new TextEncoder()
  const isContinuation = handler.isBlockingContinuation === true

  const state = handler.blockingState!
  const key = handler.blockingSessionKey!

  // For a continuation request, resolve the suspended handlers BEFORE we
  // build the new HTTP ReadableStream. The consumer task (spawned on the
  // initial HTTP) will unblock and start feeding new SSE frames into the
  // event buffer; they'll be flushed when the sink attaches.
  if (isContinuation) {
    claudeLog("blocking.continuation.start", {
      requestId: shared.requestMeta.requestId,
      key: stringifyBlockingKey(key),
      resolving: handler.pendingToolResults?.length ?? 0,
    })
    for (const tr of handler.pendingToolResults ?? []) {
      const pending = state.pendingTools.get(tr.tool_use_id)
      if (!pending) continue
      const mcpResult = normalizeToolResultForMcp(tr)
      try { pending.resolve(mcpResult) } catch {}
      state.pendingTools.delete(tr.tool_use_id)
    }
    state.currentRoundToolIds = []
    state.pendingRoundClose = null
    state.status = "streaming"
    // Refresh the stored prior-hash baseline to this round's prior prefix
    // (everything except the trailing tool_result user). Subsequent rounds
    // will validate against this extended prefix.
    const allMessages = shared.body?.messages ?? []
    if (allMessages.length >= 1) {
      state.priorMessageHashes = computeMessageHashes(allMessages.slice(0, -1))
    }
  } else {
    claudeLog("blocking.initial.start", {
      requestId: shared.requestMeta.requestId,
      key: stringifyBlockingKey(key),
    })
  }

  blockingPool.touch(key)

  let streamClosed = false
  let heartbeat: ReturnType<typeof setInterval> | undefined

  // Per-HTTP telemetry bookkeeping. Each call to runBlockingStream is one
  // request from the client's perspective and must produce exactly one
  // telemetry record, regardless of whether the HTTP ends via close_round
  // (round boundary), end (SDK finished), error, or client cancel.
  const upstreamStartAt = Date.now()
  let firstChunkAt: number | undefined
  let contentBlocksSeen = 0
  let textEventsSeen = 0
  let telemetryRecorded = false

  const recordTelemetry = (err?: Error): void => {
    if (telemetryRecorded) return
    telemetryRecorded = true
    const telemetryCtx = {
      requestMeta: shared.requestMeta,
      requestStartAt: env.requestStartAt,
      adapterName: shared.adapter.name,
    }
    if (err) {
      recordRequestError(telemetryCtx, classifyError(err.message))
      return
    }
    recordRequestSuccess(
      telemetryCtx,
      shared,
      handler,
      {
        mode: "stream",
        upstreamStartAt,
        firstChunkAt,
        sdkSessionId: state.ephemeralSessionId,
        contentBlocks: contentBlocksSeen,
        textEvents: textEventsSeen,
        passthrough: true,
      },
    )
  }

  const readable = new ReadableStream<Uint8Array>({
    async start(controller) {
      const safeEnqueue = (payload: Uint8Array): boolean => {
        if (streamClosed) return false
        try { controller.enqueue(payload); return true }
        catch (err) {
          if (isClosedControllerError(err)) { streamClosed = true; return false }
          throw err
        }
      }

      const closeHttp = () => {
        if (streamClosed) return
        streamClosed = true
        if (heartbeat) { clearInterval(heartbeat); heartbeat = undefined }
        try { controller.close() } catch {}
      }

      heartbeat = setInterval(() => {
        if (streamClosed) return
        safeEnqueue(encoder.encode(`: ping\n\n`))
      }, 15_000)
      heartbeat.unref?.()

      // Every HTTP round corresponds to exactly one SDK internal turn, and
      // the SDK's own `message_start` / `message_delta` frames already carry
      // real `msg_id`, `model`, and `usage`. We just pipe them through and
      // synthesise `message_stop` once the two-gate round closer fires.
      const deliver = (evt: BufferedEvent) => {
        if (streamClosed) { state.eventBuffer.push(evt); return }
        if (evt.kind === "sse") {
          if (firstChunkAt === undefined) firstChunkAt = Date.now()
          // Cheap event-type peek for approximate content_block / text counts.
          // Full parse would cost more than the telemetry is worth.
          const head = evt.frame.length >= 40
            ? new TextDecoder().decode(evt.frame.subarray(0, 40))
            : new TextDecoder().decode(evt.frame)
          if (head.startsWith("event: content_block_start")) contentBlocksSeen++
          else if (head.startsWith("event: content_block_delta")) textEventsSeen++
          safeEnqueue(evt.frame)
          return
        }
        if (evt.kind === "close_round") {
          safeEnqueue(makeMessageStopFrame(encoder))
          recordTelemetry()
          closeHttp()
          detachSink(state)
          return
        }
        if (evt.kind === "end") {
          safeEnqueue(makeMessageStopFrame(encoder))
          recordTelemetry()
          closeHttp()
          void blockingPool.release(key, `sdk_ended:${evt.reason}`)
          return
        }
        if (evt.kind === "error") {
          safeEnqueue(encoder.encode(`event: error\ndata: ${JSON.stringify({
            type: "error",
            error: { type: classifyError(evt.error.message).type, message: evt.error.message },
          })}\n\n`))
          recordTelemetry(evt.error)
          closeHttp()
          void blockingPool.release(key, "sdk_error")
          return
        }
      }

      attachSink(state, deliver)

      // Initial HTTP only: build and spawn the SDK consumer task.
      if (!isContinuation) {
        try {
          const iterator = await startSdkIterator(shared, handler, promptBundle, hooks, env)
          // Fire-and-forget: the consumer runs as long as the session is alive.
          void spawnConsumer(state, iterator, encoder)
        } catch (err) {
          const e = err instanceof Error ? err : new Error(String(err))
          pushEvent(state, { kind: "error", error: e })
        }
      }
    },
    cancel() {
      streamClosed = true
      if (heartbeat) { clearInterval(heartbeat); heartbeat = undefined }
      if (state.status !== "terminated") {
        detachSink(state)
        claudeLog("blocking.http.detached", {
          requestId: shared.requestMeta.requestId,
          reason: "client_cancel",
          pending: state.pendingTools.size,
        })
      }
      // Client disconnect still counts as a completed HTTP for telemetry.
      // Record as success — the proxy dispatched it correctly; the teardown
      // reason is visible in the log above.
      recordTelemetry()
    },
  })

  return new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Claude-Session-ID": stringifyBlockingKey(key),
    },
  })
}

/**
 * Build the SDK query options for the initial blocking request and return
 * its async iterator. The consumer task (in spawnConsumer) drains it.
 */
async function startSdkIterator(
  shared: SharedRequestContext,
  handler: HandlerContext,
  promptBundle: PromptBundle,
  hooks: HookBundle,
  env: ExecutorEnv,
): Promise<AsyncIterable<unknown>> {
  const { body, workingDirectory, systemContext, profileEnv, adapter, sdkAgents,
          thinking, effort, taskBudget, betas, outputFormat } = shared
  const { passthrough, sdkHooks, passthroughMcp, useBuiltinWebSearch, onStderr } = hooks
  const { makePrompt } = promptBundle

  const strippedEnv: Record<string, string | undefined> = { ...profileEnv }
  for (const k of CLAUDE_OAUTH_ENV_KEYS) delete strippedEnv[k]
  const oauthEnv = shared.profile.type === "api"
    ? {}
    : await resolveClaudeOauthEnv({
        configDir: shared.profile.env.CLAUDE_CONFIG_DIR ?? homedir(),
      })

  const { prompt, options } = buildQueryOptions({
    prompt: makePrompt(),
    model: shared.model,
    workingDirectory,
    systemContext,
    claudeExecutable: env.claudeExecutable,
    passthrough,
    stream: true,
    sdkAgents,
    passthroughMcp,
    cleanEnv: { ...strippedEnv, ...oauthEnv },
    resumeSessionId: handler.resumeSessionId ?? handler.freshSessionId,
    isUndo: handler.isUndo,
    undoRollbackUuid: handler.undoRollbackUuid,
    sdkHooks,
    adapter,
    outputFormat,
    thinking,
    useBuiltinWebSearch,
    maxOutputTokens: body.max_tokens,
    onStderr,
    effort,
    taskBudget,
    betas,
    blockingMode: true,
  })

  return query({ prompt, options })
}
