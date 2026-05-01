import type { Context } from "hono"
import type { AgentAdapter } from "../adapter"
import type { QueryContext } from "../query"
import type { ProxyConfig } from "../types"
import { resolveProfile } from "../profiles"
import { resolveModel } from "../models"
import { filterBetasForProfile } from "../betas"
import { obfuscateSystemMessage } from "../obfuscate"
import { detectAdapter } from "../adapters/detect"
import { extractSystemText, mergeAdjacentSameRole } from "../messages"
import { claudeLog } from "../../logger"

/**
 * Normalize a thinking config object so both snake_case (Anthropic API)
 * and camelCase (Agent SDK) field names are accepted.
 * e.g. { type: "enabled", budget_tokens: 21333 } → { type: "enabled", budgetTokens: 21333 }
 */
export function normalizeThinking(raw: any): QueryContext['thinking'] | undefined {
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
 * Shared request context — everything derivable from the raw request + adapter,
 * before any session-lifecycle decision (ephemeral vs classic).
 *
 * `model` is mutable: `[1m]` extended-context fallback and rate-limit fallback
 * rewrite it during the SDK retry loop.
 */
export interface SharedRequestContext {
  c: Context
  body: any
  requestMeta: { requestId: string; endpoint: string; queueEnteredAt: number; queueStartedAt: number }
  adapter: AgentAdapter

  profile: ReturnType<typeof resolveProfile>
  profileEnv: Record<string, string | undefined>

  model: string
  rawBetaHeader: string | undefined
  agentMode: string | null
  outputFormat: any
  stream: boolean
  workingDirectory: string
  systemContext: string

  effort: 'low' | 'medium' | 'high' | 'max' | undefined
  thinking: QueryContext['thinking']
  taskBudget: { total: number } | undefined
  betas: string[] | undefined

  /**
   * Initial passthrough resolution: adapter override wins over env var.
   * `buildHookBundle` may flip this to false when the request asks for a
   * lone web_search, which forces the SDK-internal execution path.
   */
  initialPassthrough: boolean

  sdkAgents: Record<string, any>

  agentSessionId: string | undefined
  profileSessionId: string | undefined
  profileScopedCwd: string
  allMessages: any[]
}

export interface BuildSharedContextResult {
  shared?: SharedRequestContext
  error?: Response
}

/**
 * Build the per-request shared context. Returns an early error response if
 * the request body is malformed.
 *
 * This covers the profile/model/thinking/effort/env/systemContext resolution
 * that is agnostic to whether the request is ephemeral or classic.
 *
 * Passthrough-mode resolution and the single-web_search flip are intentionally
 * left to later extraction so PR3 stays mechanical.
 */
export async function buildSharedContext(
  c: Context,
  requestMeta: { requestId: string; endpoint: string; queueEnteredAt: number; queueStartedAt: number },
  finalConfig: ProxyConfig,
  sandboxDir: string,
): Promise<BuildSharedContextResult> {
  const adapter = detectAdapter(c)
  const body = await c.req.json()

  if (!Array.isArray(body.messages)) {
    return {
      error: c.json(
        { type: "error", error: { type: "invalid_request_error", message: "messages: Field required" } },
        400,
      ) as unknown as Response,
    }
  }

  const profile = resolveProfile(
    finalConfig.profiles,
    finalConfig.defaultProfile,
    c.req.header("x-meridian-profile") || undefined,
  )

  const rawBetaHeader = c.req.header("anthropic-beta")
  const model = resolveModel(body.model || "sonnet")
  const agentMode = c.req.header("x-opencode-agent-mode") ?? null
  const outputFormat = body.output_config?.format
  if (outputFormat?.schema?.$schema) delete outputFormat.schema.$schema
  const adapterStreamPref = adapter.prefersStreaming?.(body)
  const stream = adapterStreamPref !== undefined ? adapterStreamPref : (body.stream ?? false)
  const workingDirectory = (process.env.MERIDIAN_WORKDIR ?? process.env.CLAUDE_PROXY_WORKDIR) || sandboxDir

  const {
    CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: _dropTeams,
    ANTHROPIC_API_KEY: _dropApiKey,
    ANTHROPIC_BASE_URL: _dropBaseUrl,
    ANTHROPIC_AUTH_TOKEN: _dropAuthToken,
    ...cleanEnv
  } = process.env
  const profileEnv = { ...cleanEnv, ...profile.env }

  let systemContext = extractSystemText(body.system, { skipBillingHeader: true })

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
  let thinking: QueryContext['thinking'] = normalizeThinking(body.thinking) || { type: "disabled" }
  if (thinkingHeader !== undefined) {
    try {
      thinking = normalizeThinking(JSON.parse(thinkingHeader)) || thinking
    } catch (e) {
      console.error(`[PROXY] ${requestMeta.requestId} ignoring malformed x-opencode-thinking header: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  const effort = explicitEffort
    || (thinking?.type === "adaptive" ? "high" : undefined)
  const parsedBudget = taskBudgetHeader ? Number.parseInt(taskBudgetHeader, 10) : NaN
  const taskBudget = Number.isFinite(parsedBudget)
    ? { total: parsedBudget }
    : body.task_budget ? { total: body.task_budget.total ?? body.task_budget } : undefined
  const betas = betaFilter.forwarded

  const agentSessionId = adapter.getSessionId(c)
  const profileSessionId = profile.id !== "default" && agentSessionId
    ? `${profile.id}:${agentSessionId}` : agentSessionId
  const profileScopedCwd = profile.id !== "default"
    ? `${workingDirectory}::profile=${profile.id}` : workingDirectory

  // Passthrough resolution: adapter override wins over env var.
  // Preserves the pre-refactor `Boolean(...)` semantics — `envBool` would
  // treat "0" as false, but the inline casts in the three call-sites this
  // replaces all used `Boolean(...)`. Not widening the behavior change here.
  const adapterPassthrough = adapter.usesPassthrough?.()
  const initialPassthrough = adapterPassthrough !== undefined
    ? adapterPassthrough
    : Boolean((process.env.MERIDIAN_PASSTHROUGH ?? process.env.CLAUDE_PROXY_PASSTHROUGH))

  const sdkAgents = adapter.buildSdkAgents?.(body, adapter.getAllowedMcpTools()) ?? {}
  const validAgentNames = Object.keys(sdkAgents)
  if ((process.env.MERIDIAN_DEBUG ?? process.env.CLAUDE_PROXY_DEBUG) && validAgentNames.length > 0) {
    claudeLog("debug.agents", { names: validAgentNames, count: validAgentNames.length })
  }
  systemContext += adapter.buildSystemContextAddendum?.(body, sdkAgents) ?? ""
  if (systemContext) {
    systemContext = obfuscateSystemMessage(systemContext)
  }

  return {
    shared: {
      c,
      body,
      requestMeta,
      adapter,
      profile,
      profileEnv,
      model,
      rawBetaHeader,
      agentMode,
      outputFormat,
      stream,
      workingDirectory,
      systemContext,
      effort: effort as SharedRequestContext['effort'],
      thinking,
      taskBudget,
      betas,
      initialPassthrough,
      sdkAgents,
      agentSessionId,
      profileSessionId,
      profileScopedCwd,
      allMessages: mergeAdjacentSameRole(body.messages || []),
    },
  }
}
