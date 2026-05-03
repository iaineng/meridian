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
import { envBool } from "../../env"
import { buildQueryOptions } from "../query"
import {
  resolveClaudeOauthEnv,
  CLAUDE_OAUTH_ENV_KEYS,
} from "../claudeOauthEnv"
import { isClosedControllerError } from "../models"
import { classifyError, buildErrorEnvelope, isMaxTurnsError, isMaxOutputTokensError } from "../errors"
import { PASSTHROUGH_MCP_PREFIX } from "../passthroughToolNames"
import {
  stripMcpPrefix,
  resolvePassthroughClientToolName,
  registerToolUseBinding,
  maybeCloseRound,
} from "../passthroughTools"
import { normalizeToolResultForMcp } from "../session/transcript"
import { computeMessageHashes } from "../session/lineage"
import { recordRequestSuccess, recordRequestError } from "./telemetry"
import {
  blockingPool,
  stringifyBlockingKey,
  type BlockingSessionKey,
  type BlockingSessionState,
  type BufferedEvent,
} from "../session/blockingPool"
import { createBlockingJsonAggregator } from "./blockingNonStreamAggregator"
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

/**
 * Bind the session's translator-affecting state to the initial HTTP's
 * hook bundle and shared context. The consumer task lives across all HTTPs
 * of one blocking session, so it reads from the array the SDK's PostToolUse
 * hook captures into — i.e. the one constructed for the *initial* HTTP.
 * Continuation HTTPs build new hook bundles that the SDK never sees (the
 * iterator is already running with the initial hooks installed), so binding
 * only makes sense once at session start.
 */
function bindTranslatorState(
  state: BlockingSessionState,
  hooks: HookBundle,
  outputFormat: SharedRequestContext["outputFormat"],
): void {
  state.useBuiltinWebSearch = hooks.useBuiltinWebSearch
  state.pendingWebSearchResults = hooks.pendingWebSearchResults
  state.outputFormatActive = !!outputFormat
  state.clientNameByMcpToolName = hooks.passthroughMcp?.clientNameByMcpToolName ?? new Map()
  state.clientNameByFullToolName = hooks.passthroughMcp?.clientNameByFullToolName ?? new Map()
}

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

/**
 * Per-HTTP frame telemetry: lazy `firstChunkAt`, plus cheap event-type peeks
 * for approximate content_block / text-delta counts. Identical for the
 * streaming and non-streaming sinks, so the bookkeeping lives here.
 *
 * The decoder is shared across calls — TextDecoder is stateless when used
 * with `Uint8Array` slices that don't span partial UTF-8.
 */
const FRAME_PEEK_DECODER = new TextDecoder()

interface FrameTelemetry {
  firstChunkAt: number | undefined
  contentBlocksSeen: number
  textEventsSeen: number
  observe(frame: Uint8Array): void
}

function createFrameTelemetry(): FrameTelemetry {
  const t: FrameTelemetry = {
    firstChunkAt: undefined,
    contentBlocksSeen: 0,
    textEventsSeen: 0,
    observe(frame: Uint8Array): void {
      if (t.firstChunkAt === undefined) t.firstChunkAt = Date.now()
      // Cheap event-type peek — full parse would cost more than the
      // telemetry is worth. 40 bytes covers `event: content_block_delta`.
      const head = frame.length >= 40
        ? FRAME_PEEK_DECODER.decode(frame.subarray(0, 40))
        : FRAME_PEEK_DECODER.decode(frame)
      if (head.startsWith("event: content_block_start")) t.contentBlocksSeen++
      else if (head.startsWith("event: content_block_delta")) t.textEventsSeen++
    },
  }
  return t
}

/**
 * Per-HTTP dispatcher prologue shared by `runBlockingStream` and
 * `runBlockingNonStream`. Either resolves the continuation's pending tool
 * handlers or wires the initial HTTP's hook bundle onto the session state,
 * then touches the pool entry so the janitor sees recent activity.
 */
function dispatchBlockingRound(
  shared: SharedRequestContext,
  handler: HandlerContext,
  hooks: HookBundle,
): { state: BlockingSessionState; key: BlockingSessionKey; isContinuation: boolean } {
  const isContinuation = handler.isBlockingContinuation
  const state = handler.blockingState!
  const key = handler.blockingSessionKey!

  if (isContinuation) {
    claudeLog("blocking.continuation.start", {
      requestId: shared.requestMeta.requestId,
      key: stringifyBlockingKey(key),
      resolving: handler.pendingToolResults?.length ?? 0,
    })
    applyContinuation(state, handler, shared)
  } else {
    // Bind hook references onto the session state so the consumer task /
    // translator can react to them across HTTP boundaries. The webSearchHook
    // (when registered) appends to `hooks.pendingWebSearchResults`; the
    // translator drains the same array on duplicate message_start.
    bindTranslatorState(state, hooks, shared.outputFormat)
    claudeLog("blocking.initial.start", {
      requestId: shared.requestMeta.requestId,
      key: stringifyBlockingKey(key),
    })
  }

  blockingPool.touch(state)
  return { state, key, isContinuation }
}

function pushEvent(state: BlockingSessionState, evt: BufferedEvent): void {
  if (state.status === "terminated") return
  const sink = state.activeSink
  if (sink) sink(evt)
  else state.eventBuffer.push(evt)
}

/**
 * Apply a continuation request to a live blocking session: route the
 * incoming `tool_result`s to their suspended MCP handlers and refresh the
 * `priorMessageHashes` baseline. Shared by `runBlockingStream` and
 * `runBlockingNonStream` — the routing semantics are identical regardless
 * of how the previous round's HTTP delivered the assistant turn.
 *
 * `handler.pendingToolResults` is already flattened into history order by
 * `extractContinuationTrailing`, so neither the split (`a, u, a, u, …`) nor
 * the bundled (`a, u, u, …`) trailing shape needs special handling here.
 *
 * Routing strategy:
 *   1. If the incoming `tool_use_id` happens to match a pending entry, use
 *      it (cheap/correct path when the client preserves SDK ids).
 *   2. Otherwise fall back to positional routing against
 *      `state.currentRoundToolIds` (which records ids in SDK emission
 *      order). Many clients rewrite or omit ids between rounds but
 *      preserve order.
 */
export function applyContinuation(
  state: BlockingSessionState,
  handler: HandlerContext,
  shared: SharedRequestContext,
): void {
  const orderedRoundIds = state.currentRoundToolIds.slice()
  const results = handler.pendingToolResults ?? []
  for (let i = 0; i < results.length; i++) {
    const tr = results[i]!
    let pending = (typeof tr.tool_use_id === "string")
      ? state.pendingTools.get(tr.tool_use_id)
      : undefined
    if (!pending) {
      const positionalId = orderedRoundIds[i]
      if (positionalId) pending = state.pendingTools.get(positionalId)
    }
    if (!pending) continue
    const mcpResult = normalizeToolResultForMcp(tr)
    try { pending.resolve(mcpResult) } catch {}
    state.pendingTools.delete(pending.toolUseId)
  }
  state.currentRoundToolIds = []
  state.pendingRoundClose = null
  state.status = "streaming"
  // Refresh the stored prior-hash baseline to the FULL allMessages of this
  // round — every message the client just delivered (including the trailing
  // assistant echoes and tool_result user(s)) is now confirmed prior. The
  // next round's `buildBlockingHandler` slices its trailing region as
  // `allMessages.slice(state.priorMessageHashes.length)`, which works for
  // both split (`a, u, a, u, …`) and bundled (`a, u, u, …`) shapes because
  // `extractContinuationTrailing` flattens either. Prefer the precomputed
  // hashes from the handler when available to avoid recomputing; the
  // fallback recompute must use the same `relaxedToolUseInput` flag the
  // handler used so the prefix shape stays consistent across rounds.
  const allMessages = shared.body?.messages ?? []
  if (allMessages.length >= 1) {
    const relaxed = envBool("BLOCKING_DRIFT_NAME_ONLY")
    state.priorMessageHashes = handler.allMessageHashes
      ?? computeMessageHashes(allMessages, relaxed ? { relaxedToolUseInput: true } : undefined)
  }
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

/**
 * Drain `state.pendingWebSearchResults` to synthetic SSE frames in the
 * `server_tool_use` + `web_search_tool_result` shape the Anthropic API
 * normally emits for hosted `web_search` calls. Used by the translator
 * when it sees a duplicate message_start (the SDK starts another
 * internal turn after running WebSearch as a client tool) and on round
 * close, mirroring `executor.ts`'s injection logic.
 *
 * Synthetic indices come from `state.nextClientBlockIndex` so they are
 * monotonically ordered with the surrounding real-block indices the
 * translator emits — no negative numbers, no per-turn index resets bleeding
 * through to the client.
 */
function drainWebSearchToFrames(
  state: BlockingSessionState,
  encoder: TextEncoder,
): Uint8Array[] {
  if (state.pendingWebSearchResults.length === 0) return []
  const frames: Uint8Array[] = []
  while (state.pendingWebSearchResults.length > 0) {
    const ws = state.pendingWebSearchResults.shift()!
    for (const result of ws.results) {
      const stuIdx = state.nextClientBlockIndex++
      frames.push(encoder.encode(
        `event: content_block_start\ndata: ${JSON.stringify({
          type: "content_block_start",
          index: stuIdx,
          content_block: {
            type: "server_tool_use",
            id: result.tool_use_id,
            name: "web_search",
            input: { query: ws.query },
          },
        })}\n\n`,
      ))
      frames.push(encoder.encode(
        `event: content_block_stop\ndata: ${JSON.stringify({
          type: "content_block_stop",
          index: stuIdx,
        })}\n\n`,
      ))

      const wstrIdx = state.nextClientBlockIndex++
      frames.push(encoder.encode(
        `event: content_block_start\ndata: ${JSON.stringify({
          type: "content_block_start",
          index: wstrIdx,
          content_block: {
            type: "web_search_tool_result",
            tool_use_id: result.tool_use_id,
            content: result.content.map((c) => ({
              type: "web_search_result",
              title: c.title,
              url: c.url,
              encrypted_content: "",
              page_age: null,
            })),
          },
        })}\n\n`,
      ))
      frames.push(encoder.encode(
        `event: content_block_stop\ndata: ${JSON.stringify({
          type: "content_block_stop",
          index: wstrIdx,
        })}\n\n`,
      ))
    }
  }
  return frames
}

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
    // New SDK turn → reset per-turn accumulators. The SDK restarts block
    // indices at 0 every turn but meridian merges turns into a single
    // client-visible message, so the per-turn `sdkToClientIndex` map MUST
    // clear here (its keys are SDK indices) while `nextClientBlockIndex`
    // (a monotonic counter into the merged message) keeps growing across
    // turns within one round. `lastEmittedAssistantBlocks` is NOT cleared
    // — the next continuation needs it for drift detection and it gets
    // overwritten when the SDK reaches `message_delta(stop_reason=tool_use)`.
    state.inputJsonAccum.clear()
    state.toolUseIdBySdkIdx.clear()
    state.webSearchSkipIndices.clear()
    state.structuredOutputIndices.clear()
    state.outputFormatTextSkipIndices.clear()
    state.sdkToClientIndex.clear()
    const startUsage = event.message?.usage as TokenUsage | undefined
    if (startUsage) state.cumulativeUsage = sumUsage(state.cumulativeUsage, startUsage)

    // Drain any captured WebSearch results into synthetic frames before
    // touching the message_start itself. The synthetic frames belong to the
    // round's accumulated content and inherit `nextClientBlockIndex`.
    const synthetic = drainWebSearchToFrames(state, encoder)

    if (state.messageStartEmittedThisRound) {
      // Subsequent SDK turn within one blocking round — coalesce into the
      // existing client-visible message: drop the dup `message_start` and
      // forward only the synthetic frames the previous turn produced via
      // its built-in WebSearch.
      frames.push(...synthetic)
      return frames
    }
    state.messageStartEmittedThisRound = true
    frames.push(encoder.encode(`event: message_start\ndata: ${JSON.stringify(event)}\n\n`))
    frames.push(...synthetic)
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
    // turn's content_block_start events (passthrough-prefixed only — the
    // built-in WebSearch tool_uses we suppress never enter
    // `state.toolUseIdBySdkIdx`). close_round will fire as soon as every
    // handler has registered its PendingTool (whichever gate edge
    // completes last) — the caller runs `maybeCloseRound` AFTER pushing
    // these frames to the sink. Calling it here would race: if handlers
    // are already pending, close_round would fire first, detach the sink,
    // then the message_delta frame returned from this function would miss
    // it and land in the buffer → delivered at the start of the next HTTP.
    const stopReason = event.delta?.stop_reason as string | undefined
    if (stopReason === "tool_use") {
      const expectedIds = new Set<string>()
      for (const [, v] of state.toolUseIdBySdkIdx) expectedIds.add(v.toolUseId)
      if (expectedIds.size === 0 && state.structuredOutputIndices.size > 0) {
        // Terminal StructuredOutput: the only "tool_use" this turn was the
        // schema-conformant payload, which we already translated to a
        // text block. The SDK will end shortly; rewrite stop_reason to
        // `end_turn` so the client treats this as the final response and
        // does NOT try to send back a tool_result. Round-close is NOT
        // armed — the natural SDK `end` event drives HTTP teardown. The
        // `outputFormatTerminalForwarded` flag suppresses the consumer's
        // synthetic finally-block frame so the client never sees two
        // terminal deltas.
        const rewritten = {
          ...event,
          delta: { ...event.delta, stop_reason: "end_turn" },
        }
        frames.push(encoder.encode(`event: message_delta\ndata: ${JSON.stringify(rewritten)}\n\n`))
        state.outputFormatTerminalForwarded = true
        return frames
      }
      if (expectedIds.size === 0
          && state.useBuiltinWebSearch
          && state.webSearchSkipIndices.size > 0) {
        // The turn ended with `stop_reason=tool_use` but every tool_use was
        // a suppressed built-in (WebSearch) — no client-callable tool was
        // emitted. Forwarding `message_delta(stop_reason=tool_use)` would
        // strand the client with an "act on the tool_use" signal that has
        // no corresponding tool_use block. Drop the frame; the SDK will
        // open a fresh internal turn whose final message_delta carries the
        // real terminal stop_reason.
        return frames
      }
      state.pendingRoundClose = { expectedIds }
      // Snapshot the assistant turn's tool_use blocks for the next
      // continuation's drift check. Only tool_use is tracked — text and
      // thinking blocks don't affect tool routing or SDK in-memory state,
      // and forcing exact text equality across server accumulation vs
      // client SSE-replay is too brittle. Sorted by SDK block index so the
      // order matches what the client received via SSE.
      state.lastEmittedAssistantBlocks = Array.from(state.toolUseIdBySdkIdx.entries())
        .sort((a, b) => a[0] - b[0])
        .map(([idx, tu]) => {
          const raw = state.inputJsonAccum.get(idx) ?? ""
          let input: unknown = {}
          if (raw) { try { input = JSON.parse(raw) } catch {} }
          return { type: "tool_use" as const, name: tu.toolName, input }
        })
    } else if (state.outputFormatActive
               && state.structuredOutputIndices.size === 0) {
      // outputFormat retry path: the SDK will (a) detect the model failed
      // to call StructuredOutput, (b) append a continuation directive,
      // and (c) re-prompt — opening a fresh internal turn that we'll
      // coalesce into the same client-visible message. Forwarding this
      // intermediate `end_turn` (or other non-tool_use stop_reason) would
      // make the client think the response is over before the recovered
      // StructuredOutput call has even happened. Buffer the latest delta
      // for usage tallying so spawnConsumer's finally block can synthesise
      // a terminal frame in the all-retries-exhausted path.
      state.outputFormatLastDelta = event
      return frames
    }
    frames.push(encoder.encode(`event: message_delta\ndata: ${JSON.stringify(event)}\n\n`))
    return frames
  }

  if (eventType === "content_block_start") {
    const block = event.content_block
    // Per-name dispatch for SDK-internal client tools (no MCP prefix means
    // it cannot be a passthrough/external tool — those are always prefixed
    // with `PASSTHROUGH_MCP_PREFIX`). blockingMode runs with maxTurns=10_000,
    // so suppression is never about saving rounds — it is always about
    // shaping the wire protocol the client expects.
    //
    //   * "WebSearch": the SDK runs it locally as a client tool, but the
    //     Anthropic wire shape for hosted web_search is
    //     `server_tool_use` + `web_search_tool_result`. Drop the regular
    //     tool_use here; the synthetic server-side pair is injected from
    //     `state.pendingWebSearchResults` on the next message_start (or at
    //     round close, see drainWebSearchToFrames).
    //   * "StructuredOutput": the SDK emits a tool_use whose `input_json`
    //     IS the schema-conformant payload. Translate to a `text` block so
    //     OpenAI-style consumers receive the JSON as text — content_block_delta
    //     rewrites `input_json_delta` → `text_delta` for indices in
    //     `structuredOutputIndices`.
    if (block?.type === "tool_use" && typeof block.name === "string") {
      if (state.useBuiltinWebSearch && block.name === "WebSearch") {
        if (eventIndex !== undefined) state.webSearchSkipIndices.add(eventIndex)
        return frames
      }
      if (state.outputFormatActive && block.name === "StructuredOutput") {
        const clientIndex = state.nextClientBlockIndex++
        if (eventIndex !== undefined) {
          state.sdkToClientIndex.set(eventIndex, clientIndex)
          state.structuredOutputIndices.add(eventIndex)
        }
        frames.push(encoder.encode(`event: content_block_start\ndata: ${JSON.stringify({
          ...event,
          index: clientIndex,
          content_block: { type: "text", text: "" },
        })}\n\n`))
        return frames
      }
    }
    // outputFormat: suppress raw `text` blocks the model emits alongside (or
    // instead of) StructuredOutput. The client requested a schema-conformant
    // structured payload only — any prose would mix two response shapes in
    // the same Anthropic Message. Mirrors executor.ts' non-blocking branch
    // (skipBlockIndices.add for text blocks under outputFormat). Indexes are
    // tracked so the matching content_block_delta / content_block_stop frames
    // are silenced too. This runs AFTER the StructuredOutput-as-text rewrite
    // above, which already returned, so we never suppress the translated
    // payload here.
    if (state.outputFormatActive && block?.type === "text") {
      if (eventIndex !== undefined) state.outputFormatTextSkipIndices.add(eventIndex)
      return frames
    }
    // Allocate a fresh client-block index. SDK indices restart at 0 every
    // turn but the client sees one merged Anthropic message per round;
    // mapping SDK → client here lets content_block_delta and
    // content_block_stop (below) re-route their frames consistently.
    const clientIndex = state.nextClientBlockIndex++
    if (eventIndex !== undefined) state.sdkToClientIndex.set(eventIndex, clientIndex)
    if (block?.type === "tool_use" && typeof block.name === "string" && block.name.startsWith(PASSTHROUGH_MCP_PREFIX)) {
      const mcpToolName = stripMcpPrefix(block.name)
      const clientName = resolvePassthroughClientToolName(block.name, state)
      if (block.id && typeof block.id === "string") {
        // Bind by the normalised local MCP name to match the handler's lookup
        // key in createBlockingPassthroughMcpServer. Using the client-visible
        // name here would strand the handler in consumeBinding.
        registerToolUseBinding(state, mcpToolName, { toolUseId: block.id, input: {} })
        if (eventIndex !== undefined) {
          state.toolUseIdBySdkIdx.set(eventIndex, { toolName: clientName, toolUseId: block.id })
          state.inputJsonAccum.set(eventIndex, "")
        }
      }
      frames.push(encoder.encode(`event: content_block_start\ndata: ${JSON.stringify({
        ...event,
        index: clientIndex,
        content_block: { ...block, name: clientName, input: {} },
      })}\n\n`))
      return frames
    }
    frames.push(encoder.encode(`event: content_block_start\ndata: ${JSON.stringify({
      ...event,
      index: clientIndex,
    })}\n\n`))
    return frames
  }

  if (eventType === "content_block_delta") {
    if (eventIndex !== undefined && state.webSearchSkipIndices.has(eventIndex)) return frames
    if (eventIndex !== undefined && state.outputFormatTextSkipIndices.has(eventIndex)) return frames
    if (eventIndex !== undefined) {
      const delta = event.delta
      if (delta?.type === "input_json_delta" && typeof delta.partial_json === "string"
          && state.inputJsonAccum.has(eventIndex)) {
        const prev = state.inputJsonAccum.get(eventIndex) ?? ""
        state.inputJsonAccum.set(eventIndex, prev + delta.partial_json)
      }
    }
    const clientIndex = eventIndex !== undefined ? state.sdkToClientIndex.get(eventIndex) : undefined
    if (clientIndex === undefined) return frames
    // StructuredOutput: rewrite the SDK's `input_json_delta` to a `text_delta`
    // whose text is the partial JSON. The block was emitted as `type: "text"`
    // at content_block_start, so deltas must follow text-block shape.
    let outEvent: any = event
    if (eventIndex !== undefined && state.structuredOutputIndices.has(eventIndex)) {
      const delta = event.delta
      if (delta?.type === "input_json_delta" && typeof delta.partial_json === "string") {
        outEvent = {
          ...event,
          delta: { type: "text_delta", text: delta.partial_json },
        }
      }
    }
    frames.push(encoder.encode(`event: content_block_delta\ndata: ${JSON.stringify({
      ...outEvent,
      index: clientIndex,
    })}\n\n`))
    return frames
  }

  if (eventType === "content_block_stop") {
    if (eventIndex !== undefined && state.webSearchSkipIndices.has(eventIndex)) return frames
    if (eventIndex !== undefined && state.outputFormatTextSkipIndices.has(eventIndex)) return frames
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
    const clientIndex = eventIndex !== undefined ? state.sdkToClientIndex.get(eventIndex) : undefined
    if (clientIndex === undefined) return frames
    frames.push(encoder.encode(`event: content_block_stop\ndata: ${JSON.stringify({
      ...event,
      index: clientIndex,
    })}\n\n`))
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
    // Drain stragglers — if the very last SDK turn ran a built-in WebSearch
    // and then `end_turn`-ed without opening another internal turn, the
    // hook's capture would otherwise be stranded in the buffer. Inject the
    // synthetic frames into the round before the terminal `end` event so
    // the client's final message includes the full WebSearch trail.
    const trailing = drainWebSearchToFrames(state, encoder)
    for (const f of trailing) pushEvent(state, { kind: "sse", frame: f })
    // outputFormat: the translator buffered every intermediate
    // `message_delta` whose stop_reason was non-tool_use (SDK retry
    // attempts) so the client never saw a premature `end_turn`. If we
    // also never reached the StructuredOutput-emission rewrite that
    // forwards a terminal frame on its own (`outputFormatTerminalForwarded`),
    // synthesise one here from the buffered delta so the client always
    // gets exactly one terminal `end_turn`. Mirrors executor.ts:996-1009.
    if (state.outputFormatActive && !state.outputFormatTerminalForwarded) {
      const buffered = state.outputFormatLastDelta
      const usage = (buffered && (buffered as Record<string, unknown>).usage)
        ?? { output_tokens: 0 }
      const synthFrame = encoder.encode(`event: message_delta\ndata: ${JSON.stringify({
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage,
      })}\n\n`)
      pushEvent(state, { kind: "sse", frame: synthFrame })
      state.outputFormatTerminalForwarded = true
    }
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
  // For a continuation request, `dispatchBlockingRound` resolves the
  // suspended handlers BEFORE we build the new HTTP ReadableStream. The
  // consumer task (spawned on the initial HTTP) will unblock and start
  // feeding new SSE frames into the event buffer; they'll be flushed when
  // the sink attaches.
  const { state, key, isContinuation } = dispatchBlockingRound(shared, handler, hooks)

  let streamClosed = false
  let heartbeat: ReturnType<typeof setInterval> | undefined

  // Per-HTTP telemetry bookkeeping. Each call to runBlockingStream is one
  // request from the client's perspective and must produce exactly one
  // telemetry record, regardless of whether the HTTP ends via close_round
  // (round boundary), end (SDK finished), error, or client cancel.
  const upstreamStartAt = Date.now()
  const frameTelemetry = createFrameTelemetry()
  let telemetryRecorded = false

  const recordTelemetry = (err?: Error): void => {
    if (telemetryRecorded) return
    telemetryRecorded = true
    const telemetryCtx = {
      requestMeta: shared.requestMeta,
      requestStartAt: env.requestStartAt,
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
        firstChunkAt: frameTelemetry.firstChunkAt,
        sdkSessionId: state.ephemeralSessionId,
        contentBlocks: frameTelemetry.contentBlocksSeen,
        textEvents: frameTelemetry.textEventsSeen,
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
          frameTelemetry.observe(evt.frame)
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
          void blockingPool.release(state, `sdk_ended:${evt.reason}`)
          return
        }
        if (evt.kind === "error") {
          safeEnqueue(encoder.encode(
            `event: error\ndata: ${JSON.stringify(buildErrorEnvelope(evt.error.message).body)}\n\n`,
          ))
          recordTelemetry(evt.error)
          closeHttp()
          void blockingPool.release(state, "sdk_error")
          return
        }
      }

      attachSink(state, deliver)

      // Initial HTTP only: build and spawn the SDK consumer task.
      if (!isContinuation) {
        // Wire the abort controller onto the session BEFORE starting the SDK
        // iterator so that `blockingPool.release` — which fires on SIGTERM,
        // janitor timeout, continuation mismatch, etc. — can kill the Claude
        // subprocess before we reject pending MCP handlers. Without this,
        // rejected handlers serialise error CallToolResults over the stdio
        // transport to a still-alive subprocess, which then posts a tool_result
        // to the API (billable) whose response we immediately discard.
        const abortController = new AbortController()
        state.abort = () => {
          try { abortController.abort() } catch {}
        }
        try {
          const iterator = await startSdkIterator(shared, handler, promptBundle, hooks, env, abortController)
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
  abortController: AbortController,
): Promise<AsyncIterable<unknown>> {
  const { body, workingDirectory, systemContext, profileEnv,
          thinking, effort, taskBudget, outputFormat } = shared
  const { sdkHooks, passthroughMcp, useBuiltinWebSearch, onStderr } = hooks
  const { makePrompt } = promptBundle

  const strippedEnv: Record<string, string | undefined> = { ...profileEnv }
  for (const k of CLAUDE_OAUTH_ENV_KEYS) delete strippedEnv[k]
  const oauthEnv = await resolveClaudeOauthEnv({
    configDir: shared.profile.env.CLAUDE_CONFIG_DIR ?? homedir(),
  })

  const { prompt, options } = buildQueryOptions({
    prompt: makePrompt(),
    model: shared.model,
    workingDirectory,
    systemContext,
    claudeExecutable: env.claudeExecutable,
    passthroughMcp,
    cleanEnv: { ...strippedEnv, ...oauthEnv },
    // Query-direct skips JSONL prewrite — must NOT pass resume to the SDK.
    resumeSessionId: handler.isQueryDirect ? undefined : handler.freshSessionId,
    sdkHooks,
    outputFormat,
    thinking,
    useBuiltinWebSearch,
    maxOutputTokens: body.max_tokens,
    onStderr,
    effort,
    taskBudget,
    abortController,
  })

  return query({ prompt, options })
}

/**
 * Non-streaming blocking entrypoint. Counterpart to `runBlockingStream`:
 * shares the same pool, state machine, consumer task, and `BufferedEvent`
 * stream — only the sink is different. Aggregates SSE frames into a single
 * Anthropic-format JSON Message and resolves the HTTP with it at
 * `close_round` (round end with `stop_reason:"tool_use"`) or `end` (SDK
 * terminated). Errors return as a JSON error envelope using the HTTP status
 * code from `classifyError` (e.g. 400 for `invalid_request_error`, 429 for
 * rate limits) — clients can freely alternate `stream:true`/`stream:false`
 * across rounds; the streaming counterpart still reports the same error via
 * an `event: error` SSE frame because its HTTP status is locked at 200 once
 * the response stream has started.
 */
export async function runBlockingNonStream(
  shared: SharedRequestContext,
  handler: HandlerContext,
  promptBundle: PromptBundle,
  hooks: HookBundle,
  env: ExecutorEnv,
): Promise<Response> {
  const { state, key, isContinuation } = dispatchBlockingRound(shared, handler, hooks)

  const upstreamStartAt = Date.now()
  const frameTelemetry = createFrameTelemetry()
  let telemetryRecorded = false

  const aggregator = createBlockingJsonAggregator()

  return await new Promise<Response>((resolveResponse) => {
    let closed = false

    const recordTelemetry = (err?: Error): void => {
      if (telemetryRecorded) return
      telemetryRecorded = true
      const telemetryCtx = {
        requestMeta: shared.requestMeta,
        requestStartAt: env.requestStartAt,
      }
      if (err) {
        recordRequestError(telemetryCtx, classifyError(err.message))
        return
      }
      recordRequestSuccess(telemetryCtx, shared, handler, {
        mode: "non-stream",
        upstreamStartAt,
        firstChunkAt: frameTelemetry.firstChunkAt,
        sdkSessionId: state.ephemeralSessionId,
        contentBlocks: frameTelemetry.contentBlocksSeen,
        textEvents: frameTelemetry.textEventsSeen,
      })
    }

    const finalize = (err?: Error): void => {
      if (closed) return
      closed = true
      detachSink(state)
      recordTelemetry(err)
      const envelope = err ? buildErrorEnvelope(err.message) : undefined
      const body = envelope ? envelope.body : aggregator.build(shared.body.model)
      resolveResponse(new Response(JSON.stringify(body), {
        status: envelope?.status ?? 200,
        headers: {
          "Content-Type": "application/json",
          "X-Claude-Session-ID": stringifyBlockingKey(key),
        },
      }))
    }

    const deliver = (evt: BufferedEvent): void => {
      // After finalize: keep replaying into the buffer so the next HTTP
      // attaches to a fresh sink that picks up exactly where we left off.
      if (closed) { state.eventBuffer.push(evt); return }
      if (evt.kind === "sse") {
        frameTelemetry.observe(evt.frame)
        aggregator.consumeSseFrame(evt.frame)
        return
      }
      if (evt.kind === "close_round") {
        finalize()
        return
      }
      if (evt.kind === "end") {
        aggregator.markEnd(evt.reason)
        finalize()
        void blockingPool.release(state, `sdk_ended:${evt.reason}`)
        return
      }
      if (evt.kind === "error") {
        finalize(evt.error)
        void blockingPool.release(state, "sdk_error")
        return
      }
    }

    attachSink(state, deliver)

    // Initial HTTP only: build and spawn the SDK consumer task.
    if (!isContinuation) {
      const abortController = new AbortController()
      state.abort = () => {
        try { abortController.abort() } catch {}
      }
      startSdkIterator(shared, handler, promptBundle, hooks, env, abortController)
        .then((iterator) => { void spawnConsumer(state, iterator, new TextEncoder()) })
        .catch((err) => {
          const e = err instanceof Error ? err : new Error(String(err))
          pushEvent(state, { kind: "error", error: e })
        })
    }
  })
}
