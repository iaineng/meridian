import type { AgentAdapter } from "../adapter"
import { createPassthroughMcpServer, createBlockingPassthroughMcpServer, stripMcpPrefix } from "../passthroughTools"
import { createFileChangeHook, type FileChange } from "../fileChanges"
import { claudeLog } from "../../logger"
import type { BlockingSessionState } from "../session/blockingPool"

export interface HookBundle {
  sdkHooks: any
  /** Possibly flipped from the input: a single web_search tool forces internal SDK mode. */
  passthrough: boolean
  passthroughMcp?: ReturnType<typeof createPassthroughMcpServer>
  /**
   * Request tools after passthrough filtering (non-"custom" typed tools removed).
   * Equal to `input.body.tools` when no filtering applied. Callers that need
   * the effective tool list should read this instead of `body.tools`.
   */
  effectiveTools: any[]
  useBuiltinWebSearch: boolean
  capturedToolUses: Array<{ id: string; name: string; input: any }>
  fileChanges: FileChange[]
  trackFileChanges: boolean
  pendingWebSearchResults: Array<{
    query: string
    results: Array<{ tool_use_id: string; content: Array<{ title: string; url: string }> }>
  }>
  stderrLines: string[]
  onStderr: (data: string) => void
}

export interface BuildHookBundleInput {
  body: any
  adapter: AgentAdapter
  sdkAgents: Record<string, any>
  /** Initial passthrough mode (may be flipped to false by single-web_search detection). */
  passthrough: boolean
  /** Blocking MCP mode — suppresses PreToolUse hook; MCP handlers block instead. */
  blockingMode?: boolean
  /** Pre-built blocking MCP server (from the blocking handler). */
  prebuiltPassthroughMcp?: ReturnType<typeof createBlockingPassthroughMcpServer>
  /** Blocking session state (required when blockingMode is true). */
  blockingState?: BlockingSessionState
}

/**
 * Build SDK hooks, passthrough MCP server, and side-effect bags (file changes,
 * tool captures, web search results, stderr).
 *
 * Pure w.r.t. `input.body` — the request body is NOT mutated. Tool filtering
 * produces a local `effectiveTools` array, exposed via the returned bundle.
 */
export function buildHookBundle(input: BuildHookBundleInput): HookBundle {
  const { body, adapter, sdkAgents } = input
  let passthrough = input.passthrough

  const capturedToolUses: Array<{ id: string; name: string; input: any }> = []
  const fileChanges: FileChange[] = []

  // --- Tool type filtering (passthrough mode) ---
  // Filter out non-custom typed tools (API built-ins like web_search, computer_use).
  // Two exceptions:
  //   1. Single web_search tool → switch to internal SDK execution.
  //   2. Blocking-MCP mode + web_search mixed with custom tools → keep both.
  //      The SDK iterator's maxTurns is already 10_000 in blocking mode, so
  //      built-in WebSearch can chain alongside the agent's passthrough tools
  //      without burning rounds. Only the built-in web_search is promoted; any
  //      other non-custom typed tools (computer_use, etc.) are still dropped.
  let useBuiltinWebSearch = false
  let effectiveTools: any[] = Array.isArray(body.tools) ? body.tools : []
  if (passthrough && effectiveTools.length > 0) {
    const hasNonCustomTools = effectiveTools.some((t: any) => t.type && t.type !== "custom")
    if (hasNonCustomTools) {
      const hasWebSearch = effectiveTools.some((t: any) => typeof t.type === "string" && t.type.includes("web_search"))
      if (effectiveTools.length === 1 && effectiveTools[0].type?.includes("web_search")) {
        useBuiltinWebSearch = true
        passthrough = false
        effectiveTools = []
      } else if (input.blockingMode && hasWebSearch) {
        useBuiltinWebSearch = true
        effectiveTools = effectiveTools.filter((t: any) => !t.type || t.type === "custom")
      } else {
        effectiveTools = effectiveTools.filter((t: any) => !t.type || t.type === "custom")
      }
    }
  }

  // In passthrough mode, register the agent's tools as MCP tools so Claude
  // can actually call them (not just see them as text descriptions).
  //
  // Blocking mode uses a pre-built MCP server constructed by the blocking
  // handler (which captured the session state needed for Promise-blocked
  // tool handlers). The shape matches createPassthroughMcpServer but the
  // handlers are real — they suspend on Promise until the client returns
  // a matching tool_result in a follow-up HTTP request.
  let passthroughMcp: ReturnType<typeof createPassthroughMcpServer> | undefined
  if (passthrough && effectiveTools.length > 0) {
    if (input.blockingMode && input.prebuiltPassthroughMcp) {
      passthroughMcp = input.prebuiltPassthroughMcp as ReturnType<typeof createPassthroughMcpServer>
    } else {
      passthroughMcp = createPassthroughMcpServer(effectiveTools)
    }
  }

  const mcpPrefix = `mcp__${adapter.getMcpServerName()}__`
  const trackFileChanges = !(process.env.MERIDIAN_NO_FILE_CHANGES ?? process.env.CLAUDE_PROXY_NO_FILE_CHANGES)
  const fileChangeHook = trackFileChanges ? createFileChangeHook(fileChanges, mcpPrefix) : undefined

  // WebSearch: capture results from PostToolUse for synthetic SSE injection.
  const pendingWebSearchResults: HookBundle['pendingWebSearchResults'] = []
  const webSearchHook = useBuiltinWebSearch ? {
    matcher: "WebSearch",
    hooks: [async (hookInput: any) => {
      const response = hookInput.tool_response
      const output = (response?.data ?? response) as Record<string, unknown> | undefined
      if (output && typeof output === "object") {
        const query = (output.query as string) ?? (hookInput.tool_input as any)?.query ?? ""
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
    ? (input.blockingMode
        // Blocking mode: let custom-tool MCP handlers run their suspended
        // Promises (no PreToolUse blocking). The webSearchHook IS still
        // registered when useBuiltinWebSearch is true so the SDK's local
        // WebSearch result is captured into `pendingWebSearchResults`; the
        // blocking translator drains that buffer into synthetic
        // `server_tool_use` / `web_search_tool_result` SSE frames on the
        // next message_start. fileChangeHook is intentionally omitted —
        // file-change tracking runs through the executor's non-blocking
        // path; blocking mode currently does not surface a final summary.
        ? (webSearchHook ? { PostToolUse: [webSearchHook] } : {})
        : {
            PreToolUse: [{
              matcher: "",  // Match ALL tools
              hooks: [async (hookInput: any) => {
                capturedToolUses.push({
                  id: hookInput.tool_use_id,
                  name: stripMcpPrefix(hookInput.tool_name),
                  input: hookInput.tool_input,
                })
                return {
                  decision: "block" as const,
                  reason: "Forwarding to client for execution",
                }
              }],
            }],
          })
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

  return {
    sdkHooks,
    passthrough,
    passthroughMcp,
    effectiveTools,
    useBuiltinWebSearch,
    capturedToolUses,
    fileChanges,
    trackFileChanges,
    pendingWebSearchResults,
    stderrLines,
    onStderr,
  }
}
