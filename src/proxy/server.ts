import { Hono } from "hono"
import { cors } from "hono/cors"
import { serve } from "@hono/node-server"
import type { Server } from "node:http"
import type { Context } from "hono"
import { DEFAULT_PROXY_CONFIG } from "./types"
import { envInt } from "../env"
import type { ProxyConfig, ProxyInstance, ProxyServer } from "./types"
export type { ProxyConfig, ProxyInstance, ProxyServer }
import { claudeLog, withClaudeLogContext } from "../logger"
import { tmpdir } from "node:os"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { randomUUID } from "crypto"

import { diagnosticLog, createTelemetryRoutes, landingHtml } from "../telemetry"
import { createConcurrencyGate } from "./concurrency"
import { classifyError, buildErrorEnvelope } from "./errors"
import { refreshOAuthToken } from "./tokenRefresh"
import { resolveClaudeExecutableAsync, getClaudeAuthStatusAsync, getAuthCacheInfo } from "./models"
import { buildPromptBundle } from "./pipeline/prompt"
import { buildSharedContext } from "./pipeline/context"
import { buildHookBundle } from "./pipeline/hooks"
import { recordRequestError } from "./pipeline/telemetry"
import { runNonStream, runStream, type ExecutorEnv } from "./pipeline/executor"
import { buildBlockingHandler } from "./handlers/blocking"
import { resolveProfile, listProfiles, setActiveProfile, getActiveProfileId, getEffectiveProfiles, restoreActiveProfile } from "./profiles"
import {
  computeLineageHash,
  hashMessage,
  computeMessageHashes,
  type LineageResult,
} from "./session"

// Re-export for backwards compatibility (existing tests import from here)
export { computeLineageHash, hashMessage, computeMessageHashes }
export type { LineageResult }

// Empty sandbox directory for SDK subprocess — avoids picking up
// CLAUDE.md or other project files from the deployment directory.
const SANDBOX_DIR = join(tmpdir(), "meridian-sandbox")
mkdirSync(SANDBOX_DIR, { recursive: true })

export function createProxyServer(config: Partial<ProxyConfig> = {}): ProxyServer {
  const finalConfig = { ...DEFAULT_PROXY_CONFIG, ...config }

  // Per-instance cache of the resolved Claude executable path. Lazily
  // populated on the first request; `resolveClaudeExecutableAsync` has its
  // own module-level memo so `startProxyServer`'s pre-warm fills this too.
  let claudeExecutable = ""

  // Restore persisted active profile from last session
  restoreActiveProfile(finalConfig.profiles)

  const app = new Hono()

  app.use("*", cors())

  app.get("/", (c) => {
    const accept = c.req.header("accept") || ""
    if (accept.includes("application/json") && !accept.includes("text/html")) {
      return c.json({
        status: "ok",
        service: "meridian",
        format: "anthropic",
        endpoints: ["/v1/messages", "/messages", "/telemetry", "/health"],
      })
    }
    return c.html(landingHtml)
  })

  // --- Concurrency Control ---
  // Each request spawns an SDK subprocess (cli.js, ~11MB). Spawning multiple
  // simultaneously can crash the process. Serialize SDK queries with a queue.
  //
  // Setting MERIDIAN_MAX_CONCURRENT=0 (or any value <= 0) disables the queue
  // entirely — every request proceeds immediately. Use with caution: a flood
  // of simultaneous SDK subprocesses can OOM the host. The counter is still
  // maintained for the telemetry log line.
  const sessionGate = createConcurrencyGate(envInt("MAX_CONCURRENT", 10))

  const handleMessages = async (
    c: Context,
    requestMeta: { requestId: string; endpoint: string; queueEnteredAt: number; queueStartedAt: number },
  ) => {
    const requestStartAt = Date.now()

    return withClaudeLogContext({ requestId: requestMeta.requestId, endpoint: requestMeta.endpoint }, async () => {
      // Ephemeral cleanup handle — reassigned from inside the try once the
      // handler is built. Hoisted so the outer finally can fire it.
      let cleanupEphemeral: () => Promise<void> = async () => {}
      let ephemeralDeferredToStream = false
      try {
        const built = await buildSharedContext(c, requestMeta, finalConfig, SANDBOX_DIR)
        if (built.error) return built.error
        const shared = built.shared!

        const { body, stream } = shared

        // Single dispatch path: blocking-MCP + passthrough + ephemeral.
        // `meridian` runs only this combination — see ARCHITECTURE.md.
        const handler = await buildBlockingHandler(shared)
        cleanupEphemeral = handler.cleanup

        const { lineageType } = handler

        const msgSummary = body.messages?.map((m: any) => {
          const contentTypes = Array.isArray(m.content)
            ? m.content.map((b: any) => b.type).join(",")
            : "string"
          return `${m.role}[${contentTypes}]`
        }).join(" → ")
        const msgCount = Array.isArray(body.messages) ? body.messages.length : 0
        const requestLogLine = `${requestMeta.requestId} model=${shared.model} stream=${stream} tools=${body.tools?.length ?? 0} lineage=${lineageType} active=${sessionGate.active}/${sessionGate.unlimited ? "∞" : sessionGate.max} msgCount=${msgCount}`
        console.error(`[PROXY] ${requestLogLine} msgs=${msgSummary}`)
        diagnosticLog.session(`${requestLogLine}`, requestMeta.requestId)

        claudeLog("request.received", {
          model: shared.model,
          stream,
          queueWaitMs: requestMeta.queueStartedAt - requestMeta.queueEnteredAt,
          messageCount: Array.isArray(body.messages) ? body.messages.length : 0,
          hasSystemPrompt: Boolean(body.system),
        })

        const promptBundle = buildPromptBundle({
          messagesToConvert: handler.messagesToConvert,
          directPromptMessages: handler.directPromptMessages,
        })

        const hooks = buildHookBundle({
          body,
          prebuiltPassthroughMcp: handler.prebuiltPassthroughMcp,
          blockingState: handler.blockingState,
        })

        // Lazy-resolve the claude executable for both stream and non-stream.
        // Previously only non-stream did this; hoisting removes a latent NPE
        // risk in the stream path when createProxyServer is used directly
        // (without startProxyServer).
        if (!claudeExecutable) {
          claudeExecutable = await resolveClaudeExecutableAsync()
        }
        const env: ExecutorEnv = { claudeExecutable, requestStartAt }

        if (!stream) {
          return await runNonStream(shared, handler, promptBundle, hooks, env)
        }

        const res = runStream(shared, handler, promptBundle, hooks, env)
        // Defer ephemeral cleanup to the ReadableStream's finally — SDK work
        // runs after we return this response and the outer finally fires too
        // early (before any JSONL bytes are read by the subprocess).
        ephemeralDeferredToStream = true
        return res
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error)
        claudeLog("error.unhandled", {
          durationMs: Date.now() - requestStartAt,
          error: errMsg,
        })

        const classified = classifyError(errMsg)
        const envelope = buildErrorEnvelope(errMsg)
        claudeLog("proxy.error", { error: errMsg, classified: classified.type })

        recordRequestError(
          { requestMeta, requestStartAt },
          classified,
        )

        return new Response(
          JSON.stringify(envelope.body),
          { status: envelope.status, headers: { "Content-Type": "application/json" } },
        )
      } finally {
        // Skip cleanup when we deferred it to the streaming finally — the
        // stream branch returns synchronously with a ReadableStream whose
        // start() hasn't run yet; deleting the JSONL here would race the
        // SDK subprocess reading it. Otherwise (non-stream path or error
        // before the stream handoff) clean up now.
        if (!ephemeralDeferredToStream) await cleanupEphemeral()
      }
    })
  }

  const handleWithQueue = async (c: Context, endpoint: string) => {
    const requestId = c.req.header("x-request-id") || randomUUID()
    const queueEnteredAt = Date.now()
    claudeLog("request.enter", { requestId, endpoint })
    await sessionGate.acquire()
    const queueStartedAt = Date.now()
    try {
      return await handleMessages(c, { requestId, endpoint, queueEnteredAt, queueStartedAt })
    } finally {
      sessionGate.release()
    }
  }

  app.post("/v1/messages", (c) => handleWithQueue(c, "/v1/messages"))
  app.post("/messages", (c) => handleWithQueue(c, "/messages"))

  // Telemetry dashboard and API
  app.route("/telemetry", createTelemetryRoutes())

  // Health check endpoint — verifies auth status
  app.get("/health", async (c) => {
    try {
      const healthProfile = resolveProfile(finalConfig.profiles, finalConfig.defaultProfile)
      const profileEnvOverrides = Object.keys(healthProfile.env).length > 0 ? healthProfile.env : undefined
      const auth = await getClaudeAuthStatusAsync(
        healthProfile.id !== "default" ? healthProfile.id : undefined,
        profileEnvOverrides,
      )
      if (!auth) {
        return c.json({
          status: "degraded",
          error: "Could not verify auth status",
          mode: "passthrough",
        })
      }
      if (!auth.loggedIn) {
        return c.json({
          status: "unhealthy",
          error: "Not logged in. Run: claude login",
          auth: { loggedIn: false },
        }, 503)
      }
      return c.json({
        status: "healthy",
        auth: {
          loggedIn: true,
          email: auth.email,
          subscriptionType: auth.subscriptionType,
        },
        mode: "passthrough",
      })
    } catch {
      return c.json({
        status: "degraded",
        error: "Could not verify auth status",
        mode: "passthrough",
      })
    }
  })

  // --- Profile management routes ---

  app.get("/profiles/list", async (c) => {
    const profiles = listProfiles(finalConfig.profiles, finalConfig.defaultProfile)
    const enriched = await Promise.all(profiles.map(async (p) => {
      const resolved = resolveProfile(finalConfig.profiles, finalConfig.defaultProfile, p.id)
      const envOverrides = Object.keys(resolved.env).length > 0 ? resolved.env : undefined
      const auth = await getClaudeAuthStatusAsync(
        p.id !== "default" ? p.id : undefined,
        envOverrides,
      )
      const cacheInfo = getAuthCacheInfo(p.id !== "default" ? p.id : undefined)
      return {
        ...p,
        email: auth?.email || null,
        subscriptionType: auth?.subscriptionType || null,
        loggedIn: auth?.loggedIn ?? false,
        lastCheckedAt: cacheInfo.lastCheckedAt || null,
        lastSuccessAt: cacheInfo.lastSuccessAt || null,
      }
    }))
    return c.json({
      profiles: enriched,
      activeProfile: getActiveProfileId() || finalConfig.defaultProfile || profiles[0]?.id || "default",
    })
  })

  app.get("/profiles", async (c) => {
    const { profilePageHtml } = await import("../telemetry/profilePage")
    return c.html(profilePageHtml)
  })

  app.post("/profiles/active", async (c) => {
    let body: { profile?: string }
    try {
      body = await c.req.json() as { profile?: string }
    } catch {
      return c.json({ error: "Invalid JSON in request body" }, 400)
    }
    if (!body.profile) {
      return c.json({ error: "Missing 'profile' in request body" }, 400)
    }
    const effective = getEffectiveProfiles(finalConfig.profiles)
    if (effective.length === 0) {
      return c.json({ error: "No profiles configured" }, 400)
    }
    if (!effective.find(p => p.id === body.profile)) {
      return c.json({ error: `Unknown profile: ${body.profile}. Available: ${effective.map(p => p.id).join(", ")}` }, 400)
    }
    setActiveProfile(body.profile!)
    console.error(`[PROXY] Active profile switched to: ${body.profile}`)
    return c.json({ success: true, activeProfile: body.profile })
  })

  app.post("/auth/refresh", async (c) => {
    const success = await refreshOAuthToken()
    if (success) {
      return c.json({ success: true, message: "OAuth token refreshed successfully" })
    }
    return c.json(
      { success: false, message: "Token refresh failed. If the problem persists, run 'claude login'." },
      500,
    )
  })

  // Catch-all: log unhandled requests
  app.all("*", (c) => {
    console.error(`[PROXY] UNHANDLED ${c.req.method} ${c.req.url}`)
    return c.json({ error: { type: "not_found", message: `Endpoint not supported: ${c.req.method} ${new URL(c.req.url).pathname}` } }, 404)
  })

  return { app, config: finalConfig }
}

export async function startProxyServer(config: Partial<ProxyConfig> = {}): Promise<ProxyInstance> {
  // Pre-warm the resolver's module-level memo so the first request on the
  // new instance hits a cached path rather than racing `which`/`where`.
  await resolveClaudeExecutableAsync()
  const { app, config: finalConfig } = createProxyServer(config)

  const server = serve({
    fetch: app.fetch,
    port: finalConfig.port,
    hostname: finalConfig.host,
    overrideGlobalObjects: false,
  }, (info) => {
    if (!finalConfig.silent) {
      console.log(`Meridian running at http://${finalConfig.host}:${info.port}`)
      console.log(`Telemetry dashboard: http://${finalConfig.host}:${info.port}/telemetry`)
      console.log(`\nPoint any Anthropic-compatible tool at this endpoint:`)
      console.log(`  ANTHROPIC_API_KEY=x ANTHROPIC_BASE_URL=http://${finalConfig.host}:${info.port}`)
    }
  }) as Server

  const idleMs = finalConfig.idleTimeoutSeconds * 1000
  server.keepAliveTimeout = idleMs
  server.headersTimeout = idleMs + 1000

  server.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EADDRINUSE" && !finalConfig.silent) {
      console.error(`\nError: Port ${finalConfig.port} is already in use.`)
      console.error(`\nIs another instance of the proxy already running?`)
      console.error(`  Check with: lsof -i :${finalConfig.port}`)
      console.error(`  Kill it with: kill $(lsof -ti :${finalConfig.port})`)
      console.error(`\nOr use a different port:`)
      console.error(`  MERIDIAN_PORT=4567 meridian`)
    }
  })

  // Background auth keepalive: periodically refresh auth status for all
  // configured profiles so switching is instant (no stale token delay).
  let authKeepaliveInterval: ReturnType<typeof setInterval> | undefined
  const effectiveProfiles = getEffectiveProfiles(finalConfig.profiles)
  if (effectiveProfiles.length > 0) {
    const AUTH_KEEPALIVE_MS = 45_000 // 45s — well within the 60s TTL
    authKeepaliveInterval = setInterval(async () => {
      const currentProfiles = getEffectiveProfiles(finalConfig.profiles)
      for (const profile of currentProfiles) {
        const resolved = resolveProfile(finalConfig.profiles, finalConfig.defaultProfile, profile.id)
        if (Object.keys(resolved.env).length > 0) {
          getClaudeAuthStatusAsync(resolved.id, resolved.env).catch(() => {})
        }
      }
      getClaudeAuthStatusAsync().catch(() => {})
    }, AUTH_KEEPALIVE_MS)
    if (authKeepaliveInterval.unref) authKeepaliveInterval.unref()
  }

  return {
    server,
    config: finalConfig,
    async close() {
      if (authKeepaliveInterval) clearInterval(authKeepaliveInterval)
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()))
      })
    },
  }
}
