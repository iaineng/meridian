import type { Context } from "hono"
import type { QueryContext } from "../query"
import type { ProxyConfig } from "../types"
import { resolveProfile } from "../profiles"
import { resolveModel } from "../models"
import { obfuscateSystemMessage } from "../obfuscate"
import { extractSystemText, mergeAdjacentSameRole } from "../messages"

/**
 * Normalize a thinking config object so both snake_case (Anthropic API)
 * and camelCase (Agent SDK) field names are accepted.
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
 * Shared request context — everything derivable from the raw request,
 * before the blocking handler decides how to dispatch.
 *
 * `model` is mutable: `[1m]` extended-context fallback and rate-limit fallback
 * rewrite it during the SDK retry loop.
 */
export interface SharedRequestContext {
  c: Context
  body: any
  requestMeta: { requestId: string; endpoint: string; queueEnteredAt: number; queueStartedAt: number }

  profile: ReturnType<typeof resolveProfile>
  profileEnv: Record<string, string | undefined>

  model: string
  outputFormat: any
  stream: boolean
  /** Always the per-instance sandbox directory — meridian never inherits a
   *  client-side cwd. Subprocess + JSONL transcripts both run inside this
   *  directory so different proxy instances don't collide. */
  workingDirectory: string
  systemContext: string

  effort: 'low' | 'medium' | 'high' | 'max' | undefined
  thinking: QueryContext['thinking']
  taskBudget: { total: number } | undefined

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
 * The proxy is agent-agnostic: it accepts the standard Anthropic API shape
 * with no out-of-band request headers. Per-request profile selection is the
 * only header the proxy consults — `x-meridian-profile`. Everything else
 * comes from `body` (model, stream, system, thinking, task_budget, …).
 *
 * Any `anthropic-beta` header is unconditionally stripped (Claude Max
 * doesn't honor them).
 */
export async function buildSharedContext(
  c: Context,
  requestMeta: { requestId: string; endpoint: string; queueEnteredAt: number; queueStartedAt: number },
  finalConfig: ProxyConfig,
  sandboxDir: string,
): Promise<BuildSharedContextResult> {
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

  const model = resolveModel(body.model || "sonnet")
  const outputFormat = body.output_config?.format
  if (outputFormat?.schema?.$schema) delete outputFormat.schema.$schema
  const stream = body.stream ?? false
  const workingDirectory = sandboxDir

  const {
    CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: _dropTeams,
    ANTHROPIC_API_KEY: _dropApiKey,
    ANTHROPIC_BASE_URL: _dropBaseUrl,
    ANTHROPIC_AUTH_TOKEN: _dropAuthToken,
    ...cleanEnv
  } = process.env
  const profileEnv = { ...cleanEnv, ...profile.env }

  let systemContext = extractSystemText(body.system, { skipBillingHeader: true })
  if (systemContext) {
    // Replace the SDK's `claude_code` preset with the client's system prompt
    // and obfuscate it. (Passthrough is the only mode.)
    systemContext = obfuscateSystemMessage(systemContext)
  }

  const thinking: QueryContext['thinking'] =
    normalizeThinking(body.thinking) || { type: "disabled" }
  const explicitEffort = body.effort
    || body.output_config?.effort
    || undefined
  const effort = explicitEffort
    || (thinking?.type === "adaptive" ? "high" : undefined)
  const taskBudget = body.task_budget
    ? { total: body.task_budget.total ?? body.task_budget }
    : undefined

  return {
    shared: {
      c,
      body,
      requestMeta,
      profile,
      profileEnv,
      model,
      outputFormat,
      stream,
      workingDirectory,
      systemContext,
      effort: effort as SharedRequestContext['effort'],
      thinking,
      taskBudget,
      allMessages: mergeAdjacentSameRole(body.messages || []),
    },
  }
}
