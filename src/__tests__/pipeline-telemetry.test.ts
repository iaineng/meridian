import { describe, expect, it, beforeEach } from "bun:test"
import { telemetryStore } from "../telemetry"
import { recordRequestSuccess, recordRequestError } from "../proxy/pipeline/telemetry"
import type { SharedRequestContext } from "../proxy/pipeline/context"
import type { HandlerContext } from "../proxy/handlers/types"

function makeCtx(overrides: {
  queueEnteredAt?: number
  queueStartedAt?: number
  requestStartAt?: number
} = {}) {
  const base = 1_000_000
  return {
    requestMeta: {
      requestId: "req-test",
      queueEnteredAt: overrides.queueEnteredAt ?? base,
      queueStartedAt: overrides.queueStartedAt ?? base,
    },
    requestStartAt: overrides.requestStartAt ?? (overrides.queueStartedAt ?? base),
    adapterName: "opencode",
  }
}

function makeShared(): SharedRequestContext {
  return {
    body: { model: "claude-opus-4-7" },
    allMessages: [],
    model: "claude-opus-4-7[1m]",
  } as unknown as SharedRequestContext
}

function makeHandler(): HandlerContext {
  return {
    isEphemeral: false,
    isResume: false,
    lineageType: "new",
  } as unknown as HandlerContext
}

describe("pipeline/telemetry — proxyOverheadMs", () => {
  beforeEach(() => {
    telemetryStore.clear()
  })

  it("never returns a negative value when queue wait dominates", () => {
    // Simulate: queue saturated for 100s, handler ran ~50ms before upstream.
    const base = 1_000_000_000
    const queueEnteredAt = base
    const queueStartedAt = base + 100_000
    const requestStartAt = queueStartedAt
    const upstreamStartAt = requestStartAt + 50

    recordRequestSuccess(
      makeCtx({ queueEnteredAt, queueStartedAt, requestStartAt }),
      makeShared(),
      makeHandler(),
      {
        mode: "non-stream",
        upstreamStartAt,
        firstChunkAt: upstreamStartAt + 200,
        sdkSessionId: "s1",
        contentBlocks: 1,
        textEvents: 0,
        passthrough: false,
      },
    )

    const [metric] = telemetryStore.getRecent({ limit: 1 })
    expect(metric).toBeDefined()
    expect(metric!.queueWaitMs).toBe(100_000)
    expect(metric!.proxyOverheadMs).toBe(50)
    expect(metric!.proxyOverheadMs).toBeGreaterThanOrEqual(0)
  })

  it("clamps to 0 when upstreamStartAt precedes requestStartAt (clock skew)", () => {
    const base = 2_000_000_000
    const requestStartAt = base + 10
    const upstreamStartAt = base // earlier than requestStartAt

    recordRequestSuccess(
      makeCtx({ queueEnteredAt: base, queueStartedAt: base, requestStartAt }),
      makeShared(),
      makeHandler(),
      {
        mode: "non-stream",
        upstreamStartAt,
        firstChunkAt: undefined,
        sdkSessionId: "s1",
        contentBlocks: 0,
        textEvents: 0,
        passthrough: false,
      },
    )

    const [metric] = telemetryStore.getRecent({ limit: 1 })
    expect(metric!.proxyOverheadMs).toBe(0)
  })

  it("blocking lineageType survives telemetry (not collapsed to undefined)", () => {
    const base = 3_000_000_000
    const ctx = makeCtx({ queueEnteredAt: base, queueStartedAt: base, requestStartAt: base })
    const handler = { isEphemeral: true, isResume: false, lineageType: "blocking" } as unknown as HandlerContext
    recordRequestSuccess(ctx, makeShared(), handler, {
      mode: "stream",
      upstreamStartAt: base + 10,
      firstChunkAt: base + 50,
      sdkSessionId: "s-blocking",
      contentBlocks: 1,
      textEvents: 0,
      passthrough: true,
    })
    const [metric] = telemetryStore.getRecent({ limit: 1 })
    expect(metric!.isEphemeral).toBe(true)
    expect(metric!.lineageType).toBe("blocking")
  })

  it("blocking_continuation lineageType survives telemetry", () => {
    const base = 3_500_000_000
    const ctx = makeCtx({ queueEnteredAt: base, queueStartedAt: base, requestStartAt: base })
    const handler = { isEphemeral: true, isResume: false, lineageType: "blocking_continuation" } as unknown as HandlerContext
    recordRequestSuccess(ctx, makeShared(), handler, {
      mode: "stream",
      upstreamStartAt: base + 10,
      firstChunkAt: base + 50,
      sdkSessionId: "s-blocking-c",
      contentBlocks: 1,
      textEvents: 0,
      passthrough: true,
    })
    const [metric] = telemetryStore.getRecent({ limit: 1 })
    expect(metric!.lineageType).toBe("blocking_continuation")
  })

  it("plain ephemeral still collapses to undefined (regression)", () => {
    const base = 4_000_000_000
    const ctx = makeCtx({ queueEnteredAt: base, queueStartedAt: base, requestStartAt: base })
    const handler = { isEphemeral: true, isResume: false, lineageType: "ephemeral" } as unknown as HandlerContext
    recordRequestSuccess(ctx, makeShared(), handler, {
      mode: "non-stream",
      upstreamStartAt: base + 10,
      firstChunkAt: base + 50,
      sdkSessionId: "s-eph",
      contentBlocks: 1,
      textEvents: 0,
      passthrough: false,
    })
    const [metric] = telemetryStore.getRecent({ limit: 1 })
    expect(metric!.lineageType).toBeUndefined()
  })

  it("error path: proxyOverheadMs excludes queue wait", () => {
    // Use real `now` as anchor so `Date.now() - requestStartAt` stays bounded
    // to test-runtime ms (the function under test calls Date.now() inside).
    const now = Date.now()
    const queueEnteredAt = now - 80_020
    const queueStartedAt = now - 20 // 80s queue wait
    const requestStartAt = queueStartedAt + 5

    recordRequestError(
      makeCtx({ queueEnteredAt, queueStartedAt, requestStartAt }),
      { status: 500, type: "api_error" },
    )

    const [metric] = telemetryStore.getRecent({ limit: 1 })
    expect(metric).toBeDefined()
    expect(metric!.queueWaitMs).toBe(80_000)
    // Previously `now - requestStartAt - 80_000` produced ~-80s here.
    expect(metric!.proxyOverheadMs).toBeGreaterThanOrEqual(0)
    expect(metric!.proxyOverheadMs).toBeLessThan(5_000)
    expect(metric!.error).toBe("api_error")
  })
})
