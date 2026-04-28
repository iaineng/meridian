import { homedir } from "node:os"
import { query } from "@anthropic-ai/claude-agent-sdk"
import { claudeLog } from "../../logger"
import { buildQueryOptions } from "../query"
import {
  classifyError,
  buildErrorEnvelope,
  isStaleSessionError,
  isRateLimitError,
  isMaxTurnsError,
  isMaxOutputTokensError,
  isExtraUsageRequiredError,
  isExpiredTokenError,
} from "../errors"
import { refreshOAuthToken } from "../tokenRefresh"
import {
  resolveClaudeOauthEnv,
  invalidateClaudeOauthEnvCache,
  CLAUDE_OAUTH_ENV_KEYS,
} from "../claudeOauthEnv"
import {
  hasExtendedContext,
  stripExtendedContext,
  isClosedControllerError,
} from "../models"
import { stripMcpPrefix, PASSTHROUGH_MCP_PREFIX } from "../passthroughTools"
import {
  extractFileChangesFromMessages,
  formatFileChangeSummary,
} from "../fileChanges"
import type { SharedRequestContext } from "./context"
import type { HandlerContext } from "../handlers/types"
import type { HookBundle } from "./hooks"
import type { PromptBundle } from "./prompt"
import type { TokenUsage } from "../session/lineage"
import { logUsage, recordRequestSuccess } from "./telemetry"

/**
 * Callbacks for classic-path session lifecycle. Ephemeral supplies {} so
 * stale-session retries surface as errors and completion skips `storeSession`.
 */
export interface ExecutorCallbacks {
  onStaleSession?: (args: {
    sdkUuidMap: Array<string | null>
    mode: "stream" | "non_stream"
  }) => Promise<{
    prompt: string | AsyncIterable<any>
    resumeSessionId: string | undefined
  }>
  onComplete?: (
    sdkSessionId: string | undefined,
    sdkUuidMap: Array<string | null>,
    usage: TokenUsage | undefined,
  ) => void
}

export interface ExecutorEnv {
  claudeExecutable: string
  requestStartAt: number
}

/**
 * Seed the SDK UUID map from (in priority): cached session UUIDs (resume),
 * fresh JSONL-prewarm UUIDs (diverged), or an empty array. Pads to
 * `allMessages.length` with `null` for the trailing user message.
 */
function buildSdkUuidMapSeed(
  handler: HandlerContext,
  allMessages: any[],
): Array<string | null> {
  const seed: Array<string | null> = handler.cachedSession?.sdkMessageUuids
    ? [...handler.cachedSession.sdkMessageUuids]
    : handler.freshMessageUuids
      ? [...handler.freshMessageUuids]
      : new Array(allMessages.length - 1).fill(null)
  while (seed.length < allMessages.length) seed.push(null)
  return seed
}

/**
 * Wrap the SDK query in a retry loop that handles:
 * - rate limits (backoff + [1m] strip)
 * - extra_usage_required ([1m] strip + 1h cooldown)
 * - expired OAuth (single refresh + retry)
 * - stale session (classic-only, via callbacks.onStaleSession)
 *
 * Yields SDK events. Mutates `shared.model` on fallback.
 *
 * `didYieldContent` gates retries: once any `stream_event` has been yielded,
 * the response is considered committed and errors surface to the caller.
 */
async function* runSdkQueryWithRetry(
  shared: SharedRequestContext,
  handler: HandlerContext,
  promptBundle: PromptBundle,
  hooks: HookBundle,
  callbacks: ExecutorCallbacks,
  env: ExecutorEnv,
  mode: "stream" | "non_stream",
  sdkUuidMap: Array<string | null>,
): AsyncGenerator<any> {
  const {
    body, workingDirectory, systemContext, profileEnv, adapter, sdkAgents,
    thinking, effort, taskBudget, betas, outputFormat, requestMeta,
  } = shared
  const { resumeSessionId, freshSessionId, isUndo, undoRollbackUuid, isQueryDirect } = handler
  // Query-direct lone-user path: meridian did not write a JSONL — passing
  // any resume id would crash the SDK with "No conversation found". Force
  // the SDK to start a fresh session instead.
  const effectiveResumeSessionId = isQueryDirect ? undefined : (resumeSessionId ?? freshSessionId)
  const { passthrough, sdkHooks, passthroughMcp, useBuiltinWebSearch, onStderr } = hooks
  const { makePrompt } = promptBundle
  const { claudeExecutable } = env

  const MAX_RATE_LIMIT_RETRIES = 2
  const RATE_LIMIT_BASE_DELAY_MS = 1000

  let rateLimitRetries = 0
  let tokenRefreshed = false

  const baseOpts = async () => {
    // Strip the 5 OAuth env keys from the parent-inherited env so a stale
    // `CLAUDE_CODE_*` value (e.g. from the Meridian process itself being
    // launched by Claude Code) can never leak into the subprocess. The
    // resolver below re-supplies them for claude-max profiles; api profiles
    // get none — intentional, since they authenticate via ANTHROPIC_API_KEY.
    const strippedEnv: Record<string, string | undefined> = { ...profileEnv }
    for (const k of CLAUDE_OAUTH_ENV_KEYS) delete strippedEnv[k]

    const oauthEnv = shared.profile.type === "api"
      ? {}
      : await resolveClaudeOauthEnv({
          configDir: shared.profile.env.CLAUDE_CONFIG_DIR ?? homedir(),
        })
    return {
      model: shared.model,
      workingDirectory,
      systemContext,
      claudeExecutable,
      passthrough,
      stream: true as const,
      sdkAgents,
      passthroughMcp,
      cleanEnv: { ...strippedEnv, ...oauthEnv },
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
    }
  }

  while (true) {
    let didYieldContent = false
    try {
      for await (const event of query(buildQueryOptions({
        ...(await baseOpts()),
        prompt: makePrompt(),
        resumeSessionId: effectiveResumeSessionId,
        isUndo,
        undoRollbackUuid,
      }))) {
        if ((event as any).type === "stream_event") didYieldContent = true
        yield event
      }
      return
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error)

      if (passthrough && isMaxTurnsError(errMsg)) return
      if (isMaxOutputTokensError(errMsg)) return
      if (didYieldContent) throw error

      // Stale-session retry is classic-only. Ephemeral has no session cache
      // to evict, so `onStaleSession === undefined` surfaces the error.
      if (isStaleSessionError(error) && callbacks.onStaleSession) {
        const retry = await callbacks.onStaleSession({ sdkUuidMap, mode })
        yield* query(buildQueryOptions({
          ...(await baseOpts()),
          prompt: retry.prompt,
          resumeSessionId: retry.resumeSessionId,
          isUndo: false,
          undoRollbackUuid: undefined,
        }))
        return
      }

      if (isExtraUsageRequiredError(errMsg) && hasExtendedContext(shared.model)) {
        const from = shared.model
        shared.model = stripExtendedContext(shared.model)
        claudeLog("upstream.context_fallback", {
          mode,
          from,
          to: shared.model,
          reason: "extra_usage_required",
        })
        console.error(`[PROXY] ${requestMeta.requestId} extra usage required for [1m], falling back to ${shared.model}`)
        continue
      }

      if (isExpiredTokenError(errMsg) && !tokenRefreshed) {
        tokenRefreshed = true
        const refreshed = await refreshOAuthToken()
        if (refreshed) {
          // Drop the cached OAuth env so the retry picks up the new access
          // token instead of waiting for the 30s TTL to expire.
          invalidateClaudeOauthEnvCache()
          claudeLog("token_refresh.retrying", { mode })
          console.error(`[PROXY] ${requestMeta.requestId} OAuth token expired — refreshed, retrying`)
          continue
        }
      }

      if (isRateLimitError(errMsg)) {
        if (hasExtendedContext(shared.model)) {
          const from = shared.model
          shared.model = stripExtendedContext(shared.model)
          claudeLog("upstream.context_fallback", {
            mode,
            from,
            to: shared.model,
            reason: "rate_limit",
          })
          console.error(`[PROXY] ${requestMeta.requestId} rate-limited on [1m], retrying with ${shared.model}`)
          continue
        }
        if (rateLimitRetries < MAX_RATE_LIMIT_RETRIES) {
          rateLimitRetries++
          const delay = RATE_LIMIT_BASE_DELAY_MS * Math.pow(2, rateLimitRetries - 1)
          claudeLog("upstream.rate_limit_backoff", {
            mode,
            model: shared.model,
            attempt: rateLimitRetries,
            maxAttempts: MAX_RATE_LIMIT_RETRIES,
            delayMs: delay,
          })
          console.error(`[PROXY] ${requestMeta.requestId} rate-limited on ${shared.model}, retry ${rateLimitRetries}/${MAX_RATE_LIMIT_RETRIES} in ${delay}ms`)
          await new Promise(r => setTimeout(r, delay))
          continue
        }
      }

      throw error
    }
  }
}

/**
 * Pseudo non-stream path. Uses `stream: true` internally to reuse the
 * streaming event model (clean max_tokens handling, no SDK triple-retry),
 * then reassembles events into a single Anthropic-format JSON response.
 */
export async function runNonStream(
  shared: SharedRequestContext,
  handler: HandlerContext,
  promptBundle: PromptBundle,
  hooks: HookBundle,
  callbacks: ExecutorCallbacks,
  env: ExecutorEnv,
): Promise<Response> {
  // Blocking-MCP non-stream path: same pool/state machine as the streaming
  // entrypoint, only the sink aggregates SSE frames into a JSON Message.
  // Lazy import to mirror the streaming side and avoid load-time circularity.
  if (handler.blockingMode) {
    const { runBlockingNonStream } = require("./blockingStream") as typeof import("./blockingStream")
    return runBlockingNonStream(shared, handler, promptBundle, hooks, env)
  }
  const { body, adapter, outputFormat, requestMeta, allMessages } = shared
  const { resumeSessionId } = handler
  const {
    passthrough, useBuiltinWebSearch,
    capturedToolUses, fileChanges, trackFileChanges, pendingWebSearchResults,
    stderrLines,
  } = hooks

  const contentBlocks: Array<Record<string, unknown>> = []
  const upstreamStartAt = Date.now()
  let firstChunkAt: number | undefined
  let currentSessionId: string | undefined
  let messageId: string | undefined

  let stopReason = "end_turn"
  // Usage: message_start carries the full shape (input_tokens, cache_creation,
  // service_tier, inference_geo); message_delta carries output_tokens only.
  // We capture `baseUsage` from message_start and overlay output_tokens
  // from message_delta, merging both at the end for `persistClassicSession`.
  let baseUsage: Record<string, unknown> = {}
  let finalOutputTokens = 0
  let lastUsage: TokenUsage | undefined
  const skipBlockIndices = new Set<number>()
  const sdkIndexToContentIdx = new Map<number, number>()
  const jsonBuffers = new Map<number, string>()

  const structuredOutputIds = new Set<string>()
  const structuredOutputIndices = new Set<number>()

  const sdkUuidMap = buildSdkUuidMapSeed(handler, allMessages)

  claudeLog("upstream.start", { mode: "non_stream", model: shared.model })

  try {
    const response = runSdkQueryWithRetry(
      shared, handler, promptBundle, hooks, callbacks, env, "non_stream", sdkUuidMap,
    )

    for await (const message of response) {
      if ((message as any).session_id) {
        currentSessionId = (message as any).session_id
      }
      if (message.type === "assistant" && (message as any).uuid) {
        sdkUuidMap.push((message as any).uuid)
      }

      if (message.type !== "stream_event") continue

      if (!firstChunkAt) {
        firstChunkAt = Date.now()
        claudeLog("upstream.first_chunk", {
          mode: "non_stream",
          model: shared.model,
          ttfbMs: firstChunkAt - upstreamStartAt,
        })
      }

      const event = (message as any).event
      const eventType = (event as any).type as string
      const eventIndex = (event as any).index as number | undefined

      if (eventType === "message_start") {
        if (!messageId) {
          messageId = (event as any).message?.id
          const startUsage = (event as any).message?.usage
          if (startUsage && typeof startUsage === "object") {
            baseUsage = { ...startUsage }
          }
        }
        // Always reset per-turn index tracking — previous-turn indices are
        // stale and would incorrectly skip new-turn blocks.
        skipBlockIndices.clear()
        sdkIndexToContentIdx.clear()
        continue
      }

      if (eventType === "message_stop") continue

      if (eventType === "content_block_start") {
        const block = { ...(event as any).content_block } as Record<string, unknown>

        if (outputFormat) {
          if (block.type === "tool_use" && block.name === "StructuredOutput") {
            if (structuredOutputIds.size > 0) {
              if (eventIndex !== undefined) skipBlockIndices.add(eventIndex)
              continue
            }
            if (block.id) structuredOutputIds.add(block.id as string)
            if (eventIndex !== undefined) structuredOutputIndices.add(eventIndex)
            contentBlocks.push({ type: "text", text: "" })
            if (eventIndex !== undefined) sdkIndexToContentIdx.set(eventIndex, contentBlocks.length - 1)
            continue
          } else if (block.type === "text") {
            if (eventIndex !== undefined) skipBlockIndices.add(eventIndex)
            continue
          }
        }

        if (block.type === "tool_use" && typeof block.name === "string") {
          if (passthrough && (block.name as string).startsWith(PASSTHROUGH_MCP_PREFIX)) {
            block.name = stripMcpPrefix(block.name as string)
          } else if ((block.name as string).startsWith("mcp__")) {
            if (eventIndex !== undefined) skipBlockIndices.add(eventIndex)
            continue
          } else if (useBuiltinWebSearch) {
            if (eventIndex !== undefined) skipBlockIndices.add(eventIndex)
            continue
          }
        }

        contentBlocks.push(block)
        if (eventIndex !== undefined) sdkIndexToContentIdx.set(eventIndex, contentBlocks.length - 1)
        continue
      }

      if (eventIndex !== undefined && skipBlockIndices.has(eventIndex)) continue

      if (eventType === "content_block_delta") {
        const delta = (event as any).delta
        if (eventIndex === undefined) continue
        const blockIdx = sdkIndexToContentIdx.get(eventIndex)
        if (blockIdx === undefined) continue

        if (outputFormat && structuredOutputIndices.has(eventIndex)) {
          if (delta?.type === "input_json_delta" && delta.partial_json) {
            (contentBlocks[blockIdx] as any).text += delta.partial_json
          }
        } else if (delta?.type === "text_delta" && delta.text) {
          (contentBlocks[blockIdx] as any).text += delta.text
        } else if (delta?.type === "input_json_delta" && delta.partial_json) {
          const buf = jsonBuffers.get(eventIndex) ?? ""
          jsonBuffers.set(eventIndex, buf + delta.partial_json)
        } else if (delta?.type === "thinking_delta" && delta.thinking) {
          (contentBlocks[blockIdx] as any).thinking += delta.thinking
        } else if (delta?.type === "signature_delta" && delta.signature) {
          (contentBlocks[blockIdx] as any).signature += delta.signature
        }
        continue
      }

      if (eventType === "content_block_stop") {
        if (eventIndex !== undefined && jsonBuffers.has(eventIndex)) {
          const blockIdx = sdkIndexToContentIdx.get(eventIndex)
          if (blockIdx !== undefined) {
            try {
              (contentBlocks[blockIdx] as any).input = JSON.parse(jsonBuffers.get(eventIndex)!)
            } catch {
              // malformed JSON — keep empty input from content_block_start
            }
          }
          jsonBuffers.delete(eventIndex)
        }
        continue
      }

      if (eventType === "message_delta") {
        const deltaStopReason = (event as any).delta?.stop_reason as string | undefined
        const deltaUsage = (event as any).usage
        if (deltaUsage?.output_tokens != null) {
          finalOutputTokens = deltaUsage.output_tokens as number
        }
        if (deltaUsage) lastUsage = { ...lastUsage, ...deltaUsage }

        if (outputFormat) continue

        if (deltaStopReason === "max_tokens") {
          stopReason = "max_tokens"
          break
        }

        if (deltaStopReason === "tool_use" && (skipBlockIndices.size > 0 || useBuiltinWebSearch)) {
          continue
        }

        if (deltaStopReason) stopReason = deltaStopReason
      }
    }

    claudeLog("upstream.completed", {
      mode: "non_stream",
      model: shared.model,
      durationMs: Date.now() - upstreamStartAt,
    })
    if (lastUsage) logUsage(requestMeta.requestId, lastUsage)
  } catch (error) {
    const stderrOutput = stderrLines.join("\n").trim()
    if (stderrOutput && error instanceof Error && !error.message.includes(stderrOutput)) {
      error.message = `${error.message}\nSubprocess stderr: ${stderrOutput}`
    }
    claudeLog("upstream.failed", {
      mode: "non_stream",
      model: shared.model,
      durationMs: Date.now() - upstreamStartAt,
      error: error instanceof Error ? error.message : String(error),
      ...(stderrOutput ? { stderr: stderrOutput } : {}),
    })
    throw error
  }

  // In passthrough mode, add captured tool_use blocks from the hook
  // (the SDK may not include them in content after blocking).
  if (passthrough && capturedToolUses.length > 0) {
    for (const tu of capturedToolUses) {
      if (outputFormat && tu.name === "StructuredOutput") continue
      if (!contentBlocks.some((b) => b.type === "tool_use" && (b as any).id === tu.id)) {
        contentBlocks.push({
          type: "tool_use",
          id: tu.id,
          name: tu.name,
          input: tu.input,
        })
      }
    }
  }

  // Prepend synthetic WebSearch blocks (server_tool_use + web_search_tool_result)
  // captured from the PostToolUse hook into the non-stream response.
  if (pendingWebSearchResults.length > 0) {
    const syntheticBlocks: Array<Record<string, unknown>> = []
    while (pendingWebSearchResults.length > 0) {
      const ws = pendingWebSearchResults.shift()!
      for (const result of ws.results) {
        syntheticBlocks.push({
          type: "server_tool_use",
          id: result.tool_use_id,
          name: "web_search",
          input: { query: ws.query },
        })
        syntheticBlocks.push({
          type: "web_search_tool_result",
          tool_use_id: result.tool_use_id,
          content: result.content.map((c: { title: string; url: string }) => ({
            type: "web_search_result",
            title: c.title,
            url: c.url,
            encrypted_content: "",
            page_age: null,
          })),
        })
      }
    }
    contentBlocks.unshift(...syntheticBlocks)
  }

  // Safety fallback: if a StructuredOutput tool_use block still exists,
  // convert it to a text block.
  if (outputFormat) {
    const structuredBlock = contentBlocks.find(
      (b) => b.type === "tool_use" && b.name === "StructuredOutput",
    )
    if (structuredBlock) {
      const jsonText = JSON.stringify((structuredBlock as Record<string, unknown>).input)
      contentBlocks.length = 0
      contentBlocks.push({ type: "text", text: jsonText })
    }
  }

  const hasToolUse = contentBlocks.some((b) => b.type === "tool_use")
  const finalStopReason = stopReason === "end_turn" && hasToolUse ? "tool_use" : stopReason

  if (trackFileChanges) {
    if (passthrough && finalStopReason === "end_turn" && adapter.extractFileChangesFromToolUse) {
      const passthroughChanges = extractFileChangesFromMessages(
        body.messages || [],
        adapter.extractFileChangesFromToolUse.bind(adapter),
      )
      fileChanges.push(...passthroughChanges)
    }
    const fileChangeSummary = formatFileChangeSummary(fileChanges)
    if (fileChangeSummary) {
      const lastTextBlock = [...contentBlocks].reverse().find((b) => b.type === "text")
      if (lastTextBlock) {
        lastTextBlock.text = (lastTextBlock.text as string) + fileChangeSummary
      } else {
        contentBlocks.push({ type: "text", text: fileChangeSummary.trimStart() })
      }
      claudeLog("response.file_changes", { mode: "non_stream", count: fileChanges.length })
    }
  }

  const totalDurationMs = Date.now() - env.requestStartAt

  claudeLog("response.completed", {
    mode: "non_stream",
    model: shared.model,
    durationMs: totalDurationMs,
    contentBlocks: contentBlocks.length,
    hasToolUse,
  })

  recordRequestSuccess(
    { requestMeta, requestStartAt: env.requestStartAt, adapterName: adapter.name },
    shared,
    handler,
    {
      mode: "non-stream",
      upstreamStartAt,
      firstChunkAt,
      sdkSessionId: currentSessionId || resumeSessionId,
      contentBlocks: contentBlocks.length,
      textEvents: 0,
      passthrough,
    },
  )

  // Merge baseUsage (message_start) with lastUsage (message_delta) for
  // complete context-usage tracking on the stored session. `baseUsage` is
  // initialized to `{}` so the truthy check alone would always pass —
  // guard on key count instead.
  const hasBaseUsage = Object.keys(baseUsage).length > 0
  const mergedUsage: TokenUsage | undefined = (hasBaseUsage || lastUsage)
    ? ({ ...baseUsage, ...lastUsage } as TokenUsage)
    : undefined
  callbacks.onComplete?.(currentSessionId, sdkUuidMap, mergedUsage)

  const responseSessionId = currentSessionId || resumeSessionId || `session_${Date.now()}`

  return new Response(JSON.stringify({
    id: messageId || `msg_${Date.now()}`,
    type: "message",
    role: "assistant",
    content: contentBlocks,
    model: body.model,
    stop_reason: finalStopReason,
    usage: { ...baseUsage, output_tokens: finalOutputTokens },
  }), {
    headers: {
      "Content-Type": "application/json",
      "X-Claude-Session-ID": responseSessionId,
    },
  })
}

/**
 * Streaming SSE path. Wraps the SDK query in a ReadableStream, translating
 * SDK events to Anthropic SSE format in real time. Deferred cleanup fires
 * from the stream's own finally block after the SDK subprocess has exited.
 */
export function runStream(
  shared: SharedRequestContext,
  handler: HandlerContext,
  promptBundle: PromptBundle,
  hooks: HookBundle,
  callbacks: ExecutorCallbacks,
  env: ExecutorEnv,
  cleanupEphemeral: () => Promise<void>,
): Response {
  // Blocking-MCP path: delegates to a dedicated streaming pipeline that keeps
  // the SDK iterator alive across multiple HTTP requests.
  if (handler.blockingMode) {
    // cleanupEphemeral is handled inside the blocking pool; the handler
    // itself supplies a no-op cleanup and the pool release fires the real
    // one when the session terminates.
    void cleanupEphemeral
    // Lazy import to avoid circularity at module load.
    const { runBlockingStream } = require("./blockingStream") as typeof import("./blockingStream")
    return runBlockingStream(shared, handler, promptBundle, hooks, env)
  }
  const { body, adapter, outputFormat, requestMeta, allMessages } = shared
  const { resumeSessionId } = handler
  const {
    passthrough, useBuiltinWebSearch,
    capturedToolUses, fileChanges, trackFileChanges, pendingWebSearchResults,
    stderrLines,
  } = hooks

  const encoder = new TextEncoder()
  const readable = new ReadableStream({
    async start(controller) {
      const upstreamStartAt = Date.now()
      let firstChunkAt: number | undefined
      let heartbeatCount = 0
      let streamEventsSeen = 0
      let eventsForwarded = 0
      let textEventsForwarded = 0
      let bytesSent = 0
      let streamClosed = false

      claudeLog("upstream.start", { mode: "stream", model: shared.model })

      const safeEnqueue = (payload: Uint8Array, source: string): boolean => {
        if (streamClosed) return false
        try {
          controller.enqueue(payload)
          bytesSent += payload.byteLength
          return true
        } catch (error) {
          if (isClosedControllerError(error)) {
            streamClosed = true
            claudeLog("stream.client_closed", { source, streamEventsSeen, eventsForwarded })
            return false
          }

          claudeLog("stream.enqueue_failed", {
            source,
            error: error instanceof Error ? error.message : String(error),
          })
          throw error
        }
      }

      const sdkUuidMap = buildSdkUuidMapSeed(handler, allMessages)

      let messageStartEmitted = false
      let lastUsage: TokenUsage | undefined

      try {
        let currentSessionId: string | undefined
        const response = runSdkQueryWithRetry(
          shared, handler, promptBundle, hooks, callbacks, env, "stream", sdkUuidMap,
        )

        const heartbeat = setInterval(() => {
          heartbeatCount += 1
          try {
            const payload = encoder.encode(`: ping\n\n`)
            if (!safeEnqueue(payload, "heartbeat")) {
              clearInterval(heartbeat)
              return
            }
            if (heartbeatCount % 5 === 0) {
              claudeLog("stream.heartbeat", { count: heartbeatCount })
            }
          } catch (error) {
            claudeLog("stream.heartbeat_failed", {
              count: heartbeatCount,
              error: error instanceof Error ? error.message : String(error),
            })
            clearInterval(heartbeat)
          }
        }, 15_000)

        const skipBlockIndices = new Set<number>()
        const streamedToolUseIds = new Set<string>()

        const structuredOutputIds = new Set<string>()
        const structuredOutputIndices = new Set<number>()
        let lastOutputFormatDelta: unknown = null

        // SDK resets block indices on each turn, but we merge turns into one
        // client-visible message. Remap SDK indices to a monotonic stream.
        let nextClientBlockIndex = 0
        const sdkToClientIndex = new Map<number, number>()

        try {
          for await (const message of response) {
            if (streamClosed) break

            if ((message as any).session_id) {
              currentSessionId = (message as any).session_id
            }
            if (message.type === "assistant" && (message as any).uuid) {
              sdkUuidMap.push((message as any).uuid)
            }

            if (message.type === "stream_event") {
              streamEventsSeen += 1
              if (!firstChunkAt) {
                firstChunkAt = Date.now()
                claudeLog("upstream.first_chunk", {
                  mode: "stream",
                  model: shared.model,
                  ttfbMs: firstChunkAt - upstreamStartAt,
                })
              }

              const event = message.event
              const eventType = (event as any).type
              const eventIndex = (event as any).index as number | undefined

              if (eventType === "message_start") {
                skipBlockIndices.clear()
                sdkToClientIndex.clear()
                const startUsage = (event as unknown as { message?: { usage?: TokenUsage } }).message?.usage
                if (startUsage) lastUsage = { ...lastUsage, ...startUsage }
                // Only the first message_start is client-visible; subsequent
                // ones are internal SDK turns.
                if (messageStartEmitted) {
                  // Drain pending WebSearch results — inject synthetic
                  // server_tool_use + web_search_tool_result SSE events.
                  while (pendingWebSearchResults.length > 0) {
                    const ws = pendingWebSearchResults.shift()!
                    for (const result of ws.results) {
                      const stuIdx = nextClientBlockIndex++
                      safeEnqueue(encoder.encode(
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
                      ), "websearch_server_tool_use")
                      safeEnqueue(encoder.encode(
                        `event: content_block_stop\ndata: ${JSON.stringify({
                          type: "content_block_stop",
                          index: stuIdx,
                        })}\n\n`,
                      ), "websearch_server_tool_use_stop")

                      const wstrIdx = nextClientBlockIndex++
                      safeEnqueue(encoder.encode(
                        `event: content_block_start\ndata: ${JSON.stringify({
                          type: "content_block_start",
                          index: wstrIdx,
                          content_block: {
                            type: "web_search_tool_result",
                            tool_use_id: result.tool_use_id,
                            content: result.content.map((c: { title: string; url: string }) => ({
                              type: "web_search_result",
                              title: c.title,
                              url: c.url,
                              encrypted_content: "",
                              page_age: null,
                            })),
                          },
                        })}\n\n`,
                      ), "websearch_tool_result")
                      safeEnqueue(encoder.encode(
                        `event: content_block_stop\ndata: ${JSON.stringify({
                          type: "content_block_stop",
                          index: wstrIdx,
                        })}\n\n`,
                      ), "websearch_tool_result_stop")
                      eventsForwarded += 4
                    }
                  }
                  continue
                }
                messageStartEmitted = true
              }

              // Skip intermediate message_stop — only emit one at the end.
              if (eventType === "message_stop") continue

              if (eventType === "content_block_start") {
                const block = (event as any).content_block

                if (outputFormat) {
                  if (block?.type === "tool_use" && block.name === "StructuredOutput") {
                    if (structuredOutputIds.size > 0 || (block.id && structuredOutputIds.has(block.id))) {
                      if (eventIndex !== undefined) skipBlockIndices.add(eventIndex)
                      continue
                    }
                    if (block.id) structuredOutputIds.add(block.id)
                    if (eventIndex !== undefined) structuredOutputIndices.add(eventIndex)
                    ;(event as any).content_block = { type: "text", text: "" }
                    // fall through: assign client index + forward
                  } else if (block?.type === "text") {
                    if (eventIndex !== undefined) skipBlockIndices.add(eventIndex)
                    continue
                  }
                }

                if (block?.type === "tool_use" && typeof block.name === "string") {
                  if (passthrough && block.name.startsWith(PASSTHROUGH_MCP_PREFIX)) {
                    block.name = stripMcpPrefix(block.name)
                    if (block.id) streamedToolUseIds.add(block.id)
                  } else if (block.name.startsWith("mcp__")) {
                    if (eventIndex !== undefined) skipBlockIndices.add(eventIndex)
                    continue
                  } else if (useBuiltinWebSearch) {
                    if (eventIndex !== undefined) skipBlockIndices.add(eventIndex)
                    continue
                  } else if (passthrough && block.id) {
                    // Passthrough mode: SDK already stripped the prefix
                    // before emitting the stream_event. Track the id so
                    // the early-break condition fires correctly.
                    streamedToolUseIds.add(block.id)
                  }
                }
                if (eventIndex !== undefined) {
                  sdkToClientIndex.set(eventIndex, nextClientBlockIndex++)
                }
              }

              if (eventIndex !== undefined && skipBlockIndices.has(eventIndex)) continue

              if (outputFormat && eventIndex !== undefined && structuredOutputIndices.has(eventIndex) && eventType === "content_block_delta") {
                const delta = (event as any).delta
                if (delta?.type === "input_json_delta") {
                  delta.type = "text_delta"
                  delta.text = delta.partial_json
                  delete delta.partial_json
                }
              }

              if (eventIndex !== undefined && sdkToClientIndex.has(eventIndex)) {
                (event as any).index = sdkToClientIndex.get(eventIndex)
              }

              if (eventType === "message_delta") {
                const deltaUsage = (event as unknown as { usage?: TokenUsage }).usage
                if (deltaUsage) lastUsage = { ...lastUsage, ...deltaUsage }

                if (outputFormat) {
                  lastOutputFormatDelta = event
                  continue
                }

                const stopReason = (event as any).delta?.stop_reason

                if (stopReason === "max_tokens") {
                  const payload = encoder.encode(`event: ${eventType}\ndata: ${JSON.stringify(event)}\n\n`)
                  safeEnqueue(payload, "stream_event:message_delta_max_tokens")
                  eventsForwarded += 1
                  break
                }

                if (stopReason === "tool_use" && (skipBlockIndices.size > 0 || useBuiltinWebSearch)) {
                  continue
                }
              }

              const payload = encoder.encode(`event: ${eventType}\ndata: ${JSON.stringify(event)}\n\n`)
              if (!safeEnqueue(payload, `stream_event:${eventType}`)) break
              eventsForwarded += 1

              if (eventType === "content_block_delta") {
                const delta = (event as any).delta
                if (delta?.type === "text_delta") textEventsForwarded += 1
              }
            }
          }
        } finally {
          clearInterval(heartbeat)
        }

        claudeLog("upstream.completed", {
          mode: "stream",
          model: shared.model,
          durationMs: Date.now() - upstreamStartAt,
          streamEventsSeen,
          eventsForwarded,
          textEventsForwarded,
        })
        if (lastUsage) logUsage(requestMeta.requestId, lastUsage)

        callbacks.onComplete?.(currentSessionId, sdkUuidMap, lastUsage)

        if (!streamClosed) {
          // Passthrough: emit captured tool_use blocks as stream events,
          // deduped against ones the SDK already forwarded.
          const unseenToolUses = capturedToolUses.filter(tu =>
            !streamedToolUseIds.has(tu.id) && !(outputFormat && tu.name === "StructuredOutput"),
          )
          if (passthrough && unseenToolUses.length > 0 && messageStartEmitted) {
            for (let i = 0; i < unseenToolUses.length; i++) {
              const tu = unseenToolUses[i]!
              const blockIndex = eventsForwarded + i

              safeEnqueue(encoder.encode(
                `event: content_block_start\ndata: ${JSON.stringify({
                  type: "content_block_start",
                  index: blockIndex,
                  content_block: { type: "tool_use", id: tu.id, name: tu.name, input: {} },
                })}\n\n`,
              ), "passthrough_tool_block_start")

              safeEnqueue(encoder.encode(
                `event: content_block_delta\ndata: ${JSON.stringify({
                  type: "content_block_delta",
                  index: blockIndex,
                  delta: { type: "input_json_delta", partial_json: JSON.stringify(tu.input) },
                })}\n\n`,
              ), "passthrough_tool_input")

              safeEnqueue(encoder.encode(
                `event: content_block_stop\ndata: ${JSON.stringify({
                  type: "content_block_stop",
                  index: blockIndex,
                })}\n\n`,
              ), "passthrough_tool_block_stop")
            }

            safeEnqueue(encoder.encode(
              `event: message_delta\ndata: ${JSON.stringify({
                type: "message_delta",
                delta: { stop_reason: "tool_use", stop_sequence: null },
                usage: { output_tokens: 0 },
              })}\n\n`,
            ), "passthrough_message_delta")
          }

          if (trackFileChanges && passthrough && adapter.extractFileChangesFromToolUse) {
            const passthroughChanges = extractFileChangesFromMessages(
              body.messages || [],
              adapter.extractFileChangesFromToolUse.bind(adapter),
            )
            fileChanges.push(...passthroughChanges)
          }

          if (trackFileChanges) {
            const streamFileChangeSummary = formatFileChangeSummary(fileChanges)
            if (streamFileChangeSummary && messageStartEmitted) {
              const fcBlockIndex = nextClientBlockIndex++
              safeEnqueue(encoder.encode(
                `event: content_block_start\ndata: ${JSON.stringify({
                  type: "content_block_start",
                  index: fcBlockIndex,
                  content_block: { type: "text", text: "" },
                })}\n\n`,
              ), "file_changes_block_start")
              safeEnqueue(encoder.encode(
                `event: content_block_delta\ndata: ${JSON.stringify({
                  type: "content_block_delta",
                  index: fcBlockIndex,
                  delta: { type: "text_delta", text: streamFileChangeSummary },
                })}\n\n`,
              ), "file_changes_text_delta")
              safeEnqueue(encoder.encode(
                `event: content_block_stop\ndata: ${JSON.stringify({
                  type: "content_block_stop",
                  index: fcBlockIndex,
                })}\n\n`,
              ), "file_changes_block_stop")
              claudeLog("response.file_changes", { mode: "stream", count: fileChanges.length })
            }
          }

          // Emit one terminal message_delta when outputFormat is set
          // (intermediate ones were suppressed during the loop).
          if (outputFormat && messageStartEmitted) {
            const usage = lastOutputFormatDelta
              ? (lastOutputFormatDelta as Record<string, unknown>).usage ?? { output_tokens: 0 }
              : { output_tokens: 0 }
            safeEnqueue(encoder.encode(
              `event: message_delta\ndata: ${JSON.stringify({
                type: "message_delta",
                delta: { stop_reason: "end_turn", stop_sequence: null },
                usage,
              })}\n\n`,
            ), "outputformat_final_message_delta")
          }

          if (messageStartEmitted) {
            safeEnqueue(encoder.encode(`event: message_stop\ndata: {"type":"message_stop"}\n\n`), "final_message_stop")
          }

          try { controller.close() } catch {}
          streamClosed = true

          claudeLog("stream.ended", {
            model: shared.model,
            streamEventsSeen,
            eventsForwarded,
            textEventsForwarded,
            bytesSent,
            durationMs: Date.now() - env.requestStartAt,
          })
        }

        // Record telemetry for ALL completed streams (including early-close
        // from passthrough tool_use break and client disconnect during
        // enqueue). Must be outside the `if (!streamClosed)` block.
        {
          const streamTotalDurationMs = Date.now() - env.requestStartAt

          claudeLog("response.completed", {
            mode: "stream",
            model: shared.model,
            durationMs: streamTotalDurationMs,
            streamEventsSeen,
            eventsForwarded,
            textEventsForwarded,
          })

          recordRequestSuccess(
            { requestMeta, requestStartAt: env.requestStartAt, adapterName: adapter.name },
            shared,
            handler,
            {
              mode: "stream",
              upstreamStartAt,
              firstChunkAt,
              sdkSessionId: currentSessionId || resumeSessionId,
              contentBlocks: eventsForwarded,
              textEvents: textEventsForwarded,
              passthrough,
            },
          )

          if (textEventsForwarded === 0) {
            claudeLog("response.empty_stream", {
              model: shared.model,
              streamEventsSeen,
              eventsForwarded,
              reason: "no_text_deltas_forwarded",
            })
          }
        }
      } catch (error) {
        if (isClosedControllerError(error)) {
          streamClosed = true
          claudeLog("stream.client_closed", {
            source: "stream_catch",
            streamEventsSeen,
            eventsForwarded,
            textEventsForwarded,
            durationMs: Date.now() - env.requestStartAt,
          })
          return
        }

        const stderrOutput = stderrLines.join("\n").trim()
        if (stderrOutput && error instanceof Error && !error.message.includes(stderrOutput)) {
          error.message = `${error.message}\nSubprocess stderr: ${stderrOutput}`
        }
        const errMsg = error instanceof Error ? error.message : String(error)
        claudeLog("upstream.failed", {
          mode: "stream",
          model: shared.model,
          durationMs: Date.now() - upstreamStartAt,
          streamEventsSeen,
          textEventsForwarded,
          error: errMsg,
          ...(stderrOutput ? { stderr: stderrOutput } : {}),
        })
        const streamErr = classifyError(errMsg)
        const envelope = buildErrorEnvelope(errMsg)
        claudeLog("proxy.anthropic.error", { error: errMsg, classified: streamErr.type })

        if (messageStartEmitted) {
          safeEnqueue(encoder.encode(
            `event: message_delta\ndata: ${JSON.stringify({
              type: "message_delta",
              delta: { stop_reason: "end_turn", stop_sequence: null },
              usage: { output_tokens: 0 },
            })}\n\n`,
          ), "error_message_delta")
          safeEnqueue(encoder.encode(
            `event: message_stop\ndata: {"type":"message_stop"}\n\n`,
          ), "error_message_stop")
        }

        safeEnqueue(encoder.encode(
          `event: error\ndata: ${JSON.stringify(envelope.body)}\n\n`,
        ), "error_event")
        if (!streamClosed) {
          try { controller.close() } catch {}
          streamClosed = true
        }
      } finally {
        // Ephemeral cleanup runs after the stream controller has closed and
        // the SDK subprocess has exited. The SDK only reads the JSONL once
        // (at resume time), so deleting it now is safe.
        await cleanupEphemeral()
      }
    },
  })

  const streamSessionId = resumeSessionId || `session_${Date.now()}`
  return new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Claude-Session-ID": streamSessionId,
    },
  })
}
