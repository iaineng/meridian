/**
 * Passthrough MCP tool naming.
 *
 * The SDK exposes tools as `mcp__{server}__{tool}`.  For passthrough mode we
 * keep the server name fixed (`tools`) and normalise every client tool name to
 * lowercase kebab-case so the model sees one naming convention end-to-end.
 */

export const PASSTHROUGH_MCP_NAME = "tools"
export const PASSTHROUGH_MCP_PREFIX = `mcp__${PASSTHROUGH_MCP_NAME}__`

export interface PassthroughToolNameResolver {
  clientNameByMcpToolName?: Map<string, string>
  clientNameByFullToolName?: Map<string, string>
}

function stripForeignMcpPrefix(name: string): string {
  if (name.startsWith(PASSTHROUGH_MCP_PREFIX)) {
    return name.slice(PASSTHROUGH_MCP_PREFIX.length)
  }
  if (name.startsWith("mcp__")) {
    return name.slice("mcp__".length)
  }
  if (name.startsWith("mcp_")) {
    return name.slice("mcp_".length)
  }
  return name
}

/**
 * Convert any common tool-name shape to lowercase kebab-case:
 *   Read                                 -> read
 *   DoSomething                          -> do-something
 *   mcp__plugin_context7_context7__query-docs
 *                                        -> plugin-context7-context7-query-docs
 */
export function normalizePassthroughMcpToolName(toolName: string): string {
  const stripped = stripForeignMcpPrefix(String(toolName ?? "").trim())
  const kebab = stripped
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase()
  return kebab || "tool"
}

export function toPassthroughMcpFullToolName(toolName: string): string {
  return `${PASSTHROUGH_MCP_PREFIX}${normalizePassthroughMcpToolName(toolName)}`
}

export function stripPassthroughMcpPrefix(toolName: string): string {
  if (toolName.startsWith(PASSTHROUGH_MCP_PREFIX)) {
    return toolName.slice(PASSTHROUGH_MCP_PREFIX.length)
  }
  return toolName
}

/**
 * Resolve an SDK-visible passthrough name back to the exact client tool name
 * from the current request. Falls back to the local kebab name when no mapping
 * is available, which keeps older tests and defensive call sites usable.
 */
export function resolvePassthroughClientToolName(
  toolName: string,
  resolver?: PassthroughToolNameResolver,
): string {
  const fullName = toolName.startsWith(PASSTHROUGH_MCP_PREFIX)
    ? toolName
    : `${PASSTHROUGH_MCP_PREFIX}${toolName}`
  const mappedFull = resolver?.clientNameByFullToolName?.get(fullName)
  if (mappedFull) return mappedFull

  const localName = stripPassthroughMcpPrefix(toolName)
  const mappedLocal = resolver?.clientNameByMcpToolName?.get(localName)
  return mappedLocal ?? localName
}
