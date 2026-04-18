import { Hono } from "hono"
import { cors } from "hono/cors"
import { serve } from "@hono/node-server"
import type { Server } from "node:http"
import { query } from "@anthropic-ai/claude-agent-sdk"
import type { Context } from "hono"
import { DEFAULT_PROXY_CONFIG } from "./types"
import { envBool, env as readEnv } from "../env"
import type { ProxyConfig, ProxyInstance, ProxyServer } from "./types"
export type { ProxyConfig, ProxyInstance, ProxyServer }
import { claudeLog } from "../logger"
import { exec as execCallback } from "child_process"
import { promisify } from "util"
import { tmpdir } from "node:os"
import { mkdirSync } from "node:fs"
import { join } from "node:path"

import { randomUUID } from "crypto"
import { withClaudeLogContext } from "../logger"
import { createPassthroughMcpServer, stripMcpPrefix, PASSTHROUGH_MCP_NAME, PASSTHROUGH_MCP_PREFIX } from "./passthroughTools"

import { telemetryStore, diagnosticLog, createTelemetryRoutes, landingHtml } from "../telemetry"
import type { RequestMetric } from "../telemetry"
import { classifyError, isStaleSessionError, isRateLimitError, isMaxTurnsError, isMaxOutputTokensError, isExtraUsageRequiredError, isExpiredTokenError } from './errors'
import { refreshOAuthToken } from "./tokenRefresh"
import { checkPluginConfigured } from "./setup"
import { resolveModel, resolveClaudeExecutableAsync, isClosedControllerError, getClaudeAuthStatusAsync, getAuthCacheInfo, hasExtendedContext, stripExtendedContext, recordExtendedContextUnavailable } from "./models"
import { translateOpenAiToAnthropic, translateAnthropicToOpenAi, translateAnthropicSseEvent } from "./openai"
import { getLastUserMessage, hasMultimodalContent, serializeToolResultContentToText, nextMultimodalLabel, type MultimodalCounter } from "./messages"
import { detectAdapter } from "./adapters/detect"
import { buildQueryOptions, type QueryContext } from "./query"
import { resolveProfile, listProfiles, setActiveProfile, getActiveProfileId, getEffectiveProfiles, restoreActiveProfile } from "./profiles"
import { filterBetasForProfile } from "./betas"
import { obfuscateSystemMessage, crEncode } from "./obfuscate"
import { createFileChangeHook, extractFileChangesFromMessages, formatFileChangeSummary, type FileChange } from "./fileChanges"
import {
  computeLineageHash,
  hashMessage,
  computeMessageHashes,
  type LineageResult,
  type TokenUsage,
} from "./session/lineage"
// Re-export for backwards compatibility (existing tests import from here)

import { lookupSession, storeSession, clearSessionCache, getMaxSessionsLimit, evictSession, getSessionByClaudeId } from "./session/cache"
import { prepareFreshSession, deleteSessionTranscript, backupSessionTranscript } from "./session/transcript"
import { ephemeralSessionIdPool } from "./session/ephemeralPool"
import { lookupSessionRecovery, listStoredSessions } from "./sessionStore"
// Re-export for backwards compatibility (existing tests import from here)
export { computeLineageHash, hashMessage, computeMessageHashes }
export { clearSessionCache, getMaxSessionsLimit }
export type { LineageResult }











const exec = promisify(execCallback)

// Empty sandbox directory for SDK subprocess — avoids picking up
// CLAUDE.md or other project files from the deployment directory.
const SANDBOX_DIR = join(tmpdir(), "meridian-sandbox")
mkdirSync(SANDBOX_DIR, { recursive: true })

let claudeExecutable = ""

/**
 * Normalize a thinking config object so both snake_case (Anthropic API)
 * and camelCase (Agent SDK) field names are accepted.
 * e.g. { type: "enabled", budget_tokens: 21333 } → { type: "enabled", budgetTokens: 21333 }
 */
function normalizeThinking(raw: any): QueryContext['thinking'] | undefined {
  if (!raw || typeof raw !== "object" || !raw.type) return undefined
  const display = raw.display === "summarized" || raw.display === "omitted" ? raw.display : undefined
  if (raw.type === "enabled") {
    const budget = raw.budgetTokens ?? raw.budget_tokens
    return {
      type: "enabled",
      ...(budget !== undefined ? { budgetTokens: budget } : {}),
      ...(display ? { display } : {}),
    }
  }
  if (raw.type === "adaptive") {
    return { type: "adaptive", ...(display ? { display } : {}) }
  }
  if (raw.type === "disabled") {
    return { type: "disabled" }
  }
  return undefined
}

/**
 * Extract the text content of a message, serializing tool_use/tool_result
 * blocks as XML tags. Returns raw content without a role prefix.
 */
function extractMessageContent(m: any, toolNameById: Map<string, string>, counter?: MultimodalCounter, toolPrefix?: string): string {
  const encodeText = m.role === "user" ? crEncode : (s: string) => s
  if (typeof m.content === "string") return encodeText(m.content)
  if (Array.isArray(m.content)) {
    const parts: string[] = []
    let i = 0
    while (i < m.content.length) {
      const block = m.content[i]
      if (block.type === "text" && block.text) {
        parts.push(encodeText(block.text))
        i++
      } else if (block.type === "tool_use") {
        const invokes: string[] = []
        while (i < m.content.length && m.content[i].type === "tool_use") {
          const b = m.content[i]
          const params = Object.entries(b.input ?? {}).map(([k, v]: [string, any]) =>
            `<parameter name="${k}">${typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? String(v) : JSON.stringify(v)}</parameter>`
          ).join("\n")
          const name = toolNameById.get(b.id) ?? b.name
          invokes.push(`<invoke name="${name}">\n${params}\n</invoke>`)
          i++
        }
        parts.push(`<function_calls>\n${invokes.join("\n")}\n</function_calls>`)
      } else if (block.type === "tool_result") {
        const results: string[] = []
        while (i < m.content.length && m.content[i].type === "tool_result") {
          const b = m.content[i]
          const body = counter ? serializeToolResultContentToText(b.content, counter, toolPrefix) : (typeof b.content === "string" ? b.content : JSON.stringify(b.content))
          results.push(b.is_error ? `<error>${encodeText(body)}</error>` : `<output>${encodeText(body)}</output>`)
          i++
        }
        parts.push(`<function_results>\n${results.join("\n")}\n</function_results>`)
      } else if (block.type === "image") {
        parts.push(counter ? `${nextMultimodalLabel("image", counter)}: attached` : "(image was attached)")
        i++
      } else if (block.type === "document") {
        parts.push(counter ? `${nextMultimodalLabel("document", counter)}: attached` : "(document was attached)")
        i++
      } else if (block.type === "file") {
        parts.push(counter ? `${nextMultimodalLabel("file", counter)}: attached` : "(file was attached)")
        i++
      } else {
        i++
      }
    }
    return parts.filter(Boolean).join("\n")
  }
  return encodeText(String(m.content))
}

/** Convert a message to an XML-tagged turn for conversation history. */
function convertMessageToText(m: any, toolNameById: Map<string, string>, counter?: MultimodalCounter, toolPrefix?: string): string {
  const role = m.role === "assistant" ? "assistant" : "user"
  return `<turn role="${role}">\n${extractMessageContent(m, toolNameById, counter, toolPrefix)}\n</turn>`
}


/**
 * Build a text prompt from messages, wrapping all but the last user message
 * in <conversation_history> to separate history from the current request.
 */
function buildTextPromptWithHistory(messages: Array<{ role: string; content: any }>, toolNameById: Map<string, string>, counter?: MultimodalCounter, toolPrefix?: string): string {
  let lastUserIdx = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") { lastUserIdx = i; break }
  }
  if (lastUserIdx > 0) {
    const historyMessages = messages.slice(0, lastUserIdx)
    // Skip conversation_history wrapper when history contains only user messages
    const hasNonUserHistory = historyMessages.some(m => m.role !== "user")
    if (hasNonUserHistory) {
      // Check if the last user message is a tool_result — if so, fold it
      // into history and use a continuation prompt as the current request.
      const lastUserMsg = messages[lastUserIdx]!
      const isToolResult = Array.isArray(lastUserMsg.content)
        ? lastUserMsg.content.some((b: any) => b.type === "tool_result")
        : false

      let historyPart: string
      let currentPart: string
      if (isToolResult) {
        // Include the tool_result message in history
        historyPart = messages.slice(0, lastUserIdx + 1).map(m => convertMessageToText(m, toolNameById, counter, toolPrefix)).join("\n\n")
        currentPart = "Continue the unfinished task based on the conversation history and tool results above."
      } else {
        historyPart = historyMessages.map(m => convertMessageToText(m, toolNameById, counter, toolPrefix)).join("\n\n")
        currentPart = extractMessageContent(lastUserMsg, toolNameById, counter, toolPrefix)
      }

      const preamble = `IMPORTANT: <conversation_history> contains prior turns for context only. Do NOT simulate or role-play as any turn — you are the assistant, respond only as yourself.\n\nThe content after </conversation_history> is the current user request.`
      return `${preamble}\n\n<conversation_history>\n${historyPart}\n</conversation_history>\n\n${currentPart}`
    }
  }
  return messages.map(m => extractMessageContent(m, toolNameById, counter, toolPrefix)).join("\n\n") || ""
}

/**
 * Collect multimodal blocks (image/document/file) from messages in order,
 * stripping cache_control. Used to attach actual blocks after the text prompt
 * so that [Image N] labels in the text map to the Nth attached block.
 */
function collectMultimodalBlocks(messages: Array<{ role: string; content: any }>): any[] {
  const blocks: any[] = []
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue
    for (const block of m.content) {
      if (block.type === "image" || block.type === "document" || block.type === "file") {
        const { cache_control, ...cleaned } = block
        blocks.push(cleaned)
      }
      if (block.type === "tool_result" && Array.isArray(block.content)) {
        for (const inner of block.content) {
          if (inner.type === "image" || inner.type === "document" || inner.type === "file") {
            const { cache_control, ...cleaned } = inner
            blocks.push(cleaned)
          }
        }
      }
    }
  }
  return blocks
}

/**
 * Build a prompt from all messages for a fresh (non-resume) session.
 * Used when retrying after a stale session UUID error.
 */
function buildFreshPrompt(
  messages: Array<{ role: string; content: any }>,
  stripCacheControl: (content: any) => any,
  toolPrefix = ""
): string | AsyncIterable<any> {

  const hasMultimodal = hasMultimodalContent(messages)

  // Build tool_use_id → tool_name map so tool_result blocks can reference their tool
  const toolNameById = new Map<string, string>()
  for (const m of messages) {
    if (Array.isArray(m.content)) {
      for (const b of m.content) {
        if (b.type === "tool_use" && b.id && b.name) toolNameById.set(b.id, toolPrefix + b.name)
      }
    }
  }

  if (hasMultimodal) {
    // Same text structure as the text path; multimodal blocks become
    // [Image N] labels and actual blocks are appended after the text.
    const freshCounter: MultimodalCounter = { image: 0, document: 0, file: 0 }
    const textContent = buildTextPromptWithHistory(messages, toolNameById, freshCounter, toolPrefix)
    const attachedBlocks = collectMultimodalBlocks(messages)
    const structured = [{
      type: "user" as const,
      message: { role: "user" as const, content: [{ type: "text", text: textContent }, ...attachedBlocks] },
      parent_tool_use_id: null,
    }]
    return (async function* () { for (const msg of structured) yield msg })()
  }

  const freshCounter: MultimodalCounter = { image: 0, document: 0, file: 0 }
  return buildTextPromptWithHistory(messages, toolNameById, freshCounter, toolPrefix)
}

function logUsage(requestId: string, usage: TokenUsage): void {
  const fmt = (n: number) => n > 1000 ? `${Math.round(n / 1000)}k` : String(n)
  const parts = [
    `input=${fmt(usage.input_tokens ?? 0)}`,
    `output=${fmt(usage.output_tokens ?? 0)}`,
    ...(usage.cache_read_input_tokens ? [`cache_read=${fmt(usage.cache_read_input_tokens)}`] : []),
    ...(usage.cache_creation_input_tokens ? [`cache_write=${fmt(usage.cache_creation_input_tokens)}`] : []),
  ]
  console.error(`[PROXY] ${requestId} usage: ${parts.join(" ")}`)
}

export function createProxyServer(config: Partial<ProxyConfig> = {}): ProxyServer {
  const finalConfig = { ...DEFAULT_PROXY_CONFIG, ...config }

  // Restore persisted active profile from last session
  restoreActiveProfile(finalConfig.profiles)

  const app = new Hono()

  app.use("*", cors())

  app.get("/", (c) => {
    // API clients get JSON, browsers get the landing page
    const accept = c.req.header("accept") || ""
    if (accept.includes("application/json") && !accept.includes("text/html")) {
      return c.json({
        status: "ok",
        service: "meridian",
        format: "anthropic",
        endpoints: ["/v1/messages", "/messages", "/v1/chat/completions", "/telemetry", "/health"]
      })
    }
    return c.html(landingHtml)
  })

  // --- Concurrency Control ---
  // Each request spawns an SDK subprocess (cli.js, ~11MB). Spawning multiple
  // simultaneously can crash the process. Serialize SDK queries with a queue.
  const MAX_CONCURRENT_SESSIONS = parseInt((process.env.MERIDIAN_MAX_CONCURRENT ?? process.env.CLAUDE_PROXY_MAX_CONCURRENT) || "10", 10)
  let activeSessions = 0
  const sessionQueue: Array<{ resolve: () => void }> = []

  async function acquireSession(): Promise<void> {
    if (activeSessions < MAX_CONCURRENT_SESSIONS) {
      activeSessions++
      return
    }
    return new Promise<void>((resolve) => {
      sessionQueue.push({ resolve })
    })
  }

  function releaseSession(): void {
    activeSessions--
    const next = sessionQueue.shift()
    if (next) {
      activeSessions++
      next.resolve()
    }
  }

  const handleMessages = async (
    c: Context,
    requestMeta: { requestId: string; endpoint: string; queueEnteredAt: number; queueStartedAt: number }
  ) => {
    const requestStartAt = Date.now()

    return withClaudeLogContext({ requestId: requestMeta.requestId, endpoint: requestMeta.endpoint }, async () => {
      // Hoist adapter detection before try so it's available in the catch block for telemetry
      const adapter = detectAdapter(c)
      // Ephemeral mode cleanup handle — reassigned from inside try once we know
      // the pool id + working directory + backup flag. Hoisted out here so the
      // outer finally can call it (try-scoped lets aren't visible in finally).
      let cleanupEphemeral: () => Promise<void> = async () => {}
      let ephemeralDeferredToStream = false
      try {
        const body = await c.req.json()

        // Validate required fields
        if (!Array.isArray(body.messages)) {
          return c.json(
            { type: "error", error: { type: "invalid_request_error", message: "messages: Field required" } },
            400
          )
        }

        // Resolve profile: header > active > default > first configured
        const profile = resolveProfile(
          finalConfig.profiles,
          finalConfig.defaultProfile,
          c.req.header("x-meridian-profile") || undefined
        )

        const rawBetaHeader = c.req.header("anthropic-beta")
        let model = resolveModel(body.model || "sonnet", rawBetaHeader)
        const agentMode = c.req.header("x-opencode-agent-mode") ?? null
        const outputFormat = body.output_config?.format
        if (outputFormat?.schema?.$schema) delete outputFormat.schema.$schema
        // Allow adapter to override streaming preference (e.g. LiteLLM requires non-streaming)
        const adapterStreamPref = adapter.prefersStreaming?.(body)
        const stream = adapterStreamPref !== undefined ? adapterStreamPref : (body.stream ?? false)
        // Default to empty sandbox dir to avoid picking up CLAUDE.md from
        // the deployment directory (e.g. /app in Docker).
        const workingDirectory = (process.env.MERIDIAN_WORKDIR ?? process.env.CLAUDE_PROXY_WORKDIR) || SANDBOX_DIR

        // Strip env vars that would cause the SDK subprocess to loop back through
        // the proxy instead of using its native Claude Max auth. Also strip vars
        // that cause unwanted SDK plugin/feature loading.
        const {
          CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS,
          ANTHROPIC_API_KEY: _dropApiKey,
          ANTHROPIC_BASE_URL: _dropBaseUrl,
          ANTHROPIC_AUTH_TOKEN: _dropAuthToken,
          ...cleanEnv
        } = process.env

        // Overlay profile-specific env vars (e.g. CLAUDE_CONFIG_DIR for multi-account)
        const profileEnv = { ...cleanEnv, ...profile.env }

        let systemContext = ""
        if (body.system) {
          if (typeof body.system === "string") {
            systemContext = body.system
          } else if (Array.isArray(body.system)) {
            systemContext = body.system
              .filter((b: any) => b.type === "text" && b.text && !b.text.startsWith("x-anthropic-billing-header"))
              .map((b: any) => b.text)
              .join("\n")
          }
        }

        // --- SDK parameter passthrough ---
        // Extract effort, thinking, taskBudget from body (standard Anthropic API fields).
        // Header overrides take precedence over body values.
        const effortHeader = c.req.header("x-opencode-effort")
        const thinkingHeader = c.req.header("x-opencode-thinking")
        const taskBudgetHeader = c.req.header("x-opencode-task-budget")
        const betaFilter = filterBetasForProfile(rawBetaHeader, profile.type)
        if (betaFilter.stripped.length > 0) {
          console.error(`[PROXY] ${requestMeta.requestId} stripped anthropic-beta(s) for Max profile: ${betaFilter.stripped.join(", ")}`)
        }

        const explicitEffort = effortHeader
          || body.effort
          || body.output_config?.effort
          || undefined
        // Default to disabled — the SDK internally enables thinking when no
        // config is provided, which fails when max_tokens is below the 1024
        // budget_tokens minimum required by the API.
        let thinking: QueryContext['thinking'] = normalizeThinking(body.thinking) || { type: "disabled" }
        if (thinkingHeader !== undefined) {
          try {
            thinking = normalizeThinking(JSON.parse(thinkingHeader)) || thinking
          } catch (e) {
            console.error(`[PROXY] ${requestMeta.requestId} ignoring malformed x-opencode-thinking header: ${e instanceof Error ? e.message : String(e)}`)
          }
        }
        // Default effort to "high" when adaptive thinking is active but no
        // effort was explicitly provided — matches the Anthropic API default.
        const effort = explicitEffort
          || (thinking?.type === "adaptive" ? "high" : undefined)
        const parsedBudget = taskBudgetHeader ? Number.parseInt(taskBudgetHeader, 10) : NaN
        const taskBudget = Number.isFinite(parsedBudget)
          ? { total: parsedBudget }
          : body.task_budget ? { total: body.task_budget.total ?? body.task_budget } : undefined
        const betas = betaFilter.forwarded

        // Session resume: look up cached Claude SDK session and classify mutation
        const agentSessionId = adapter.getSessionId(c)
        // Scope session keys by profile to isolate resume state across accounts.
        // For agents with session IDs (OpenCode): prefix the key.
        // For agents without (Pi): pass profile-scoped workingDirectory to fingerprint lookup.
        const profileSessionId = profile.id !== "default" && agentSessionId
          ? `${profile.id}:${agentSessionId}` : agentSessionId
        const profileScopedCwd = profile.id !== "default"
          ? `${workingDirectory}::profile=${profile.id}` : workingDirectory

        // Ephemeral one-shot JSONL mode: bypass the entire session cache/lineage
        // system. Every request writes a fresh JSONL (with a pooled UUID),
        // resumes from it, then deletes the file when done.
        const isEphemeral = envBool("EPHEMERAL_JSONL")
        const ephemeralBackup = envBool("EPHEMERAL_JSONL_BACKUP")
        let ephemeralId: string | undefined
        let ephemeralCleanupDone = false

        const lineageResult: LineageResult = isEphemeral
          ? { type: "diverged" } as LineageResult
          : lookupSession(profileSessionId, body.messages || [], profileScopedCwd)
        const isResume = lineageResult.type === "continuation" || lineageResult.type === "compaction"
        const isUndo = lineageResult.type === "undo"
        const cachedSession = lineageResult.type !== "diverged" ? lineageResult.session : undefined
        const resumeSessionId = cachedSession?.claudeSessionId
        // For undo: fork the session at the rollback point
        const undoRollbackUuid = isUndo && lineageResult.type === "undo" ? lineageResult.rollbackUuid : undefined

        // Debug: log request details
        const msgSummary = body.messages?.map((m: any) => {
          const contentTypes = Array.isArray(m.content)
            ? m.content.map((b: any) => b.type).join(",")
            : "string"
          return `${m.role}[${contentTypes}]`
        }).join(" → ")
        const lineageType = lineageResult.type === "diverged" && !cachedSession ? "new" : lineageResult.type
        const msgCount = Array.isArray(body.messages) ? body.messages.length : 0
        const requestLogLine = `${requestMeta.requestId} adapter=${adapter.name} model=${model} stream=${stream} tools=${body.tools?.length ?? 0} lineage=${lineageType} session=${resumeSessionId?.slice(0, 8) || "new"}${isUndo && undoRollbackUuid ? ` rollback=${undoRollbackUuid.slice(0, 8)}` : ""}${agentMode ? ` agent=${agentMode}` : ""} active=${activeSessions}/${MAX_CONCURRENT_SESSIONS} msgCount=${msgCount}`
        console.error(`[PROXY] ${requestLogLine} msgs=${msgSummary}`)
        diagnosticLog.session(`${requestLogLine}`, requestMeta.requestId)

        // Recovery logging: when a session diverges, check if the store has a
        // previous session ID that the user can recover via `claude --resume`.
        if (!isEphemeral && lineageResult.type === "diverged" && profileSessionId) {
          const recovery = lookupSessionRecovery(profileSessionId)
          if (recovery) {
            const prevId = recovery.previousClaudeSessionId || recovery.claudeSessionId
            const recoveryMsg = `${requestMeta.requestId} SESSION RECOVERY: previous conversation available. Run: claude --resume ${prevId}`
            console.error(`[PROXY] ${recoveryMsg}`)
            diagnosticLog.session(recoveryMsg, requestMeta.requestId)
          }
        }

        claudeLog("request.received", {
          model,
          stream,
          queueWaitMs: requestMeta.queueStartedAt - requestMeta.queueEnteredAt,
          messageCount: Array.isArray(body.messages) ? body.messages.length : 0,
          hasSystemPrompt: Boolean(body.system)
        })

      // Build SDK agent definitions and system context hint via adapter.
      // OpenCode parses the Task tool description; other adapters return empty.
      const sdkAgents = adapter.buildSdkAgents?.(body, adapter.getAllowedMcpTools()) ?? {}
      const validAgentNames = Object.keys(sdkAgents)
      if ((process.env.MERIDIAN_DEBUG ?? process.env.CLAUDE_PROXY_DEBUG) && validAgentNames.length > 0) {
        claudeLog("debug.agents", { names: validAgentNames, count: validAgentNames.length })
      }
      systemContext += adapter.buildSystemContextAddendum?.(body, sdkAgents) ?? ""
      // Obfuscate system context so the model doesn't misinterpret
      // embedded tags or special characters
      if (systemContext) {
        systemContext = obfuscateSystemMessage(systemContext)
      }



      // When resuming, only send new messages the SDK doesn't have.
      const allMessages = body.messages || []
      let messagesToConvert: typeof allMessages
      // For diverged (fresh) sessions, we optionally prewarm an SDK session
      // file: write history as structured JSONL, then resume from a fresh UUID.
      // This replaces the old XML-tag flattening so tool_use/tool_result and
      // multimodal blocks survive structurally instead of being stringified.
      let freshSessionId: string | undefined
      let freshMessageUuids: Array<string | null> | undefined

      if ((isResume || isUndo) && cachedSession) {
        if (isUndo && undoRollbackUuid) {
          // Undo with SDK rollback: the SDK will fork to the correct point,
          // so we only need to send the new user message.
          messagesToConvert = getLastUserMessage(allMessages)
        } else if (isResume) {
          const knownCount = cachedSession.messageCount || 0
          if (knownCount > 0 && knownCount < allMessages.length) {
            messagesToConvert = allMessages.slice(knownCount)
          } else {
            messagesToConvert = getLastUserMessage(allMessages)
          }
        } else {
          // Undo without UUID (legacy session) — fall back to last user message
          // to avoid the catastrophic flat text replay.
          messagesToConvert = getLastUserMessage(allMessages)
        }
      } else {
        messagesToConvert = allMessages
      }

      // JSONL-backed fresh session: applies to all diverged multi-message
      // requests, including passthrough. Writes history to
      // ~/.claude/projects/<cwd>/<uuid>.jsonl and lets the SDK resume from that
      // UUID with only the final user message as the prompt. The SDK's resume
      // mechanism is independent of tool-execution mode, so passthrough
      // benefits from structured history (tool_use/tool_result chains preserved)
      // the same way internal mode does. Feature flag (default on) allows
      // rollback to the old flat-text path.
      //
      // Passthrough is needed here to decide whether to prefix tool_use.name
      // in the JSONL — declared early so this branch can read it.
      const adapterPassthroughEarly = adapter.usesPassthrough?.()
      const passthroughForJsonl = adapterPassthroughEarly !== undefined
        ? adapterPassthroughEarly
        : Boolean((process.env.MERIDIAN_PASSTHROUGH ?? process.env.CLAUDE_PROXY_PASSTHROUGH))

      const jsonlFlag = readEnv("USE_JSONL_SESSIONS")
      const jsonlEnabled = jsonlFlag !== "0" && jsonlFlag !== "false" && jsonlFlag !== "no"
      // Ephemeral mode writes a JSONL for every request — even a single user
      // message. buildJsonlLines emits [user, synthetic-assistant] for the
      // lone-user case so resume has a valid chain and the user row receives
      // the cache breakpoint, letting the first call establish prompt cache.
      // The non-ephemeral diverged path still requires >=2 messages because
      // single-message starts go through the legacy fresh-session route
      // (which then gets stored in the session cache for continuation).
      const useJsonlFresh = (isEphemeral && allMessages.length >= 1)
        || (lineageResult.type === "diverged" && jsonlEnabled && allMessages.length > 1)

      if (isEphemeral) {
        // Pool-allocated session id: reuse a previously-released UUID if the
        // pool has one, otherwise mint a fresh one. The JSONL file at this
        // id is fully overwritten by prepareFreshSession before the SDK
        // subprocess is invoked, so reuse across serial requests is safe.
        ephemeralId = ephemeralSessionIdPool.acquire()
        claudeLog("session.ephemeral.acquired", {
          sessionId: ephemeralId,
          poolStats: ephemeralSessionIdPool.stats(),
        })
      }

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
          messagesToConvert = [{
            role: "user",
            content: prep.lastUserPrompt,
          }]
          claudeLog("session.jsonl_fresh", {
            sessionId: prep.sessionId,
            messageCount: allMessages.length,
            wroteTranscript: prep.wroteTranscript,
            ephemeral: isEphemeral,
          })
        } catch (e) {
          const errMsg = e instanceof Error ? e.message : String(e)
          console.error(`[PROXY] ${requestMeta.requestId} jsonl_fresh_failed, fallback to flat text: ${errMsg}`)
          claudeLog("session.jsonl_fresh_failed", { error: errMsg, ephemeral: isEphemeral })
          freshSessionId = undefined
          freshMessageUuids = undefined
          // Keep messagesToConvert = allMessages (already set above)
          // Pool ID stays acquired — cleanup finally will release it (no file to delete).
        }
      }

      // Install the ephemeral cleanup closure on the outer-scoped variable so
      // the outer finally can call it. Idempotent via ephemeralCleanupDone.
      // Runs after the SDK subprocess has closed. The SDK reads the JSONL at
      // resume time and does not re-read the file afterwards, so deleting
      // post-response is safe.
      cleanupEphemeral = async () => {
        if (ephemeralCleanupDone || !ephemeralId) return
        ephemeralCleanupDone = true
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


      // Check if any messages contain multimodal content (images, documents, files)
      // Also checks inside tool_result.content for nested image/document/file blocks
      const hasMultimodal = hasMultimodalContent(messagesToConvert ?? [])

      // Build tool_use_id → tool_name map so tool_result blocks can reference their tool.
      // Scan allMessages (not just messagesToConvert) because in undo/fallback paths
      // messagesToConvert may only contain the last user message with tool_result blocks
      // whose corresponding tool_use lives in the prefix outside the slice.
      const toolNameById = new Map<string, string>()
      for (const m of allMessages) {
        if (Array.isArray(m.content)) {
          for (const b of m.content as any[]) {
            if (b.type === "tool_use" && b.id && b.name) toolNameById.set(b.id, b.name)
          }
        }
      }

      // --- Passthrough mode ---
      // When enabled, ALL tool execution is forwarded to OpenCode instead of
      // being handled internally. This enables multi-model agent delegation
      // (e.g., oracle on GPT-5.2, explore on Gemini via oh-my-opencode).
      // Adapter can override the global passthrough env var per-agent.
      // Droid always uses internal mode; OpenCode defers to the env var.
      const adapterPassthrough = adapter.usesPassthrough?.()
      let passthrough = adapterPassthrough !== undefined
        ? adapterPassthrough
        : Boolean((process.env.MERIDIAN_PASSTHROUGH ?? process.env.CLAUDE_PROXY_PASSTHROUGH))

      // In passthrough mode, prefix tool names so they match the SDK's MCP tool names
      const toolPrefixStr = passthrough ? PASSTHROUGH_MCP_PREFIX : ""
      if (passthrough) {
        for (const [id, name] of toolNameById) {
          toolNameById.set(id, PASSTHROUGH_MCP_PREFIX + name)
        }
      }

      // Strip cache_control from content blocks — the SDK manages its own caching
      // and OpenCode's ttl='1h' blocks conflict with the SDK's ttl='5m' blocks
      function stripCacheControl(content: any): any {
        if (!Array.isArray(content)) return content
        return content.map((block: any) => {
          let cleaned = block
          if (block.cache_control) {
            const { cache_control, ...rest } = block
            cleaned = rest
          }
          if (cleaned.type === "tool_result" && Array.isArray(cleaned.content)) {
            return { ...cleaned, content: stripCacheControl(cleaned.content) }
          }
          return cleaned
        })
      }

      // Build the prompt — either structured (multimodal) or text.
      // Structured prompts are stored as arrays so they can be replayed on retry.
      let structuredMessages: Array<{ type: "user"; message: { role: string; content: any }; parent_tool_use_id: null }> | undefined
      let textPrompt: string | undefined

      // Counter for multimodal index labels — shared across all code paths
      const mmCounter: MultimodalCounter = { image: 0, document: 0, file: 0 }

      if (useJsonlFresh && messagesToConvert.length === 1 && messagesToConvert[0]?.role === "user") {
        // jsonl-fresh path: the conversation history is already in the JSONL
        // (structured tool_use/tool_result blocks intact via buildJsonlLines).
        // Pass the last user content as a structured SDK user message so the
        // CLI appends it verbatim — flattening to <function_results> XML here
        // would defeat the point of writing a structured transcript.
        const lastContent = messagesToConvert[0]!.content
        const content = typeof lastContent === "string"
          ? [{ type: "text", text: lastContent }]
          : (Array.isArray(lastContent)
              ? lastContent
              : [{ type: "text", text: String(lastContent ?? "") }])
        structuredMessages = [{
          type: "user" as const,
          message: { role: "user" as const, content },
          parent_tool_use_id: null,
        }]
      } else if (hasMultimodal) {
        // Same text structure as the text path. Multimodal blocks become
        // [Image N]/[Document N]/[File N] labels in the text; actual blocks
        // are appended after the text content in a single structured message.
        let sourceMessages: typeof messagesToConvert
        if (isResume) {
          const skipLeadingAssistant = messagesToConvert[0]?.role === "assistant"
          sourceMessages = skipLeadingAssistant ? messagesToConvert.slice(1) : messagesToConvert
        } else {
          sourceMessages = messagesToConvert
        }

        const textContent = buildTextPromptWithHistory(sourceMessages, toolNameById, mmCounter, toolPrefixStr)
        const attachedBlocks = collectMultimodalBlocks(sourceMessages)

        structuredMessages = [{
          type: "user" as const,
          message: { role: "user" as const, content: [{ type: "text", text: textContent }, ...attachedBlocks] },
          parent_tool_use_id: null,
        }]
      } else {
        // Text prompt — convert messages to string.
        // On resume, skip assistant messages — the SDK already has them in its
        // conversation history. This avoids duplicating tool_use inputs (which
        // can be large) that are already present as structured blocks in the SDK.
        if (isResume) {
          // Resume: the leading assistant message is the SDK's own response
          // (already in SDK history) — skip it. Remaining messages (user +
          // any external provider assistants) are formatted with the same
          // <conversation_history> wrapper as the fresh path for consistency.
          const skipLeadingAssistant = messagesToConvert[0]?.role === "assistant"
          const externalMessages = skipLeadingAssistant ? messagesToConvert.slice(1) : messagesToConvert
          textPrompt = buildTextPromptWithHistory(externalMessages, toolNameById, mmCounter, toolPrefixStr)
        } else {
          // First request: wrap prior history in <conversation_history> and keep
          // the last user message outside as the current request.
          textPrompt = buildTextPromptWithHistory(messagesToConvert, toolNameById, mmCounter, toolPrefixStr)
        }
      }

      // Create a fresh prompt value — can be called multiple times for retry
      function makePrompt(): string | AsyncIterable<any> {
        if (structuredMessages) {
          const msgs = structuredMessages
          return (async function* () { for (const msg of msgs) yield msg })()
        }
        return textPrompt!
      }

      const capturedToolUses: Array<{ id: string; name: string; input: any }> = []
      const fileChanges: FileChange[] = []

      // --- Tool type filtering (passthrough mode) ---
      // Filter out non-custom typed tools (API built-ins like web_search, computer_use).
      // Exception: single web_search tool → switch to internal SDK execution.
      let useBuiltinWebSearch = false
      if (passthrough && Array.isArray(body.tools) && body.tools.length > 0) {
        const hasNonCustomTools = body.tools.some((t: any) => t.type && t.type !== "custom")
        if (hasNonCustomTools) {
          if (body.tools.length === 1 && body.tools[0].type?.includes("web_search")) {
            useBuiltinWebSearch = true
            passthrough = false
            body.tools = []
          } else {
            body.tools = body.tools.filter((t: any) => !t.type || t.type === "custom")
          }
        }
      }

      // In passthrough mode, register OpenCode's tools as MCP tools so Claude
      // can actually call them (not just see them as text descriptions).
      let passthroughMcp: ReturnType<typeof createPassthroughMcpServer> | undefined
      if (passthrough && Array.isArray(body.tools) && body.tools.length > 0) {
        passthroughMcp = createPassthroughMcpServer(body.tools)
      }

      // In passthrough mode: block ALL tools, capture them for forwarding (agent-agnostic).
      // In normal mode: delegate hook construction to the adapter.
      // PostToolUse hook tracks file changes from MCP tools (internal mode only).
      // Catches write, edit, AND bash redirects (>, >>, tee, sed -i).
      const mcpPrefix = `mcp__${adapter.getMcpServerName()}__`
      const trackFileChanges = !(process.env.MERIDIAN_NO_FILE_CHANGES ?? process.env.CLAUDE_PROXY_NO_FILE_CHANGES)
      const fileChangeHook = trackFileChanges ? createFileChangeHook(fileChanges, mcpPrefix) : undefined

      // WebSearch: capture results from PostToolUse for synthetic SSE injection.
      // SDK's internal WebSearch sub-API-call events are not yielded to the outer
      // generator, so we intercept the final result via hook and synthesize native
      // server_tool_use + web_search_tool_result SSE events for the client.
      const pendingWebSearchResults: Array<{
        query: string
        results: Array<{ tool_use_id: string; content: Array<{ title: string; url: string }> }>
      }> = []
      const webSearchHook = useBuiltinWebSearch ? {
        matcher: "WebSearch",
        hooks: [async (input: any) => {
          const response = input.tool_response
          // SDK WebSearch tool returns { data: WebSearchOutput } — extract defensively
          const output = (response?.data ?? response) as Record<string, unknown> | undefined
          if (output && typeof output === "object") {
            const query = (output.query as string) ?? (input.tool_input as any)?.query ?? ""
            const results: typeof pendingWebSearchResults[number]["results"] = []
            if (Array.isArray(output.results)) {
              for (const r of output.results) {
                if (typeof r === "object" && r !== null && "tool_use_id" in r && Array.isArray((r as any).content)) {
                  results.push({ tool_use_id: (r as any).tool_use_id, content: (r as any).content })
                }
              }
            }
            pendingWebSearchResults.push({ query, results })
          }
          return {}
        }],
      } : undefined

      const postToolUseHooks: any[] = []
      if (fileChangeHook) postToolUseHooks.push(fileChangeHook)
      if (webSearchHook) postToolUseHooks.push(webSearchHook)

      const sdkHooks = passthrough
        ? {
            PreToolUse: [{
              matcher: "",  // Match ALL tools
              hooks: [async (input: any) => {
                capturedToolUses.push({
                  id: input.tool_use_id,
                  name: stripMcpPrefix(input.tool_name),
                  input: input.tool_input,
                })
                return {
                  decision: "block" as const,
                  reason: "Forwarding to client for execution",
                }
              }],
            }],
          }
        : {
            ...(adapter.buildSdkHooks?.(body, sdkAgents) ?? {}),
            ...(postToolUseHooks.length > 0 ? { PostToolUse: postToolUseHooks } : {}),
          }

        // Capture subprocess stderr for all paths — used to surface the real
        // failure message when the Claude subprocess exits with a non-zero code.
        const stderrLines: string[] = []
        const onStderr = (data: string) => {
          stderrLines.push(data.trimEnd())
          claudeLog("subprocess.stderr", { line: data.trimEnd() })
        }

        if (!stream) {
          // --- Pseudo non-stream path ---
          // Internally uses stream: true to get stream_event messages from the SDK,
          // then reassembles them into a single JSON response. This reuses the
          // streaming event model where max_tokens is handled cleanly by breaking
          // at the message_delta event, avoiding the SDK's internal 3-retry recovery
          // loop that plagues the native non-stream assistant message path.

          const contentBlocks: Array<Record<string, unknown>> = []
          const upstreamStartAt = Date.now()
          let firstChunkAt: number | undefined
          let currentSessionId: string | undefined
          let messageId: string | undefined

          // Accumulation state for reassembling stream events into content blocks
          let stopReason = "end_turn"
          // Usage: message_start has the full shape (input_tokens, cache_creation,
          // service_tier, inference_geo, etc.); message_delta only has output_tokens.
          // We capture the base from message_start and overlay output_tokens from message_delta.
          let baseUsage: Record<string, unknown> = {}
          let finalOutputTokens = 0
          let lastUsage: TokenUsage | undefined
          const skipBlockIndices = new Set<number>()
          const sdkIndexToContentIdx = new Map<number, number>()
          const jsonBuffers = new Map<number, string>()

          // outputFormat tracking (same as streaming path)
          const structuredOutputIds = new Set<string>()
          const structuredOutputIndices = new Set<number>()

          // Build SDK UUID map: start with previously stored UUIDs (if resuming)
          // or pre-populated JSONL UUIDs (if this is a fresh session we primed
          // with a jsonl transcript), then capture new ones from the response.
          // Declared outside try so storeSession (in the finally/after block)
          // can access it.
          const sdkUuidMap: Array<string | null> = cachedSession?.sdkMessageUuids
            ? [...cachedSession.sdkMessageUuids]
            : (freshMessageUuids ? [...freshMessageUuids] : new Array(allMessages.length - 1).fill(null))
          // Pad to current message count (the last user message has no UUID yet)
          while (sdkUuidMap.length < allMessages.length) sdkUuidMap.push(null)

          claudeLog("upstream.start", { mode: "non_stream", model })

          try {
            // Lazy-resolve executable if not already set (e.g. when using createProxyServer directly)
            if (!claudeExecutable) {
              claudeExecutable = await resolveClaudeExecutableAsync()
            }

            // Wrap SDK call with transparent retry for recoverable errors.
            // Uses stream: true to get stream_event messages (pseudo non-stream).
            const MAX_RATE_LIMIT_RETRIES = 2
            const RATE_LIMIT_BASE_DELAY_MS = 1000

            const response = (async function* () {
              let rateLimitRetries = 0

              let tokenRefreshed = false
              while (true) {
                let didYieldContent = false
                try {
                  for await (const event of query(buildQueryOptions({
                    prompt: makePrompt(), model, workingDirectory, systemContext, claudeExecutable,
                    passthrough, stream: true, sdkAgents, passthroughMcp, cleanEnv: profileEnv,
                    resumeSessionId: resumeSessionId ?? freshSessionId, isUndo, undoRollbackUuid, sdkHooks, adapter, outputFormat, thinking,
                    useBuiltinWebSearch, maxOutputTokens: body.max_tokens, onStderr,
                    effort, taskBudget, betas,
                  }))) {
                    if ((event as any).type === "stream_event") {
                      didYieldContent = true
                    }
                    yield event
                  }
                  return
                } catch (error) {
                  const errMsg = error instanceof Error ? error.message : String(error)

                  // maxTurns=1 in passthrough mode is expected — treat as normal completion
                  if (passthrough && isMaxTurnsError(errMsg)) return

                  // max_output_tokens: the SDK throws after streaming content.
                  // The message_delta with stop_reason: "max_tokens" was already yielded.
                  if (isMaxOutputTokensError(errMsg)) return

                  // Never retry after client-visible events — response is committed
                  if (didYieldContent) throw error

                  // Retry: stale undo UUID — evict session and start fresh (one-shot).
                  // In ephemeral mode this branch is unreachable (no session cache),
                  // but we still guard evictSession defensively.
                  if (isStaleSessionError(error) && !isEphemeral) {
                    claudeLog("session.stale_uuid_retry", {
                      mode: "non_stream",
                      rollbackUuid: undoRollbackUuid,
                      resumeSessionId,
                    })
                    console.error(`[PROXY] Stale session UUID, evicting and retrying as fresh session`)
                    evictSession(profileSessionId, profileScopedCwd, allMessages)
                    sdkUuidMap.length = 0
                    for (let i = 0; i < allMessages.length; i++) sdkUuidMap.push(null)

                    // Prefer jsonl-backed fresh resume to preserve structured history;
                    // fall back to flat-text buildFreshPrompt if the jsonl write fails.
                    let retryResumeId: string | undefined
                    let retryPrompt: string | AsyncIterable<any>
                    const retryViaJsonl = jsonlEnabled && allMessages.length > 1
                    if (retryViaJsonl) {
                      try {
                        const prep = await prepareFreshSession(allMessages, workingDirectory, {
                          model,
                          toolPrefix: passthrough ? PASSTHROUGH_MCP_PREFIX : undefined,
                          outputFormat: !!outputFormat,
                        })
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
                        retryPrompt = buildFreshPrompt(allMessages, stripCacheControl, passthrough ? PASSTHROUGH_MCP_PREFIX : "")
                      }
                    } else {
                      retryPrompt = buildFreshPrompt(allMessages, stripCacheControl, passthrough ? PASSTHROUGH_MCP_PREFIX : "")
                    }

                    yield* query(buildQueryOptions({
                      prompt: retryPrompt,
                      model, workingDirectory, systemContext, claudeExecutable,
                      passthrough, stream: true, sdkAgents, passthroughMcp, cleanEnv: profileEnv,
                      resumeSessionId: retryResumeId, isUndo: false, undoRollbackUuid: undefined, sdkHooks, adapter, outputFormat, thinking,
                      useBuiltinWebSearch, maxOutputTokens: body.max_tokens, onStderr,
                      effort, taskBudget, betas,
                    }))
                    return
                  }

                  // Extra Usage required: strip [1m], record 1-hour cooldown, and retry.
                  if (isExtraUsageRequiredError(errMsg) && hasExtendedContext(model)) {
                    const from = model
                    model = stripExtendedContext(model)
                    recordExtendedContextUnavailable()
                    claudeLog("upstream.context_fallback", {
                      mode: "non_stream",
                      from,
                      to: model,
                      reason: "extra_usage_required",
                    })
                    console.error(`[PROXY] ${requestMeta.requestId} extra usage required for [1m], falling back to ${model} (skipping [1m] for 1h)`)
                    continue
                  }

                  // Expired OAuth token: refresh once and retry
                  if (isExpiredTokenError(errMsg) && !tokenRefreshed) {
                    tokenRefreshed = true
                    const refreshed = await refreshOAuthToken()
                    if (refreshed) {
                      claudeLog("token_refresh.retrying", { mode: "non_stream" })
                      console.error(`[PROXY] ${requestMeta.requestId} OAuth token expired — refreshed, retrying`)
                      continue
                    }
                    // Refresh failed — fall through and surface the error
                  }

                  // Rate-limit retry: first strip [1m] (free, different tier), then backoff
                  if (isRateLimitError(errMsg)) {
                    if (hasExtendedContext(model)) {
                      const from = model
                      model = stripExtendedContext(model)
                      claudeLog("upstream.context_fallback", {
                        mode: "non_stream",
                        from,
                        to: model,
                        reason: "rate_limit",
                      })
                      console.error(`[PROXY] ${requestMeta.requestId} rate-limited on [1m], retrying with ${model}`)
                      continue
                    }
                    if (rateLimitRetries < MAX_RATE_LIMIT_RETRIES) {
                      rateLimitRetries++
                      const delay = RATE_LIMIT_BASE_DELAY_MS * Math.pow(2, rateLimitRetries - 1)
                      claudeLog("upstream.rate_limit_backoff", {
                        mode: "non_stream",
                        model,
                        attempt: rateLimitRetries,
                        maxAttempts: MAX_RATE_LIMIT_RETRIES,
                        delayMs: delay,
                      })
                      console.error(`[PROXY] ${requestMeta.requestId} rate-limited on ${model}, retry ${rateLimitRetries}/${MAX_RATE_LIMIT_RETRIES} in ${delay}ms`)
                      await new Promise(r => setTimeout(r, delay))
                      continue
                    }
                  }

                  throw error
                }
              }
            })()

            // --- Stream event accumulation loop ---
            // Reassemble stream_event messages into contentBlocks array.
            for await (const message of response) {
              // Capture session ID from SDK messages
              if ((message as any).session_id) {
                currentSessionId = (message as any).session_id
              }
              // Capture assistant UUID for undo rollback
              if (message.type === "assistant" && (message as any).uuid) {
                sdkUuidMap.push((message as any).uuid)
              }

              if (message.type !== "stream_event") continue

              if (!firstChunkAt) {
                firstChunkAt = Date.now()
                claudeLog("upstream.first_chunk", {
                  mode: "non_stream",
                  model,
                  ttfbMs: firstChunkAt - upstreamStartAt
                })
              }

              const event = (message as any).event
              const eventType = (event as any).type as string
              const eventIndex = (event as any).index as number | undefined

              // message_start: reset per-turn state, capture message ID and base usage
              if (eventType === "message_start") {
                if (!messageId) {
                  // First message_start
                  messageId = (event as any).message?.id
                  const startUsage = (event as any).message?.usage
                  if (startUsage && typeof startUsage === "object") {
                    baseUsage = { ...startUsage }
                  }
                }
                // Always reset per-turn index tracking — indices from the previous
                // turn are stale and would incorrectly skip new turn's blocks.
                skipBlockIndices.clear()
                sdkIndexToContentIdx.clear()
                continue
              }

              // message_stop: skip (we build our own response)
              if (eventType === "message_stop") continue

              // content_block_start: filtering + begin accumulation
              if (eventType === "content_block_start") {
                const block = { ...(event as any).content_block } as Record<string, unknown>


                // outputFormat: StructuredOutput → accumulate as text block
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
                    // Skip text blocks when outputFormat is set — only structured output matters
                    if (eventIndex !== undefined) skipBlockIndices.add(eventIndex)
                    continue
                  }
                }

                // Tool filtering (same as streaming path)
                if (block.type === "tool_use" && typeof block.name === "string") {
                  if (passthrough && (block.name as string).startsWith(PASSTHROUGH_MCP_PREFIX)) {
                    block.name = stripMcpPrefix(block.name as string)
                  } else if ((block.name as string).startsWith("mcp__")) {
                    if (eventIndex !== undefined) skipBlockIndices.add(eventIndex)
                    continue
                  } else if (useBuiltinWebSearch) {
                    // Skip SDK's internal WebSearch tool_use — synthetic blocks
                    // will be prepended from PostToolUse hook results
                    if (eventIndex !== undefined) skipBlockIndices.add(eventIndex)
                    continue
                  }
                }

                contentBlocks.push(block)
                if (eventIndex !== undefined) sdkIndexToContentIdx.set(eventIndex, contentBlocks.length - 1)
                continue
              }

              // Skip filtered blocks
              if (eventIndex !== undefined && skipBlockIndices.has(eventIndex)) continue

              // content_block_delta: accumulate into the matching content block
              if (eventType === "content_block_delta") {
                const delta = (event as any).delta
                if (eventIndex === undefined) continue
                const blockIdx = sdkIndexToContentIdx.get(eventIndex)
                if (blockIdx === undefined) continue

                // outputFormat: StructuredOutput input_json_delta → text
                if (outputFormat && structuredOutputIndices.has(eventIndex)) {
                  if (delta?.type === "input_json_delta" && delta.partial_json) {
                    (contentBlocks[blockIdx] as any).text += delta.partial_json
                  }
                } else if (delta?.type === "text_delta" && delta.text) {
                  (contentBlocks[blockIdx] as any).text += delta.text
                } else if (delta?.type === "input_json_delta" && delta.partial_json) {
                  // Accumulate JSON fragments for tool_use input
                  const buf = jsonBuffers.get(eventIndex) ?? ""
                  jsonBuffers.set(eventIndex, buf + delta.partial_json)
                } else if (delta?.type === "thinking_delta" && delta.thinking) {
                  (contentBlocks[blockIdx] as any).thinking += delta.thinking
                } else if (delta?.type === "signature_delta" && delta.signature) {
                  (contentBlocks[blockIdx] as any).signature += delta.signature
                }
                continue
              }

              // content_block_stop: finalize tool_use input from JSON buffer
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

              // message_delta: capture output_tokens/stop_reason, handle max_tokens
              if (eventType === "message_delta") {
                const deltaStopReason = (event as any).delta?.stop_reason as string | undefined
                const deltaUsage = (event as any).usage
                if (deltaUsage?.output_tokens != null) {
                  finalOutputTokens = deltaUsage.output_tokens as number
                }
                if (deltaUsage) lastUsage = { ...lastUsage, ...deltaUsage }

                // When outputFormat is set, skip intermediate message_delta events
                // (multiple turns for StructuredOutput). Only capture the last output_tokens.
                if (outputFormat) continue

                // max_tokens: capture and break — clean termination
                if (deltaStopReason === "max_tokens") {
                  stopReason = "max_tokens"
                  break
                }

                // Skip intermediate tool_use deltas for internal MCP tools
                if (deltaStopReason === "tool_use" && (skipBlockIndices.size > 0 || useBuiltinWebSearch)) {
                  continue
                }

                if (deltaStopReason) stopReason = deltaStopReason
              }
            }

            claudeLog("upstream.completed", {
              mode: "non_stream",
              model,
              durationMs: Date.now() - upstreamStartAt
            })
            if (lastUsage) logUsage(requestMeta.requestId, lastUsage)
          } catch (error) {
            const stderrOutput = stderrLines.join("\n").trim()
            if (stderrOutput && error instanceof Error && !error.message.includes(stderrOutput)) {
              error.message = `${error.message}\nSubprocess stderr: ${stderrOutput}`
            }
            claudeLog("upstream.failed", {
              mode: "non_stream",
              model,
              durationMs: Date.now() - upstreamStartAt,
              error: error instanceof Error ? error.message : String(error),
              ...(stderrOutput ? { stderr: stderrOutput } : {})
            })
            throw error
          }

          // In passthrough mode, add captured tool_use blocks from the hook
          // (the SDK may not include them in content after blocking)
          if (passthrough && capturedToolUses.length > 0) {
            for (const tu of capturedToolUses) {
              // Skip StructuredOutput when outputFormat is set — handled separately
              if (outputFormat && tu.name === "StructuredOutput") continue
              // Only add if not already in contentBlocks
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

          // When outputFormat is set, the StructuredOutput was already accumulated
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

          // as a text block during stream processing. Safety fallback: if a
          // tool_use block with name "StructuredOutput" still exists, convert it.
          if (outputFormat) {
            const structuredBlock = contentBlocks.find(
              (b) => b.type === "tool_use" && b.name === "StructuredOutput"
            )
            if (structuredBlock) {
              const jsonText = JSON.stringify((structuredBlock as Record<string, unknown>).input)
              contentBlocks.length = 0
              contentBlocks.push({ type: "text", text: jsonText })
            }
          }

          // Determine stop_reason from captured message_delta, with fallback
          const hasToolUse = contentBlocks.some((b) => b.type === "tool_use")
          const finalStopReason = stopReason === "end_turn" && hasToolUse ? "tool_use" : stopReason

          // Append file change summary:
          // - Internal mode: fileChanges populated by PostToolUse hook
          // - Passthrough mode: scan body.messages for executed tool_use blocks
          if (trackFileChanges) {
            if (passthrough && finalStopReason === "end_turn" && adapter.extractFileChangesFromToolUse) {
              const passthroughChanges = extractFileChangesFromMessages(
                body.messages || [],
                adapter.extractFileChangesFromToolUse.bind(adapter)
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

          const totalDurationMs = Date.now() - requestStartAt

          claudeLog("response.completed", {
            mode: "non_stream",
            model,
            durationMs: totalDurationMs,
            contentBlocks: contentBlocks.length,
            hasToolUse
          })

          const nonStreamQueueWaitMs = requestMeta.queueStartedAt - requestMeta.queueEnteredAt
          telemetryStore.record({
            requestId: requestMeta.requestId,
            timestamp: Date.now(),
            adapter: adapter.name,
            model,
            requestModel: body.model || undefined,
            mode: "non-stream",
            isResume,
            isPassthrough: passthrough,
            isEphemeral,
            lineageType,
            messageCount: allMessages.length,
            sdkSessionId: currentSessionId || resumeSessionId,
            status: 200,
            queueWaitMs: nonStreamQueueWaitMs,
            proxyOverheadMs: upstreamStartAt - requestStartAt - nonStreamQueueWaitMs,
            ttfbMs: firstChunkAt ? firstChunkAt - upstreamStartAt : null,
            upstreamDurationMs: Date.now() - upstreamStartAt,
            totalDurationMs,
            contentBlocks: contentBlocks.length,
            textEvents: 0,
            error: null,
          })

          // Store session for future resume — merge baseUsage (from message_start)
          // with lastUsage (from message_delta) for complete context usage tracking
          const mergedUsage = (baseUsage || lastUsage)
            ? { ...baseUsage, ...lastUsage } as import("./session/lineage").TokenUsage
            : undefined
          if (!isEphemeral && currentSessionId) {
            storeSession(profileSessionId, body.messages || [], currentSessionId, profileScopedCwd, sdkUuidMap, mergedUsage)
          }

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
            }
          })
        }

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

            claudeLog("upstream.start", { mode: "stream", model })

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
                  error: error instanceof Error ? error.message : String(error)
                })
                throw error
              }
            }

            // Build SDK UUID map for the streaming path (declared before try for storeSession access).
            // When a jsonl fresh transcript was primed, the per-history UUIDs are
            // captured in freshMessageUuids so they flow into storeSession.
            const sdkUuidMap: Array<string | null> = cachedSession?.sdkMessageUuids
              ? [...cachedSession.sdkMessageUuids]
              : (freshMessageUuids ? [...freshMessageUuids] : new Array(allMessages.length - 1).fill(null))
            while (sdkUuidMap.length < allMessages.length) sdkUuidMap.push(null)

            let messageStartEmitted = false
            let lastUsage: TokenUsage | undefined

            try {
              let currentSessionId: string | undefined
              // Same transparent retry wrapper as the non-streaming path.
              // Rate-limit retry strategy:
              //   1. Strip [1m] context (immediate, different model tier)
              //   2. Backoff retries on base model (1s, 2s — exponential)
              const MAX_RATE_LIMIT_RETRIES = 2
              const RATE_LIMIT_BASE_DELAY_MS = 1000

              const response = (async function* () {
                let rateLimitRetries = 0
                let tokenRefreshed = false

                while (true) {
                  // Track whether client-visible SSE events were yielded.
                  // The SDK emits metadata events (session_id, internal routing)
                  // before the API call — those are NOT client-visible and must
                  // not prevent retry. Only stream_event types become SSE output.
                  let didYieldClientEvent = false
                  try {
                    for await (const event of query(buildQueryOptions({
                      prompt: makePrompt(), model, workingDirectory, systemContext, claudeExecutable,
                      passthrough, stream: true, sdkAgents, passthroughMcp, cleanEnv: profileEnv,
                      resumeSessionId: resumeSessionId ?? freshSessionId, isUndo, undoRollbackUuid, sdkHooks, adapter, outputFormat, thinking,
                      useBuiltinWebSearch, maxOutputTokens: body.max_tokens, onStderr,
                      effort, taskBudget, betas,
                    }))) {
                      if ((event as any).type === "stream_event") {
                        didYieldClientEvent = true
                      }
                      yield event
                    }
                    return
                  } catch (error) {
                    const errMsg = error instanceof Error ? error.message : String(error)

                    // maxTurns=1 in passthrough mode is expected — treat as normal completion
                    if (passthrough && isMaxTurnsError(errMsg)) return

                    // max_output_tokens: the SDK throws after streaming content.
                    // Treat as normal completion — the stream already forwarded content
                    // and the message_delta with stop_reason: "max_tokens".
                    if (isMaxOutputTokensError(errMsg)) return

                    // Never retry after client-visible SSE events — response is committed
                    if (didYieldClientEvent) throw error

                    // Retry: stale undo UUID — evict and start fresh (one-shot).
                    // Ephemeral mode never hits this (no session cache, no undo UUID),
                    // but guarded defensively.
                    if (isStaleSessionError(error) && !isEphemeral) {
                      claudeLog("session.stale_uuid_retry", {
                        mode: "stream",
                        rollbackUuid: undoRollbackUuid,
                        resumeSessionId,
                      })
                      console.error(`[PROXY] Stale session UUID, evicting and retrying as fresh session`)
                      evictSession(profileSessionId, profileScopedCwd, allMessages)
                      sdkUuidMap.length = 0
                      for (let i = 0; i < allMessages.length; i++) sdkUuidMap.push(null)

                      let retryResumeId: string | undefined
                      let retryPrompt: string | AsyncIterable<any>
                      const retryViaJsonl = jsonlEnabled && allMessages.length > 1
                      if (retryViaJsonl) {
                        try {
                          const prep = await prepareFreshSession(allMessages, workingDirectory, {
                            model,
                            toolPrefix: passthrough ? PASSTHROUGH_MCP_PREFIX : undefined,
                            outputFormat: !!outputFormat,
                          })
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
                          retryPrompt = buildFreshPrompt(allMessages, stripCacheControl, passthrough ? PASSTHROUGH_MCP_PREFIX : "")
                        }
                      } else {
                        retryPrompt = buildFreshPrompt(allMessages, stripCacheControl, passthrough ? PASSTHROUGH_MCP_PREFIX : "")
                      }

                      yield* query(buildQueryOptions({
                        prompt: retryPrompt,
                        model, workingDirectory, systemContext, claudeExecutable,
                        passthrough, stream: true, sdkAgents, passthroughMcp, cleanEnv: profileEnv,
                        resumeSessionId: retryResumeId, isUndo: false, undoRollbackUuid: undefined, sdkHooks, adapter, outputFormat, thinking,
                        useBuiltinWebSearch, maxOutputTokens: body.max_tokens, onStderr,
                        effort, taskBudget, betas,
                      }))
                      return
                    }

                    // Extra Usage required: strip [1m], record 1-hour cooldown, and retry.
                    if (isExtraUsageRequiredError(errMsg) && hasExtendedContext(model)) {
                      const from = model
                      model = stripExtendedContext(model)
                      recordExtendedContextUnavailable()
                      claudeLog("upstream.context_fallback", {
                        mode: "stream",
                        from,
                        to: model,
                        reason: "extra_usage_required",
                      })
                      console.error(`[PROXY] ${requestMeta.requestId} extra usage required for [1m], falling back to ${model} (skipping [1m] for 1h)`)
                      continue
                    }

                    // Expired OAuth token: refresh once and retry
                    if (isExpiredTokenError(errMsg) && !tokenRefreshed) {
                      tokenRefreshed = true
                      const refreshed = await refreshOAuthToken()
                      if (refreshed) {
                        claudeLog("token_refresh.retrying", { mode: "stream" })
                        console.error(`[PROXY] ${requestMeta.requestId} OAuth token expired — refreshed, retrying`)
                        continue
                      }
                      // Refresh failed — fall through and surface the error
                    }

                    // Rate-limit retry: first strip [1m] (free, different tier), then backoff
                    if (isRateLimitError(errMsg)) {
                      if (hasExtendedContext(model)) {
                        const from = model
                        model = stripExtendedContext(model)
                        claudeLog("upstream.context_fallback", {
                          mode: "stream",
                          from,
                          to: model,
                          reason: "rate_limit",
                        })
                        console.error(`[PROXY] ${requestMeta.requestId} rate-limited on [1m], retrying with ${model}`)
                        continue
                      }
                      if (rateLimitRetries < MAX_RATE_LIMIT_RETRIES) {
                        rateLimitRetries++
                        const delay = RATE_LIMIT_BASE_DELAY_MS * Math.pow(2, rateLimitRetries - 1)
                        claudeLog("upstream.rate_limit_backoff", {
                          mode: "stream",
                          model,
                          attempt: rateLimitRetries,
                          maxAttempts: MAX_RATE_LIMIT_RETRIES,
                          delayMs: delay,
                        })
                        console.error(`[PROXY] ${requestMeta.requestId} rate-limited on ${model}, retry ${rateLimitRetries}/${MAX_RATE_LIMIT_RETRIES} in ${delay}ms`)
                        await new Promise(r => setTimeout(r, delay))
                        continue
                      }
                    }

                    throw error
                  }
                }
              })()

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
                    error: error instanceof Error ? error.message : String(error)
                  })
                  clearInterval(heartbeat)
                }
              }, 15_000)

              const skipBlockIndices = new Set<number>()
              const streamedToolUseIds = new Set<string>()

              // outputFormat: track StructuredOutput tool blocks for text conversion
              const structuredOutputIds = new Set<string>()
              const structuredOutputIndices = new Set<number>()
              let lastOutputFormatDelta: unknown = null

              // Block index remapping: the SDK resets indices on each turn, but
              // we skip intermediate message_start/stop so the client sees one
              // message. Without remapping, turn 2's index=0 collides with turn 1's.
              let nextClientBlockIndex = 0
              const sdkToClientIndex = new Map<number, number>()

              try {
                for await (const message of response) {
                  if (streamClosed) {
                    break
                  }

                  // Capture session ID and assistant UUID from any SDK message
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
                        model,
                        ttfbMs: firstChunkAt - upstreamStartAt
                      })
                    }

                    const event = message.event
                    const eventType = (event as any).type
                    const eventIndex = (event as any).index as number | undefined

                    // Track MCP tool blocks (mcp__opencode__*) — these are internal tools
                    // that the SDK executes. Don't forward them to OpenCode.
                    if (eventType === "message_start") {
                      skipBlockIndices.clear()
                      sdkToClientIndex.clear()
                      const startUsage = (event as unknown as { message?: { usage?: TokenUsage } }).message?.usage
                      if (startUsage) lastUsage = { ...lastUsage, ...startUsage }
                      // Only emit the first message_start — subsequent ones are internal SDK turns.
                      if (messageStartEmitted) {
                        // Drain pending WebSearch results — inject synthetic
                        // server_tool_use + web_search_tool_result SSE events
                        while (pendingWebSearchResults.length > 0) {
                          const ws = pendingWebSearchResults.shift()!
                          for (const result of ws.results) {
                            // server_tool_use block
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
                              })}\n\n`
                            ), "websearch_server_tool_use")
                            safeEnqueue(encoder.encode(
                              `event: content_block_stop\ndata: ${JSON.stringify({
                                type: "content_block_stop",
                                index: stuIdx,
                              })}\n\n`
                            ), "websearch_server_tool_use_stop")

                            // web_search_tool_result block
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
                              })}\n\n`
                            ), "websearch_tool_result")
                            safeEnqueue(encoder.encode(
                              `event: content_block_stop\ndata: ${JSON.stringify({
                                type: "content_block_stop",
                                index: wstrIdx,
                              })}\n\n`
                            ), "websearch_tool_result_stop")
                            eventsForwarded += 4
                          }
                        }
                        continue
                      }
                      messageStartEmitted = true
                    }

                    // Skip intermediate message_stop events (SDK will start another turn)
                    // Only emit message_stop when the final message ends
                    if (eventType === "message_stop") {
                      // Peek: if there are more events coming, skip this message_stop
                      // We handle this by only emitting message_stop at the very end (after the loop)
                      continue
                    }

                    if (eventType === "content_block_start") {
                      const block = (event as any).content_block

                      // When outputFormat is set: convert StructuredOutput to text, skip original text.
                      if (outputFormat) {
                        if (block?.type === "tool_use" && block.name === "StructuredOutput") {
                          if (structuredOutputIds.size > 0 || (block.id && structuredOutputIds.has(block.id))) {
                            // Duplicate StructuredOutput from subsequent SDK turn — skip
                            if (eventIndex !== undefined) skipBlockIndices.add(eventIndex)
                            continue
                          }
                          if (block.id) structuredOutputIds.add(block.id)
                          if (eventIndex !== undefined) structuredOutputIndices.add(eventIndex)
                          // Rewrite as text block
                          ;(event as any).content_block = { type: "text", text: "" }
                          // Fall through to assign client index and forward
                        } else if (block?.type === "text") {
                          // Skip text blocks — outputFormat expects structured output only
                          if (eventIndex !== undefined) skipBlockIndices.add(eventIndex)
                          continue
                        }
                      }

                      if (block?.type === "tool_use" && typeof block.name === "string") {
                        if (passthrough && block.name.startsWith(PASSTHROUGH_MCP_PREFIX)) {
                          // Passthrough mode: SDK sent the name WITH the mcp__oc__ prefix.
                          // Strip it so OpenCode sees the bare tool name.
                          block.name = stripMcpPrefix(block.name)
                          if (block.id) streamedToolUseIds.add(block.id)
                        } else if (block.name.startsWith("mcp__")) {
                          // Internal MCP tool (mcp__opencode__* etc.) — skip, SDK handles it
                          if (eventIndex !== undefined) skipBlockIndices.add(eventIndex)
                          continue
                        } else if (useBuiltinWebSearch) {
                          // Skip SDK's internal WebSearch tool_use — synthetic
                          // server_tool_use + web_search_tool_result events will be
                          // injected from PostToolUse hook results at the next message_start
                          if (eventIndex !== undefined) skipBlockIndices.add(eventIndex)
                          continue
                        } else if (passthrough && block.id) {
                          // Passthrough mode: SDK already stripped the mcp__oc__ prefix before
                          // emitting the stream_event (observed in practice — the SDK normalises
                          // tool names in stream events). Track the ID so the early-break
                          // condition fires correctly.
                          streamedToolUseIds.add(block.id)
                        }
                      }
                      // Assign a monotonic client index for this forwarded block
                      if (eventIndex !== undefined) {
                        sdkToClientIndex.set(eventIndex, nextClientBlockIndex++)
                      }
                    }

                    // Skip deltas and stops for MCP tool blocks
                    if (eventIndex !== undefined && skipBlockIndices.has(eventIndex)) {
                      continue
                    }

                    // Convert StructuredOutput input_json_delta to text_delta
                    if (outputFormat && eventIndex !== undefined && structuredOutputIndices.has(eventIndex) && eventType === "content_block_delta") {
                      const delta = (event as any).delta
                      if (delta?.type === "input_json_delta") {
                        delta.type = "text_delta"
                        delta.text = delta.partial_json
                        delete delta.partial_json
                      }
                    }

                    // Remap block index to monotonic client index
                    if (eventIndex !== undefined && sdkToClientIndex.has(eventIndex)) {
                      (event as any).index = sdkToClientIndex.get(eventIndex)
                    }

                    // Skip intermediate message_delta with stop_reason: tool_use
                    // (SDK is about to execute MCP tools and continue)
                    if (eventType === "message_delta") {
                      const deltaUsage = (event as unknown as { usage?: TokenUsage }).usage
                      if (deltaUsage) lastUsage = { ...lastUsage, ...deltaUsage }

                      // When outputFormat is set, skip ALL message_delta events —
                      // the SDK emits multiple across internal turns. We emit one
                      // final end_turn delta after the loop (like message_stop).
                      if (outputFormat) {
                        // Capture usage from the last delta for the final synthetic emit
                        lastOutputFormatDelta = event
                        continue
                      }

                      const stopReason = (event as any).delta?.stop_reason

                      // max_tokens: forward to client and stop — don't let the SDK
                      // waste turns on internal recovery retries
                      if (stopReason === "max_tokens") {
                        const payload = encoder.encode(`event: ${eventType}\ndata: ${JSON.stringify(event)}\n\n`)
                        safeEnqueue(payload, "stream_event:message_delta_max_tokens")
                        eventsForwarded += 1
                        break
                      }

                      if (stopReason === "tool_use" && (skipBlockIndices.size > 0 || useBuiltinWebSearch)) {
                        // All tool_use blocks in this turn were internal (MCP or built-in) — skip this delta
                        continue
                      }
                    }

                    // Forward all other events (text, non-MCP tool_use like Task, message events)
                    const payload = encoder.encode(`event: ${eventType}\ndata: ${JSON.stringify(event)}\n\n`)
                    if (!safeEnqueue(payload, `stream_event:${eventType}`)) {
                      break
                    }
                    eventsForwarded += 1

                    if (eventType === "content_block_delta") {
                      const delta = (event as any).delta
                      if (delta?.type === "text_delta") {
                        textEventsForwarded += 1
                      }
                    }
                  }
                }
              } finally {
                clearInterval(heartbeat)
              }

              claudeLog("upstream.completed", {
                mode: "stream",
                model,
                durationMs: Date.now() - upstreamStartAt,
                streamEventsSeen,
                eventsForwarded,
                textEventsForwarded
              })
              if (lastUsage) logUsage(requestMeta.requestId, lastUsage)

              // Store session for future resume (ephemeral mode bypasses the cache).
              if (!isEphemeral && currentSessionId) {
                storeSession(profileSessionId, body.messages || [], currentSessionId, profileScopedCwd, sdkUuidMap, lastUsage)
              }

              if (!streamClosed) {
                // In passthrough mode, emit captured tool_use blocks as stream events
                // Skip any that were already forwarded during the stream (dedup by ID)
                const unseenToolUses = capturedToolUses.filter(tu =>
                  !streamedToolUseIds.has(tu.id) && !(outputFormat && tu.name === "StructuredOutput")
                )
                if (passthrough && unseenToolUses.length > 0 && messageStartEmitted) {
                  for (let i = 0; i < unseenToolUses.length; i++) {
                    const tu = unseenToolUses[i]!
                    const blockIndex = eventsForwarded + i

                    // content_block_start
                    safeEnqueue(encoder.encode(
                      `event: content_block_start\ndata: ${JSON.stringify({
                        type: "content_block_start",
                        index: blockIndex,
                        content_block: { type: "tool_use", id: tu.id, name: tu.name, input: {} }
                      })}\n\n`
                    ), "passthrough_tool_block_start")

                    // input_json_delta with the full input
                    safeEnqueue(encoder.encode(
                      `event: content_block_delta\ndata: ${JSON.stringify({
                        type: "content_block_delta",
                        index: blockIndex,
                        delta: { type: "input_json_delta", partial_json: JSON.stringify(tu.input) }
                      })}\n\n`
                    ), "passthrough_tool_input")

                    // content_block_stop
                    safeEnqueue(encoder.encode(
                      `event: content_block_stop\ndata: ${JSON.stringify({
                        type: "content_block_stop",
                        index: blockIndex
                      })}\n\n`
                    ), "passthrough_tool_block_stop")
                  }

                  // Emit message_delta with stop_reason: "tool_use"
                  safeEnqueue(encoder.encode(
                    `event: message_delta\ndata: ${JSON.stringify({
                      type: "message_delta",
                      delta: { stop_reason: "tool_use", stop_sequence: null },
                      usage: { output_tokens: 0 }
                    })}\n\n`
                  ), "passthrough_message_delta")
                }

                // Passthrough mode: scan body.messages for file changes on end_turn
                if (trackFileChanges && passthrough && adapter.extractFileChangesFromToolUse) {
                  const passthroughChanges = extractFileChangesFromMessages(
                    body.messages || [],
                    adapter.extractFileChangesFromToolUse.bind(adapter)
                  )
                  fileChanges.push(...passthroughChanges)
                }

                // Emit file change summary as a text block before closing
                if (trackFileChanges) {
                  const streamFileChangeSummary = formatFileChangeSummary(fileChanges)
                  if (streamFileChangeSummary && messageStartEmitted) {
                    const fcBlockIndex = nextClientBlockIndex++
                    safeEnqueue(encoder.encode(
                      `event: content_block_start\ndata: ${JSON.stringify({
                        type: "content_block_start",
                        index: fcBlockIndex,
                        content_block: { type: "text", text: "" },
                      })}\n\n`
                    ), "file_changes_block_start")
                    safeEnqueue(encoder.encode(
                      `event: content_block_delta\ndata: ${JSON.stringify({
                        type: "content_block_delta",
                        index: fcBlockIndex,
                        delta: { type: "text_delta", text: streamFileChangeSummary },
                      })}\n\n`
                    ), "file_changes_text_delta")
                    safeEnqueue(encoder.encode(
                      `event: content_block_stop\ndata: ${JSON.stringify({
                        type: "content_block_stop",
                        index: fcBlockIndex,
                      })}\n\n`
                    ), "file_changes_block_stop")
                    claudeLog("response.file_changes", { mode: "stream", count: fileChanges.length })
                  }
                }

                // When outputFormat is set, emit one final message_delta with end_turn
                // (all intermediate message_delta events were skipped during the loop)
                if (outputFormat && messageStartEmitted) {
                  const usage = lastOutputFormatDelta
                    ? (lastOutputFormatDelta as Record<string, unknown>).usage ?? { output_tokens: 0 }
                    : { output_tokens: 0 }
                  safeEnqueue(encoder.encode(
                    `event: message_delta\ndata: ${JSON.stringify({
                      type: "message_delta",
                      delta: { stop_reason: "end_turn", stop_sequence: null },
                      usage,
                    })}\n\n`
                  ), "outputformat_final_message_delta")
                }

                // Emit the final message_stop (we skipped all intermediate ones)
                if (messageStartEmitted) {
                  safeEnqueue(encoder.encode(`event: message_stop\ndata: {"type":"message_stop"}\n\n`), "final_message_stop")
                }

                try { controller.close() } catch {}
                streamClosed = true

                claudeLog("stream.ended", {
                  model,
                  streamEventsSeen,
                  eventsForwarded,
                  textEventsForwarded,
                  bytesSent,
                  durationMs: Date.now() - requestStartAt
                })
              }

              // Record telemetry for ALL completed streams (including early-close from
              // passthrough tool_use break and client disconnect during enqueue).
              // Must be outside the if(!streamClosed) block.
              {
                const streamTotalDurationMs = Date.now() - requestStartAt

                claudeLog("response.completed", {
                  mode: "stream",
                  model,
                  durationMs: streamTotalDurationMs,
                  streamEventsSeen,
                  eventsForwarded,
                  textEventsForwarded
                })

                const streamQueueWaitMs = requestMeta.queueStartedAt - requestMeta.queueEnteredAt
                telemetryStore.record({
                  requestId: requestMeta.requestId,
                  timestamp: Date.now(),
                  adapter: adapter.name,
                  model,
                  requestModel: body.model || undefined,
                  mode: "stream",
                  isResume,
                  isPassthrough: passthrough,
                  isEphemeral,
                  lineageType,
                  messageCount: allMessages.length,
                  sdkSessionId: currentSessionId || resumeSessionId,
                  status: 200,
                  queueWaitMs: streamQueueWaitMs,
                  proxyOverheadMs: upstreamStartAt - requestStartAt - streamQueueWaitMs,
                  ttfbMs: firstChunkAt ? firstChunkAt - upstreamStartAt : null,
                  upstreamDurationMs: Date.now() - upstreamStartAt,
                  totalDurationMs: streamTotalDurationMs,
                  contentBlocks: eventsForwarded,
                  textEvents: textEventsForwarded,
                  error: null,
                })

                if (textEventsForwarded === 0) {
                  claudeLog("response.empty_stream", {
                    model,
                    streamEventsSeen,
                    eventsForwarded,
                    reason: "no_text_deltas_forwarded"
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
                  durationMs: Date.now() - requestStartAt
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
                model,
                durationMs: Date.now() - upstreamStartAt,
                streamEventsSeen,
                textEventsForwarded,
                error: errMsg,
                ...(stderrOutput ? { stderr: stderrOutput } : {})
              })
              const streamErr = classifyError(errMsg)
              claudeLog("proxy.anthropic.error", { error: errMsg, classified: streamErr.type })

              // If we already emitted message_start, close the message cleanly so
              // clients that access usage.input_tokens don't crash on the incomplete response.
              if (messageStartEmitted) {
                safeEnqueue(encoder.encode(
                  `event: message_delta\ndata: ${JSON.stringify({
                    type: "message_delta",
                    delta: { stop_reason: "end_turn", stop_sequence: null },
                    usage: { output_tokens: 0 }
                  })}\n\n`
                ), "error_message_delta")
                safeEnqueue(encoder.encode(
                  `event: message_stop\ndata: {"type":"message_stop"}\n\n`
                ), "error_message_stop")
              }

              safeEnqueue(encoder.encode(`event: error\ndata: ${JSON.stringify({
                type: "error",
                error: { type: streamErr.type, message: streamErr.message }
              })}\n\n`), "error_event")
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
          }
        })

        const streamSessionId = resumeSessionId || `session_${Date.now()}`
        // Defer ephemeral cleanup to the ReadableStream's finally — SDK work
        // runs after we return this response and the outer finally fires too
        // early (before any JSONL bytes are read by the subprocess).
        ephemeralDeferredToStream = true
        return new Response(readable, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
            "X-Claude-Session-ID": streamSessionId
          }
        })
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error)
        claudeLog("error.unhandled", {
          durationMs: Date.now() - requestStartAt,
          error: errMsg
        })

        // Detect specific error types and return helpful messages
        const classified = classifyError(errMsg)

        claudeLog("proxy.error", { error: errMsg, classified: classified.type })

        const errorQueueWaitMs = requestMeta.queueStartedAt - requestMeta.queueEnteredAt
        telemetryStore.record({
          requestId: requestMeta.requestId,
          timestamp: Date.now(),
          adapter: adapter.name,
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
          queueWaitMs: errorQueueWaitMs,
          proxyOverheadMs: Date.now() - requestStartAt - errorQueueWaitMs,
          ttfbMs: null,
          upstreamDurationMs: Date.now() - requestStartAt,
          totalDurationMs: Date.now() - requestStartAt,
          contentBlocks: 0,
          textEvents: 0,
          error: classified.type,
        })

        return new Response(
          JSON.stringify({ type: "error", error: { type: classified.type, message: classified.message } }),
          { status: classified.status, headers: { "Content-Type": "application/json" } }
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
    await acquireSession()
    const queueStartedAt = Date.now()
    try {
      return await handleMessages(c, { requestId, endpoint, queueEnteredAt, queueStartedAt })
    } finally {
      releaseSession()
    }
  }

  app.post("/v1/messages", (c) => handleWithQueue(c, "/v1/messages"))
  app.post("/messages", (c) => handleWithQueue(c, "/messages"))

  // Telemetry dashboard and API
  app.route("/telemetry", createTelemetryRoutes())

  // Health check endpoint — verifies auth status
  app.get("/health", async (c) => {
    try {
      // Use active profile's auth context for health check
      const healthProfile = resolveProfile(finalConfig.profiles, finalConfig.defaultProfile)
      const profileEnvOverrides = Object.keys(healthProfile.env).length > 0 ? healthProfile.env : undefined
      const auth = await getClaudeAuthStatusAsync(
          healthProfile.id !== "default" ? healthProfile.id : undefined,
          profileEnvOverrides
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
          auth: { loggedIn: false }
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
    // Enrich with live auth status
    const enriched = await Promise.all(profiles.map(async (p) => {
      const resolved = resolveProfile(finalConfig.profiles, finalConfig.defaultProfile, p.id)
      const envOverrides = Object.keys(resolved.env).length > 0 ? resolved.env : undefined
      const auth = await getClaudeAuthStatusAsync(
        p.id !== "default" ? p.id : undefined,
        envOverrides
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
      500
    )
  })

  // --- OpenAI Chat Completions Compatibility ---
  // Translates OpenAI /v1/chat/completions requests to Anthropic format and
  // routes them through the internal /v1/messages handler via app.fetch().
  // No network roundtrip — Hono resolves the route in-process.
  // See src/proxy/openai.ts for the translation logic and design rationale.
  app.post("/v1/chat/completions", async (c) => {
    const rawBody = await c.req.json() as Record<string, unknown>
    const anthropicBody = translateOpenAiToAnthropic(rawBody)

    if (!anthropicBody) {
      return c.json(
        { type: "error", error: { type: "invalid_request_error", message: "messages: Field required" } },
        400
      )
    }

    // Route internally via app.fetch() — no network roundtrip.
    // Hono resolves the path in-process; the URL scheme/host are ignored.
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
        internalRes.status as 400 | 401 | 429 | 500
      )
    }

    const completionId = `chatcmpl-${randomUUID()}`
    const created = Math.floor(Date.now() / 1000)
    const model = (typeof rawBody.model === "string" && rawBody.model) ? rawBody.model : "claude-sonnet-4-6"

    if (!anthropicBody.stream) {
      const anthropicRes = await internalRes.json() as Record<string, unknown>
      return c.json(translateAnthropicToOpenAi(anthropicRes, completionId, model, created))
    }

    // Streaming: translate Anthropic SSE events to OpenAI SSE chunks
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
  // Returns recovery information for a session, including CLI commands and file paths
  // to locate the conversation if context was lost due to compaction/restart bugs.
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
  claudeExecutable = await resolveClaudeExecutableAsync()
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
      // Re-read effective profiles on each tick (picks up new profiles from disk)
      const currentProfiles = getEffectiveProfiles(finalConfig.profiles)
      for (const profile of currentProfiles) {
        const resolved = resolveProfile(finalConfig.profiles, finalConfig.defaultProfile, profile.id)
        if (Object.keys(resolved.env).length > 0) {
          getClaudeAuthStatusAsync(resolved.id, resolved.env).catch(() => {})
        }
      }
      // Also refresh the default (no-override) context
      getClaudeAuthStatusAsync().catch(() => {})
    }, AUTH_KEEPALIVE_MS)
    // Don't block process exit
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
