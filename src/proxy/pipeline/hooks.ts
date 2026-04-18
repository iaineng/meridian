import type { AgentAdapter } from "../adapter"
import { createPassthroughMcpServer, stripMcpPrefix } from "../passthroughTools"
import { createFileChangeHook, type FileChange } from "../fileChanges"
import { claudeLog } from "../../logger"

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
  // Exception: single web_search tool → switch to internal SDK execution.
  let useBuiltinWebSearch = false
  let effectiveTools: any[] = Array.isArray(body.tools) ? body.tools : []
  if (passthrough && effectiveTools.length > 0) {
    const hasNonCustomTools = effectiveTools.some((t: any) => t.type && t.type !== "custom")
    if (hasNonCustomTools) {
      if (effectiveTools.length === 1 && effectiveTools[0].type?.includes("web_search")) {
        useBuiltinWebSearch = true
        passthrough = false
        effectiveTools = []
      } else {
        effectiveTools = effectiveTools.filter((t: any) => !t.type || t.type === "custom")
      }
    }
  }

  // In passthrough mode, register the agent's tools as MCP tools so Claude
  // can actually call them (not just see them as text descriptions).
  let passthroughMcp: ReturnType<typeof createPassthroughMcpServer> | undefined
  if (passthrough && effectiveTools.length > 0) {
    passthroughMcp = createPassthroughMcpServer(effectiveTools)
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
    ? {
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
