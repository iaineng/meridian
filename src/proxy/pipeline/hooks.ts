import { createPassthroughMcpServer, createBlockingPassthroughMcpServer, resolvePassthroughClientToolName } from "../passthroughTools"
import { claudeLog } from "../../logger"
import type { BlockingSessionState } from "../session/blockingPool"
import { resolvePassthroughToolSet } from "./toolFiltering"

export interface HookBundle {
  sdkHooks: any
  passthroughMcp?: ReturnType<typeof createPassthroughMcpServer>
  /** Request tools after passthrough filtering (non-"custom" typed tools removed). */
  effectiveTools: any[]
  useBuiltinWebSearch: boolean
  capturedToolUses: Array<{ id: string; name: string; input: any }>
  pendingWebSearchResults: Array<{
    query: string
    results: Array<{ tool_use_id: string; content: Array<{ title: string; url: string }> }>
  }>
  stderrLines: string[]
  onStderr: (data: string) => void
}

export interface BuildHookBundleInput {
  body: any
  /** Pre-built blocking MCP server (from the blocking handler). */
  prebuiltPassthroughMcp?: ReturnType<typeof createBlockingPassthroughMcpServer>
  /** Blocking session state. */
  blockingState?: BlockingSessionState
}

/**
 * Build SDK hooks, passthrough MCP server, and side-effect bags (tool
 * captures, web search results, stderr). Always blocking-MCP + passthrough.
 */
export function buildHookBundle(input: BuildHookBundleInput): HookBundle {
  const { body } = input

  const capturedToolUses: Array<{ id: string; name: string; input: any }> = []

  const toolSet = resolvePassthroughToolSet(body.tools)
  const effectiveTools = toolSet.effectiveTools
  const useBuiltinWebSearch = toolSet.useBuiltinWebSearch

  let passthroughMcp: ReturnType<typeof createPassthroughMcpServer> | undefined
  if (effectiveTools.length > 0) {
    if (input.prebuiltPassthroughMcp) {
      passthroughMcp = input.prebuiltPassthroughMcp as ReturnType<typeof createPassthroughMcpServer>
    } else {
      passthroughMcp = createPassthroughMcpServer(effectiveTools)
    }
  }

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

  // Blocking + passthrough: let custom-tool MCP handlers run their suspended
  // Promises (no PreToolUse blocking on the custom tools). The webSearchHook
  // is still registered when useBuiltinWebSearch is true so the SDK's local
  // WebSearch result is captured into `pendingWebSearchResults`.
  const sdkHooks = webSearchHook ? { PostToolUse: [webSearchHook] } : {}

  const stderrLines: string[] = []
  const onStderr = (data: string) => {
    stderrLines.push(data.trimEnd())
    claudeLog("subprocess.stderr", { line: data.trimEnd() })
  }

  void resolvePassthroughClientToolName

  return {
    sdkHooks,
    passthroughMcp,
    effectiveTools,
    useBuiltinWebSearch,
    capturedToolUses,
    pendingWebSearchResults,
    stderrLines,
    onStderr,
  }
}
