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
 * Canonical-JSON encode: deeply sort object keys before serialising. Used
 * for tool_use inputs so hashes and drift checks ignore object insertion
 * order while preserving array order.
 */
export function canonicalJson(v: unknown): string {
  return JSON.stringify(canonicalizeValue(v))
}

function canonicalizeValue(v: unknown): unknown {
  if (v === null || typeof v !== "object") return v
  if (Array.isArray(v)) return v.map(canonicalizeValue)
  const sorted: Record<string, unknown> = {}
  for (const k of Object.keys(v as Record<string, unknown>).sort()) {
    sorted[k] = canonicalizeValue((v as Record<string, unknown>)[k])
  }
  return sorted
}

function normalizeToolUseForHashing(block: any, options?: { relaxedToolUseInput?: boolean }): string {
  const name = typeof block.name === "string" ? block.name : ""
  if (options?.relaxedToolUseInput) return `tool_use:${name}`
  return `tool_use:${name}:${canonicalJson(block.input)}`
}

/**
 * Normalize message content to a string for hashing and comparison.
 * Handles both string content and array content (Anthropic content blocks).
 * Strips cache_control metadata to ensure hash stability across requests.
 *
 * NOTE: OpenCode sends content as a string on the first request but as
 * an array on subsequent ones. This normalizer handles both formats.
 * Other agents may behave differently — this will move to the adapter pattern.
 *
 * Strict `tool_use` hashing mirrors `verifyEmittedAssistant`: ignore `id`,
 * compare name, and canonical-JSON encode input (object key order ignored,
 * array order preserved). `options.relaxedToolUseInput` (default false) also
 * drops the `input` portion of `tool_use` blocks, leaving only the tool name.
 * Mirrors the relaxation in `verifyEmittedAssistant({skipInputCheck:true})`
 * so the blocking-pool prefix lookup tolerates the same client-side
 * rewrites the drift check tolerates. Used only by the blocking handler;
 * other lineage paths use the strict default.
 */
export function normalizeContent(
  content: any,
  options?: { relaxedToolUseInput?: boolean },
): string {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content.map((block: any) => {
      if (block.type === "text" && block.text) return block.text
      if (block.type === "tool_use") {
        return normalizeToolUseForHashing(block, options)
      }
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
export function serializeToolResultContentToText(
  content: any,
  counter: MultimodalCounter,
  toolPrefix?: string,
  formatToolName?: (toolName: string) => string,
): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return content == null ? "" : JSON.stringify(content)
  const prefix = toolPrefix ?? ""
  const renderToolName = formatToolName ?? ((toolName: string) => `${prefix}${toolName}`)
  return content.map((block: any) => {
    if (block.type === "text" && block.text) return block.text
    if (MULTIMODAL_TYPES.has(block.type)) return `${nextMultimodalLabel(block.type, counter)}: attached`
    if (block.type === "tool_reference" && block.tool_name) return `tool_reference: ${renderToolName(block.tool_name)}`
    return JSON.stringify(block)
  }).filter(Boolean).join("\n")
}

/**
 * Flatten an Anthropic-format `system` field (string | text-block[] | undefined)
 * to a single string. Non-text blocks are ignored.
 *
 * When `skipBillingHeader` is true, text blocks whose content starts with
 * "x-anthropic-billing-header" are dropped — callers that feed the result
 * to the SDK use this to avoid leaking the billing sentinel into the prompt.
 */
export function extractSystemText(
  system: unknown,
  opts: { skipBillingHeader?: boolean } = {},
): string {
  if (typeof system === "string") return system
  if (!Array.isArray(system)) return ""
  return system
    .filter((b: any) => {
      if (b?.type !== "text" || !b.text) return false
      if (opts.skipBillingHeader && typeof b.text === "string"
          && b.text.startsWith("x-anthropic-billing-header")) return false
      return true
    })
    .map((b: any) => b.text)
    .join("\n")
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

/**
 * Wrap a message's content as an array of content blocks.
 * String content becomes `[{ type: "text", text }]`; arrays pass through.
 */
function contentToBlocks(content: any): any[] {
  if (typeof content === "string") return [{ type: "text", text: content }]
  if (Array.isArray(content)) return content
  return [{ type: "text", text: String(content) }]
}

/**
 * Merge adjacent messages that share the same `role` into a single message
 * whose `content` is the concatenation of their content blocks.
 *
 * The Anthropic API forbids consecutive same-role messages, but some clients
 * (e.g. IDE plugins) produce them — notably splitting a single assistant turn
 * into a plain-text message followed by a tool_use-bearing message. This
 * breaks `extractContinuationTrailing` which requires each trailing assistant
 * message's `content` to be an array containing at least one `tool_use`.
 *
 * Returns the original array (reference-equal) when no merging is needed.
 */
export function mergeAdjacentSameRole(
  messages: Array<{ role: string; content: any }>,
): Array<{ role: string; content: any }> {
  if (messages.length <= 1) return messages

  let needsMerge = false
  for (let i = 1; i < messages.length; i++) {
    if (messages[i]!.role === messages[i - 1]!.role) {
      needsMerge = true
      break
    }
  }
  if (!needsMerge) return messages

  const result: Array<{ role: string; content: any }> = []
  let current = { role: messages[0]!.role, content: contentToBlocks(messages[0]!.content) }

  for (let i = 1; i < messages.length; i++) {
    const msg = messages[i]!
    if (msg.role === current.role) {
      current.content = [...current.content, ...contentToBlocks(msg.content)]
    } else {
      result.push(current)
      current = { role: msg.role, content: contentToBlocks(msg.content) }
    }
  }
  result.push(current)

  return result
}
