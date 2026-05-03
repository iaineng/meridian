export interface PassthroughToolSet {
  effectiveTools: any[]
  useBuiltinWebSearch: boolean
}

function isWebSearchTool(tool: any): boolean {
  return typeof tool?.type === "string" && tool.type.includes("web_search")
}

function isCustomPassthroughTool(tool: any): boolean {
  return !tool?.type || tool.type === "custom"
}

/**
 * Resolve the SDK-facing passthrough tool set without mutating the request.
 *
 * API built-ins such as `web_search_20260209` must not be registered as
 * passthrough MCP tools; the SDK exposes WebSearch as its own built-in.
 * `useBuiltinWebSearch` is set whenever a `web_search` tool is present so the
 * SDK's local WebSearch is unblocked and the PostToolUse hook captures its
 * results.
 */
export function resolvePassthroughToolSet(tools: unknown): PassthroughToolSet {
  const effectiveTools: any[] = Array.isArray(tools) ? tools : []

  if (effectiveTools.length === 0) {
    return { effectiveTools, useBuiltinWebSearch: false }
  }

  const hasNonCustomTools = effectiveTools.some((t: any) => t.type && t.type !== "custom")
  if (!hasNonCustomTools) {
    return { effectiveTools, useBuiltinWebSearch: false }
  }

  // Mixed custom-tools + web_search OR custom + other API built-in (or lone
  // web_search): keep only custom tools for the passthrough MCP and turn on
  // the built-in WebSearch hook when web_search is present. A lone
  // `web_search` collapses to `effectiveTools: []` here, so no MCP server is
  // registered downstream.
  return {
    effectiveTools: effectiveTools.filter(isCustomPassthroughTool),
    useBuiltinWebSearch: effectiveTools.some(isWebSearchTool),
  }
}
