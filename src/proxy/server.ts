import { Hono } from "hono"
import { cors } from "hono/cors"
import { serve } from "@hono/node-server"
import type { Server } from "node:http"
import type { Context } from "hono"
import { DEFAULT_PROXY_CONFIG } from "./types"
import { envBool, envInt } from "../env"
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
import { checkPluginConfigured } from "./setup"
import { resolveClaudeExecutableAsync, getClaudeAuthStatusAsync, getAuthCacheInfo } from "./models"
import { translateOpenAiToAnthropic, translateAnthropicToOpenAi, translateAnthropicSseEvent } from "./openai"
import { buildPromptBundle } from "./pipeline/prompt"
import { buildSharedContext } from "./pipeline/context"
import { buildHookBundle } from "./pipeline/hooks"
import { recordRequestError } from "./pipeline/telemetry"
import { runNonStream, runStream, type ExecutorCallbacks, type ExecutorEnv } from "./pipeline/executor"
import { buildEphemeralHandler } from "./handlers/ephemeral"
import { buildBlockingHandler, BlockingProtocolMismatchError } from "./handlers/blocking"
import { buildClassicHandler, persistClassicSession, staleSessionRetryClassic } from "./handlers/classic"
import type { HandlerContext } from "./handlers/types"
import { detectAdapter } from "./adapters/detect"
import { resolveProfile, listProfiles, setActiveProfile, getActiveProfileId, getEffectiveProfiles, restoreActiveProfile } from "./profiles"
import {
  computeLineageHash,
  hashMessage,
  computeMessageHashes,
  type LineageResult,
} from "./session"

import { clearSessionCache, getMaxSessionsLimit, getSessionByClaudeId } from "./session/cache"
import { lookupSessionRecovery, listStoredSessions } from "./sessionStore"
// Re-export for backwards compatibility (existing tests import from here)
export { computeLineageHash, hashMessage, computeMessageHashes }
export { clearSessionCache, getMaxSessionsLimit }
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
        endpoints: ["/v1/messages", "/messages", "/v1/chat/completions", "/telemetry", "/health"],
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
      // Hoist adapter detection so it's available in the catch block for telemetry.
      const adapter = detectAdapter(c)
      // Ephemeral cleanup handle — reassigned from inside the try once the
      // handler is built. Hoisted so the outer finally can fire it.
      let cleanupEphemeral: () => Promise<void> = async () => {}
      let ephemeralDeferredToStream = false
      try {
        const built = await buildSharedContext(c, requestMeta, finalConfig, SANDBOX_DIR)
        if (built.error) return built.error
        const shared = built.shared!

        const { body, agentMode, stream } = shared

        // Dispatch: blocking-MCP > ephemeral > classic.
        //  - blocking-MCP: keeps one SDK query alive across HTTP rounds by
        //    suspending MCP handlers; requires ephemeral + passthrough.
        //    Works with both streaming and non-streaming requests, and a
        //    single conversation may freely alternate
        //    `stream:true`/`stream:false` across rounds. `outputFormat` is
        //    allowed: blocking mode raises maxTurns to 10_000, so the SDK's
        //    internal StructuredOutput retry loop has plenty of headroom and
        //    `translateBlockingMessage` translates the SDK's terminal
        //    `tool_use{name:"StructuredOutput"}` block to a `text` block on
        //    the client side. Built-in `web_search` (alone or mixed) is also
        //    handled inside the blocking pipeline: see
        //    `translateBlockingMessage` for duplicate message_start
        //    suppression + synthetic `server_tool_use` /
        //    `web_search_tool_result` injection.
        //  - **No tools is fine.** Plain-text-only and outputFormat-only
        //    requests still take this path when blocking is enabled — the
        //    pool just lives one HTTP round (no tool_use round-close fires
        //    since there's nothing to wait on), and the consumer's natural
        //    SDK end drives teardown. Removing the old `hasTools` precondition
        //    means callers who set `MERIDIAN_BLOCKING_MCP=1` get blocking
        //    semantics uniformly: maxTurns=10_000 lets the SDK exhaust its
        //    StructuredOutput retry budget, and the translator's terminal
        //    rewrite ensures the client sees one well-formed end_turn even
        //    when retries fire.
        //  - ephemeral: bypasses lineage/cache, one-shot JSONL transcript.
        //  - classic: LRU session cache with optional JSONL prewarm.
        const isEphemeral = envBool("EPHEMERAL_JSONL")
        const hasTools = Array.isArray(shared.body?.tools) && shared.body.tools.length > 0
        const blockingEnvOn = envBool("BLOCKING_MCP")
        const isBlockingMcp =
          isEphemeral
          && blockingEnvOn
          && shared.initialPassthrough
        if (blockingEnvOn && !isBlockingMcp) {
          // Surface the exact precondition that gated blocking out so deploy
          // operators can diagnose without enabling debug logging.
          // `hasTools` is logged for diagnostic visibility only — it's no
          // longer a precondition.
          claudeLog("blocking.dispatch.skipped", {
            isEphemeral,
            initialPassthrough: shared.initialPassthrough,
            hasTools,
            outputFormat: !!shared.outputFormat,
          })
        } else if (isBlockingMcp) {
          claudeLog("blocking.dispatch.accepted", {
            requestId: requestMeta.requestId,
            stream: shared.stream,
            hasTools,
            outputFormat: !!shared.outputFormat,
          })
        }
        const handler: HandlerContext = isBlockingMcp
          ? await buildBlockingHandler(shared)
          : isEphemeral
            ? await buildEphemeralHandler(shared)
            : await buildClassicHandler(shared)
        cleanupEphemeral = handler.cleanup

        const { isUndo, resumeSessionId, undoRollbackUuid, lineageType } = handler

        const msgSummary = body.messages?.map((m: any) => {
          const contentTypes = Array.isArray(m.content)
            ? m.content.map((b: any) => b.type).join(",")
            : "string"
          return `${m.role}[${contentTypes}]`
        }).join(" → ")
        const msgCount = Array.isArray(body.messages) ? body.messages.length : 0
        const requestLogLine = `${requestMeta.requestId} adapter=${adapter.name} model=${shared.model} stream=${stream} tools=${body.tools?.length ?? 0} lineage=${lineageType} session=${resumeSessionId?.slice(0, 8) || "new"}${isUndo && undoRollbackUuid ? ` rollback=${undoRollbackUuid.slice(0, 8)}` : ""}${agentMode ? ` agent=${agentMode}` : ""} active=${sessionGate.active}/${sessionGate.unlimited ? "∞" : sessionGate.max} msgCount=${msgCount}`
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
          allMessages: shared.allMessages,
          isResume: handler.isResume,
          useJsonlFresh: handler.useJsonlFresh,
          passthrough: shared.initialPassthrough,
          directPromptMessages: handler.directPromptMessages,
        })

        const hooks = buildHookBundle({
          body,
          adapter,
          sdkAgents: shared.sdkAgents,
          passthrough: shared.initialPassthrough,
          blockingMode: handler.blockingMode,
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

        // Classic path supplies stale-session + complete callbacks. Ephemeral
        // passes {} so stale errors surface unrecoverably and storeSession is
        // skipped entirely.
        const callbacks: ExecutorCallbacks = isEphemeral ? {} : {
          onStaleSession: ({ sdkUuidMap, mode }) =>
            staleSessionRetryClassic(shared, sdkUuidMap, mode, undoRollbackUuid, resumeSessionId),
          onComplete: (sdkSessionId, sdkUuidMap, usage) =>
            persistClassicSession(shared, sdkSessionId, sdkUuidMap, usage),
        }

        if (!stream) {
          return await runNonStream(shared, handler, promptBundle, hooks, callbacks, env)
        }

        const res = runStream(shared, handler, promptBundle, hooks, callbacks, env, cleanupEphemeral)
        // Defer ephemeral cleanup to the ReadableStream's finally — SDK work
        // runs after we return this response and the outer finally fires too
        // early (before any JSONL bytes are read by the subprocess).
        ephemeralDeferredToStream = true
        return res
      } catch (error) {
        // Blocking-MCP protocol violation: client sent the wrong set of
        // tool_result ids. Return a crisp 400 without falling back, so the
        // client fixes its request instead of masking the bug.
        if (error instanceof BlockingProtocolMismatchError) {
          claudeLog("blocking.protocol_mismatch", {
            durationMs: Date.now() - requestStartAt,
            error: error.message,
          })
          return new Response(
            JSON.stringify({
              type: "error",
              error: { type: "invalid_request_error", message: error.message },
            }),
            { status: 400, headers: { "Content-Type": "application/json" } },
          )
        }

        const errMsg = error instanceof Error ? error.message : String(error)
        claudeLog("error.unhandled", {
          durationMs: Date.now() - requestStartAt,
          error: errMsg,
        })

        const classified = classifyError(errMsg)
        const envelope = buildErrorEnvelope(errMsg)
        claudeLog("proxy.error", { error: errMsg, classified: classified.type })

        recordRequestError(
          { requestMeta, requestStartAt, adapterName: adapter.name },
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
          mode: envBool("PASSTHROUGH") ? "passthrough" : "internal",
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
        mode: envBool("PASSTHROUGH") ? "passthrough" : "internal",
        plugin: { opencode: checkPluginConfigured() ? "configured" : "not-configured" },
      })
    } catch {
      return c.json({
        status: "degraded",
        error: "Could not verify auth status",
        mode: envBool("PASSTHROUGH") ? "passthrough" : "internal",
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
    // Evict all cached SDK sessions — they were started under the old profile's
    // credentials and cannot be reused with different auth.
    clearSessionCache()
    console.error(`[PROXY] Active profile switched to: ${body.profile} (session cache cleared)`)
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

  // --- OpenAI Chat Completions Compatibility ---
  // Translates OpenAI /v1/chat/completions requests to Anthropic format and
  // routes them through the internal /v1/messages handler via app.fetch().
  // No network roundtrip — Hono resolves the route in-process.
  app.post("/v1/chat/completions", async (c) => {
    const rawBody = await c.req.json() as Record<string, unknown>
    const anthropicBody = translateOpenAiToAnthropic(rawBody)

    if (!anthropicBody) {
      return c.json(
        { type: "error", error: { type: "invalid_request_error", message: "messages: Field required" } },
        400,
      )
    }

    const internalReq = new Request("http://internal/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(anthropicBody),
    })
    const internalRes = await app.fetch(internalReq)

    if (!internalRes.ok) {
      const errBody = await internalRes.text()
      return c.json(
        { type: "error", error: { type: "upstream_error", message: errBody } },
        internalRes.status as 400 | 401 | 429 | 500,
      )
    }

    const completionId = `chatcmpl-${randomUUID()}`
    const created = Math.floor(Date.now() / 1000)
    const model = (typeof rawBody.model === "string" && rawBody.model) ? rawBody.model : "claude-sonnet-4-6"

    if (!anthropicBody.stream) {
      const anthropicRes = await internalRes.json() as Record<string, unknown>
      return c.json(translateAnthropicToOpenAi(anthropicRes, completionId, model, created))
    }

    const encoder = new TextEncoder()
    const readable = new ReadableStream({
      async start(controller) {
        const reader = internalRes.body?.getReader()
        if (!reader) { controller.close(); return }

        const decoder = new TextDecoder()
        let buffer = ""
        let streamError: Error | null = null

        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break

            buffer += decoder.decode(value, { stream: true })
            const lines = buffer.split("\n")
            buffer = lines.pop() ?? ""

            for (const line of lines) {
              if (!line.startsWith("data: ")) continue
              const dataStr = line.slice(6).trim()
              if (!dataStr) continue

              let event: Record<string, unknown>
              try { event = JSON.parse(dataStr) as Record<string, unknown> }
              catch { continue }
              if (typeof event.type !== "string") continue

              const chunk = translateAnthropicSseEvent(event as { type: string } & Record<string, unknown>, completionId, model, created)
              if (chunk) controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`))
            }
          }
        } catch (err) {
          streamError = err instanceof Error ? err : new Error(String(err))
        } finally {
          if (!streamError) controller.enqueue(encoder.encode("data: [DONE]\n\n"))
          controller.close()
        }
      },
    })

    return new Response(readable, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      },
    })
  })

  // Returns the last observed token usage for a session, looked up by the Claude
  // session ID that was returned in a prior /v1/messages response body.
  app.get("/v1/sessions/:claudeSessionId/context-usage", (c) => {
    const claudeSessionId = c.req.param("claudeSessionId")
    const session = getSessionByClaudeId(claudeSessionId)
    if (!session) {
      return c.json({ error: "Session not found" }, 404)
    }
    if (!session.contextUsage) {
      return c.json({ error: "No usage data available for this session" }, 404)
    }
    return c.json({ session_id: claudeSessionId, context_usage: session.contextUsage })
  })

  // --- Session Recovery ---
  app.get("/v1/sessions/recover", (c) => {
    const sessions = listStoredSessions()
    if (sessions.length === 0) {
      return c.json({ error: "No sessions found in store" }, 404)
    }
    return c.json({
      sessions: sessions.map(s => ({
        key: s.key,
        claudeSessionId: s.claudeSessionId,
        previousClaudeSessionId: s.previousClaudeSessionId,
        createdAt: new Date(s.createdAt).toISOString(),
        lastUsedAt: new Date(s.lastUsedAt).toISOString(),
        messageCount: s.messageCount,
        recoverCommand: `claude --resume ${s.claudeSessionId}`,
        ...(s.previousClaudeSessionId ? {
          recoverPreviousCommand: `claude --resume ${s.previousClaudeSessionId}`,
        } : {}),
      })),
    })
  })

  app.get("/v1/sessions/:key/recover", (c) => {
    const key = c.req.param("key")
    const recovery = lookupSessionRecovery(key)
    if (!recovery) {
      return c.json({ error: "Session not found", key }, 404)
    }
    return c.json({
      key,
      claudeSessionId: recovery.claudeSessionId,
      previousClaudeSessionId: recovery.previousClaudeSessionId,
      createdAt: new Date(recovery.createdAt).toISOString(),
      lastUsedAt: new Date(recovery.lastUsedAt).toISOString(),
      messageCount: recovery.messageCount,
      recoverCommand: `claude --resume ${recovery.claudeSessionId}`,
      ...(recovery.previousClaudeSessionId ? {
        recoverPreviousCommand: `claude --resume ${recovery.previousClaudeSessionId}`,
        note: "Previous session was replaced — if your current session has lost context, try the previous session ID.",
      } : {}),
    })
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
