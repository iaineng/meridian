/**
 * SDK query options builder.
 *
 * Centralizes the construction of query() options, eliminating duplication
 * between the streaming and non-streaming paths in server.ts.
 */

import type { AgentAdapter } from "./adapter"
import type { Options, SdkBeta } from "@anthropic-ai/claude-agent-sdk"
import { createOpencodeMcpServer } from "../mcpTools"
import { createPassthroughMcpServer, PASSTHROUGH_MCP_NAME } from "./passthroughTools"
import { HEARTBEAT_SIGNAL_INSTRUCTION } from "./session/transcript"

export interface QueryContext {
  /** The prompt to send (text or async iterable for multimodal) */
  prompt: string | AsyncIterable<any>
  /** Resolved Claude model name */
  model: string
  /** Client working directory */
  workingDirectory: string
  /** System context text (may be empty) */
  systemContext: string
  /** Path to Claude executable */
  claudeExecutable: string
  /** Whether passthrough mode is enabled */
  passthrough: boolean
  /** Whether this is a streaming request */
  stream: boolean
  /** SDK agent definitions extracted from tool descriptions */
  sdkAgents: Record<string, any>
  /** Passthrough MCP server (if passthrough mode + tools present) */
  passthroughMcp?: ReturnType<typeof createPassthroughMcpServer>
  /** Cleaned environment variables (API keys stripped) */
  cleanEnv: Record<string, string | undefined>
  /** SDK session ID for resume (if continuing a session) */
  resumeSessionId?: string
  /** Whether this is an undo operation */
  isUndo: boolean
  /** UUID to rollback to for undo operations */
  undoRollbackUuid?: string
  /** SDK hooks (PreToolUse etc.) */
  sdkHooks?: any
  /** The agent adapter providing tool configuration */
  adapter: AgentAdapter
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
  /** Beta features to enable */
  betas?: string[]
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

/**
 * Build the options object for the Claude Agent SDK query() call.
 * This is called identically from both streaming and non-streaming paths,
 * with the only difference being `includePartialMessages` for streaming.
 */
export interface BuildQueryResult {
  prompt: QueryContext["prompt"]
  options: Options
}

export function buildQueryOptions(ctx: QueryContext): BuildQueryResult {
  const {
    prompt, model, workingDirectory, systemContext, claudeExecutable,
    passthrough, stream, sdkAgents, passthroughMcp, cleanEnv,
    resumeSessionId, isUndo, undoRollbackUuid, sdkHooks, adapter,
    outputFormat, thinking, onStderr,
    effort, taskBudget, betas,
  } = ctx

  let blockedTools = [...adapter.getBlockedBuiltinTools(), ...adapter.getAgentIncompatibleTools()]
  if (ctx.useBuiltinWebSearch) {
    blockedTools = blockedTools.filter(t => t !== "WebSearch")
  }
  const mcpServerName = adapter.getMcpServerName()
  const allowedMcpTools = [...adapter.getAllowedMcpTools()]

  return {
    prompt,
    options: {
      // Force Node as the executable. The claude-agent-sdk auto-detects Bun
      // via process.versions.bun and defaults to spawning `bun cli.js`.
      // Hosts like OpenCode embed Bun, so the check fires even when `bun`
      // is not in PATH — causing subprocess spawns to fail.
      executable: "node" as const,
      maxTurns: passthrough ? 1 : 200,
      cwd: workingDirectory,
      model,
      pathToClaudeCodeExecutable: claudeExecutable,
      ...(stream ? { includePartialMessages: true } : {}),
      permissionMode: "bypassPermissions" as const,
      allowDangerouslySkipPermissions: true,
      // Always surface HEARTBEAT_SIGNAL_INSTRUCTION so the model knows to
      // ignore the synthetic `[HEARTBEAT]`/`[ACK]` pair whenever it appears
      // in JSONL history (classic mode accumulates them across resumes;
      // ephemeral mode emits them on the turn that takes a synthetic-tail
      // path). The instruction is a no-op in turns that don't see the
      // tokens, so unconditional attachment decouples transcript decisions
      // from system-prompt construction.
      systemPrompt: (passthrough || ctx.useBuiltinWebSearch)
        ? (systemContext ? `${systemContext}\n\n${HEARTBEAT_SIGNAL_INSTRUCTION}` : HEARTBEAT_SIGNAL_INSTRUCTION)
        : { type: "preset" as const, preset: "claude_code" as const, append: systemContext ? `${systemContext}\n\n${HEARTBEAT_SIGNAL_INSTRUCTION}` : HEARTBEAT_SIGNAL_INSTRUCTION },
      ...(effort ? { effort } : {}),
      ...(passthrough
        ? {
            disallowedTools: blockedTools,
            ...(passthroughMcp ? {
              allowedTools: passthroughMcp.toolNames,
              mcpServers: { [PASSTHROUGH_MCP_NAME]: passthroughMcp.server },
            } : {}),
          }
        : {
            disallowedTools: blockedTools,
            ...(ctx.useBuiltinWebSearch ? {} : {
              allowedTools: allowedMcpTools,
              mcpServers: { [mcpServerName]: createOpencodeMcpServer() },
            }),
          }),
      plugins: [],
      ...(onStderr ? { stderr: onStderr } : {}),
      env: {
        ...cleanEnv,
        ENABLE_TOOL_SEARCH: "false",
        DISABLE_AUTO_COMPACT: "1",
        ...(passthrough ? { ENABLE_CLAUDEAI_MCP_SERVERS: "false" } : {}),
        // Pass through client's max_tokens directly. The streaming event model
        // handles max_tokens cleanly via message_delta break, so the SDK's
        // internal 3-retry recovery loop is no longer a concern.
        ...(ctx.maxOutputTokens
          ? { CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(ctx.maxOutputTokens) }
          : {}),
        // When running as root (Docker, Unraid, NAS), set IS_SANDBOX=1 to
        // bypass the SDK's root check. Without this, the SDK exits with:
        // "--dangerously-skip-permissions cannot be used with root/sudo"
        // See: https://github.com/rynfar/meridian/issues/256
        ...(process.getuid?.() === 0 ? { IS_SANDBOX: "1" } : {}),
        // NOTE: Agent-specific — prevent the CLI from overriding non-adaptive
        // thinking to adaptive. Without this, the CLI ignores the caller's
        // { type: "enabled", budgetTokens } and forces adaptive on supported models.
        ...(thinking?.type === "enabled" ? { CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING: "1" } : {}),
      },
      ...(Object.keys(sdkAgents).length > 0 ? { agents: sdkAgents } : {}),
      ...(resumeSessionId ? { resume: resumeSessionId } : {}),
      ...(isUndo ? { forkSession: true, ...(undoRollbackUuid ? { resumeSessionAt: undoRollbackUuid } : {}) } : {}),
      ...(sdkHooks ? { hooks: sdkHooks } : {}),
      ...(outputFormat ? { outputFormat } : {}),
      ...(thinking ? { thinking: withDefaultThinkingDisplay(thinking) } : {}),
      ...(taskBudget ? { taskBudget } : {}),
      ...(betas && betas.length > 0 ? { betas: betas as SdkBeta[] } : {}),
    }
  }
}
