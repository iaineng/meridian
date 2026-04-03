/**
 * Message parsing and normalization utilities.
 */

/**
 * Strip cache_control from a content block (or nested blocks).
 * cache_control is ephemeral metadata that agents add/remove between requests;
 * it must not affect content hashing or lineage verification.
 */
function stripCacheControlForHashing(obj: any): any {
  if (!obj || typeof obj !== "object") return obj
  if (Array.isArray(obj)) return obj.map(stripCacheControlForHashing)
  const { cache_control, ...rest } = obj
  return rest
}

/**
 * Normalize message content to a string for hashing and comparison.
 * Handles both string content and array content (Anthropic content blocks).
 * Strips cache_control metadata to ensure hash stability across requests.
 *
 * NOTE: OpenCode sends content as a string on the first request but as
 * an array on subsequent ones. This normalizer handles both formats.
 * Other agents may behave differently — this will move to the adapter pattern.
 */
export function normalizeContent(content: any): string {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content.map((block: any) => {
      if (block.type === "text" && block.text) return block.text
      if (block.type === "tool_use") return `tool_use:${block.id}:${block.name}:${JSON.stringify(block.input)}`
      if (block.type === "tool_result") {
        const inner = block.content
        if (typeof inner === "string") return `tool_result:${block.tool_use_id}:${inner}`
        // Strip cache_control from nested content blocks before serializing
        return `tool_result:${block.tool_use_id}:${JSON.stringify(stripCacheControlForHashing(inner))}`
      }
      // Unknown block types: strip cache_control before serializing
      return JSON.stringify(stripCacheControlForHashing(block))
    }).join("\n")
  }
  return String(content)
}

// ---------------------------------------------------------------------------
// Multimodal helpers
// ---------------------------------------------------------------------------

const MULTIMODAL_TYPES = new Set(["image", "document", "file"])

export interface MultimodalCounter {
  image: number
  document: number
  file: number
}

/**
 * Increment the counter for the given type and return a label like "[Image 1]".
 */
export function nextMultimodalLabel(type: "image" | "document" | "file", counter: MultimodalCounter): string {
  counter[type]++
  const name = type.charAt(0).toUpperCase() + type.slice(1)
  return `[${name} ${counter[type]}]`
}

/**
 * Check whether any message contains multimodal content (image/document/file),
 * including blocks nested inside tool_result.content arrays.
 */
export function hasMultimodalContent(messages: Array<{ role: string; content: any }>): boolean {
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue
    for (const block of m.content) {
      if (MULTIMODAL_TYPES.has(block.type)) return true
      if (
        block.type === "tool_result" &&
        Array.isArray(block.content) &&
        block.content.some((inner: any) => MULTIMODAL_TYPES.has(inner.type))
      ) return true
    }
  }
  return false
}


/**
 * Serialize tool_result.content to text for the text prompt path.
 * Replaces image/document/file blocks with indexed labels instead of
 * dumping raw base64 via JSON.stringify.
 */
export function serializeToolResultContentToText(content: any, counter: MultimodalCounter, toolPrefix?: string): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return content == null ? "" : JSON.stringify(content)
  const prefix = toolPrefix ?? ""
  return content.map((block: any) => {
    if (block.type === "text" && block.text) return block.text
    if (MULTIMODAL_TYPES.has(block.type)) return `${nextMultimodalLabel(block.type, counter)}: attached`
    if (block.type === "tool_reference" && block.tool_name) return `tool_reference: ${prefix}${block.tool_name}`
    return JSON.stringify(block)
  }).filter(Boolean).join("\n")
}

/**
 * Extract only the last user message (for session resume — SDK already has history).
 */
export function getLastUserMessage(messages: Array<{ role: string; content: any }>): Array<{ role: string; content: any }> {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") return [messages[i]!]
  }
  return messages.slice(-1)
}
