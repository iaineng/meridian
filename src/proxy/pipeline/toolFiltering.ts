export interface PassthroughToolSet {
  passthrough: boolean
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
 */
export function resolvePassthroughToolSet(input: {
  tools: unknown
  passthrough: boolean
  blockingMode?: boolean
}): PassthroughToolSet {
  let passthrough = input.passthrough
  let useBuiltinWebSearch = false
  let effectiveTools: any[] = Array.isArray(input.tools) ? input.tools : []

  if (passthrough && effectiveTools.length > 0) {
    const hasNonCustomTools = effectiveTools.some((t: any) => t.type && t.type !== "custom")
    if (hasNonCustomTools) {
      const hasWebSearch = effectiveTools.some(isWebSearchTool)
      if (effectiveTools.length === 1 && isWebSearchTool(effectiveTools[0])) {
        useBuiltinWebSearch = true
        passthrough = false
        effectiveTools = []
      } else if (input.blockingMode && hasWebSearch) {
        useBuiltinWebSearch = true
        effectiveTools = effectiveTools.filter(isCustomPassthroughTool)
      } else {
        effectiveTools = effectiveTools.filter(isCustomPassthroughTool)
      }
    }
  }

  return { passthrough, effectiveTools, useBuiltinWebSearch }
}
