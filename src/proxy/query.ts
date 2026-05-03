/**
 * SDK query options builder.
 *
 * Every request takes the blocking-MCP + passthrough path: real
 * Promise-blocked MCP handlers, `maxTurns: 10_000`, and a 30-min
 * stream-close timeout that lets the SDK wait for the next HTTP round to
 * bring `tool_result` back. Streaming partial messages are always on; there
 * is no non-streaming SDK call from meridian.
 */

import type { Options } from "@anthropic-ai/claude-agent-sdk"
import { createPassthroughMcpServer, PASSTHROUGH_MCP_NAME } from "./passthroughTools"
import { BLOCKED_BUILTIN_TOOLS, CLAUDE_CODE_ONLY_TOOLS } from "./tools"

export interface QueryContext {
  /** The prompt to send (text or async iterable for multimodal) */
  prompt: string | AsyncIterable<any>
  /** Resolved Claude model name */
  model: string
  /** Sandbox working directory */
  workingDirectory: string
  /** System context text (may be empty) */
  systemContext: string
  /** Path to Claude executable */
  claudeExecutable: string
  /** Passthrough MCP server (only present when client sent custom tools) */
  passthroughMcp?: ReturnType<typeof createPassthroughMcpServer>
  /** Cleaned environment variables (API keys stripped) */
  cleanEnv: Record<string, string | undefined>
  /** SDK session ID for resume (set when JSONL prewarm produced a transcript) */
  resumeSessionId?: string
  /** SDK hooks (PostToolUse for built-in WebSearch capture, etc.) */
  sdkHooks?: any
  /** Output format configuration (e.g. json_schema for structured output) */
  outputFormat?: { type: "json_schema"; schema: Record<string, unknown> }
  /** Thinking/reasoning configuration */
  thinking?:
    | { type: "adaptive"; display?: "summarized" | "omitted" }
    | { type: "enabled"; budgetTokens?: number; display?: "summarized" | "omitted" }
    | { type: "disabled" }
  /** Whether to enable the SDK's built-in WebSearch (removes it from blocked tools) */
  useBuiltinWebSearch?: boolean
  /** Max output tokens from client request (body.max_tokens) */
  maxOutputTokens?: number
  /** Callback to receive stderr lines from the Claude subprocess */
  onStderr?: (line: string) => void
  /** Effort level — controls thinking depth (low/medium/high/max) */
  effort?: 'low' | 'medium' | 'high' | 'max'
  /** API-side task budget in tokens — model paces tool use within this limit */
  taskBudget?: { total: number }
  /**
   * Abort controller wired to `BlockingSessionState.abort` so
   * `blockingPool.release` can tear down the Claude subprocess *before*
   * rejecting pending MCP handlers.
   */
  abortController?: AbortController
  /**
   * When true, set `CLAUDE_CODE_RESUME_INTERRUPTED_TURN=1` in the SDK env
   * so the SDK auto-resumes the trailing JSONL user as the next prompt.
   * Used in tandem with the synthetic-filler-skipping JSONL writer in
   * `prepareFreshSession` and the empty-iterable shortcut in
   * `buildPromptBundle`: meridian feeds the SDK an immediately-closing
   * AsyncIterable so no spurious user frame reaches claude.exe stdin, and
   * the SDK replays the trailing user content from the JSONL itself.
   */
  resumeInterruptedTurn?: boolean
}

/**
 * Default `display` to `"summarized"` when thinking is active but the client
 * didn't specify one. Opus 4.7+ defaults to `"omitted"` server-side, which
 * suppresses `thinking_delta` events — clients expecting the thinking stream
 * see only `signature_delta`. Only applied when thinking is enabled.
 */
function withDefaultThinkingDisplay(
  thinking: NonNullable<QueryContext['thinking']>
): NonNullable<QueryContext['thinking']> {
  if (thinking.type === "disabled") return thinking
  if (thinking.display !== undefined) return thinking
  return { ...thinking, display: "summarized" }
}

export interface BuildQueryResult {
  prompt: QueryContext["prompt"]
  options: Options
}

export function buildQueryOptions(ctx: QueryContext): BuildQueryResult {
  const {
    prompt, model, workingDirectory, systemContext, claudeExecutable,
    passthroughMcp, cleanEnv,
    resumeSessionId, sdkHooks,
    outputFormat, thinking, onStderr,
    effort, taskBudget, abortController,
  } = ctx

  let blockedTools = [...BLOCKED_BUILTIN_TOOLS, ...CLAUDE_CODE_ONLY_TOOLS]
  if (ctx.useBuiltinWebSearch) {
    blockedTools = blockedTools.filter(t => t !== "WebSearch")
  }

  return {
    prompt,
    options: {
      // Blocking mode owns the turn budget. The session lives across many
      // HTTP rounds (suspended MCP handlers) and built-in tools like
      // WebSearch chain internal SDK turns within one round; 10_000 is the
      // generous cap that absorbs both.
      maxTurns: 10_000,
      cwd: workingDirectory,
      model,
      pathToClaudeCodeExecutable: claudeExecutable,
      includePartialMessages: true,
      permissionMode: "bypassPermissions" as const,
      allowDangerouslySkipPermissions: true,
      ...(systemContext ? { systemPrompt: systemContext } : {}),
      ...(effort ? { effort } : {}),
      disallowedTools: blockedTools,
      ...(passthroughMcp ? {
        allowedTools: passthroughMcp.toolNames,
        mcpServers: { [PASSTHROUGH_MCP_NAME]: passthroughMcp.server },
      } : {}),
      plugins: [],
      ...(onStderr ? { stderr: onStderr } : {}),
      env: {
        ...cleanEnv,
        ENABLE_TOOL_SEARCH: "false",
        DISABLE_AUTO_COMPACT: "1",
        ENABLE_CLAUDEAI_MCP_SERVERS: "false",
        // Blocking mode: MCP handlers may suspend for up to 30 min waiting
        // for the client's next HTTP request to deliver tool_result. Default
        // SDK timeout is 60s, which would abort the whole query.
        CLAUDE_CODE_STREAM_CLOSE_TIMEOUT: "1800000",
        ...(ctx.maxOutputTokens
          ? { CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(ctx.maxOutputTokens) }
          : {}),
        // When running as root (Docker, Unraid, NAS), set IS_SANDBOX=1 to
        // bypass the SDK's root check. Without this, the SDK exits with:
        // "--dangerously-skip-permissions cannot be used with root/sudo"
        ...(process.getuid?.() === 0 ? { IS_SANDBOX: "1" } : {}),
        // Prevent the CLI from overriding non-adaptive thinking to adaptive.
        ...(thinking?.type === "enabled" ? { CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING: "1" } : {}),
        // Hand the trailing-user JSONL row back to the SDK as the next
        // prompt (paired with the empty-iterable prompt + synthetic-
        // filler-free JSONL emitted by `prepareFreshSession`).
        ...(ctx.resumeInterruptedTurn ? { CLAUDE_CODE_RESUME_INTERRUPTED_TURN: "1" } : {}),
      },
      ...(resumeSessionId ? { resume: resumeSessionId } : {}),
      ...(sdkHooks ? { hooks: sdkHooks } : {}),
      ...(outputFormat ? { outputFormat } : {}),
      ...(thinking ? { thinking: withDefaultThinkingDisplay(thinking) } : {}),
      ...(taskBudget ? { taskBudget } : {}),
      ...(abortController ? { abortController } : {}),
    },
  }
}
