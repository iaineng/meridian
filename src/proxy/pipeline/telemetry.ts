import type { TokenUsage } from "../session/lineage"
import { telemetryStore } from "../../telemetry"
import { envBool } from "../../env"
import type { SharedRequestContext } from "./context"
import type { HandlerContext } from "../handlers/types"

export function logUsage(requestId: string, usage: TokenUsage): void {
  const fmt = (n: number) => n > 1000 ? `${Math.round(n / 1000)}k` : String(n)
  const parts = [
    `input=${fmt(usage.input_tokens ?? 0)}`,
    `output=${fmt(usage.output_tokens ?? 0)}`,
    ...(usage.cache_read_input_tokens ? [`cache_read=${fmt(usage.cache_read_input_tokens)}`] : []),
    ...(usage.cache_creation_input_tokens ? [`cache_write=${fmt(usage.cache_creation_input_tokens)}`] : []),
  ]
  console.error(`[PROXY] ${requestId} usage: ${parts.join(" ")}`)
}

/**
 * Per-request telemetry context — the subset of the outer request state that
 * both success and error telemetry emitters need to know about.
 */
export interface RequestTelemetryContext {
  requestMeta: { requestId: string; queueEnteredAt: number; queueStartedAt: number }
  requestStartAt: number
  adapterName: string
}

export interface RecordSuccessInput {
  mode: "stream" | "non-stream"
  upstreamStartAt: number
  firstChunkAt: number | undefined
  sdkSessionId: string | undefined
  contentBlocks: number
  textEvents: number
  /** Possibly-flipped passthrough value from the hook bundle. */
  passthrough: boolean
}

/**
 * Record a successful request. Pulls stable identity from `shared`/`handler`
 * and mode-specific stats from `input`.
 */
export function recordRequestSuccess(
  ctx: RequestTelemetryContext,
  shared: SharedRequestContext,
  handler: HandlerContext,
  input: RecordSuccessInput,
): void {
  const now = Date.now()
  const queueWaitMs = ctx.requestMeta.queueStartedAt - ctx.requestMeta.queueEnteredAt
  telemetryStore.record({
    requestId: ctx.requestMeta.requestId,
    timestamp: now,
    adapter: ctx.adapterName,
    model: shared.model,
    requestModel: shared.body.model || undefined,
    mode: input.mode,
    isResume: handler.isResume,
    isPassthrough: input.passthrough,
    isEphemeral: handler.isEphemeral,
    // Ephemeral has no real session lineage — keep it out of the Lineage
    // breakdown and rely on `isEphemeral` for the dedicated card/badge.
    lineageType: handler.isEphemeral || handler.lineageType === "ephemeral"
      ? undefined
      : handler.lineageType,
    messageCount: shared.allMessages.length,
    sdkSessionId: input.sdkSessionId,
    status: 200,
    queueWaitMs,
    proxyOverheadMs: input.upstreamStartAt - ctx.requestStartAt - queueWaitMs,
    ttfbMs: input.firstChunkAt ? input.firstChunkAt - input.upstreamStartAt : null,
    upstreamDurationMs: now - input.upstreamStartAt,
    totalDurationMs: now - ctx.requestStartAt,
    contentBlocks: input.contentBlocks,
    textEvents: input.textEvents,
    error: null,
  })
}

/**
 * Record a request that errored before producing a successful response.
 * This path cannot use the shared/handler bundles because buildSharedContext
 * may have failed early — falls back to envBool() for passthrough/ephemeral.
 */
export function recordRequestError(
  ctx: RequestTelemetryContext,
  classified: { status: number; type: string },
): void {
  const now = Date.now()
  const queueWaitMs = ctx.requestMeta.queueStartedAt - ctx.requestMeta.queueEnteredAt
  telemetryStore.record({
    requestId: ctx.requestMeta.requestId,
    timestamp: now,
    adapter: ctx.adapterName,
    model: "unknown",
    requestModel: undefined,
    mode: "non-stream",
    isResume: false,
    isPassthrough: envBool("PASSTHROUGH"),
    isEphemeral: envBool("EPHEMERAL_JSONL"),
    lineageType: undefined,
    messageCount: undefined,
    sdkSessionId: undefined,
    status: classified.status,
    queueWaitMs,
    proxyOverheadMs: now - ctx.requestStartAt - queueWaitMs,
    ttfbMs: null,
    upstreamDurationMs: now - ctx.requestStartAt,
    totalDurationMs: now - ctx.requestStartAt,
    contentBlocks: 0,
    textEvents: 0,
    error: classified.type,
  })
}
