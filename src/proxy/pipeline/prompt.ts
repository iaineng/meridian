import {
  hasMultimodalContent,
  nextMultimodalLabel,
  serializeToolResultContentToText,
  type MultimodalCounter,
} from "../messages"
import { crEncode } from "../obfuscate"
import { PASSTHROUGH_MCP_PREFIX } from "../passthroughTools"

/**
 * Strip cache_control from content blocks — the SDK manages its own caching
 * and OpenCode's ttl='1h' blocks conflict with the SDK's ttl='5m' blocks.
 */
export function stripCacheControl(content: any): any {
  if (!Array.isArray(content)) return content
  return content.map((block: any) => {
    let cleaned = block
    if (block.cache_control) {
      const { cache_control: _cc, ...rest } = block
      cleaned = rest
    }
    if (cleaned.type === "tool_result" && Array.isArray(cleaned.content)) {
      return { ...cleaned, content: stripCacheControl(cleaned.content) }
    }
    return cleaned
  })
}

/**
 * Extract the text content of a message, serializing tool_use/tool_result
 * blocks as XML tags. Returns raw content without a role prefix.
 */
export function extractMessageContent(
  m: any,
  toolNameById: Map<string, string>,
  counter?: MultimodalCounter,
  toolPrefix?: string,
): string {
  const encodeText = m.role === "user" ? crEncode : (s: string) => s
  if (typeof m.content === "string") return encodeText(m.content)
  if (Array.isArray(m.content)) {
    const parts: string[] = []
    let i = 0
    while (i < m.content.length) {
      const block = m.content[i]
      if (block.type === "text" && block.text) {
        parts.push(encodeText(block.text))
        i++
      } else if (block.type === "tool_use") {
        const invokes: string[] = []
        while (i < m.content.length && m.content[i].type === "tool_use") {
          const b = m.content[i]
          const params = Object.entries(b.input ?? {}).map(([k, v]: [string, any]) =>
            `<parameter name="${k}">${typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? String(v) : JSON.stringify(v)}</parameter>`
          ).join("\n")
          const name = toolNameById.get(b.id) ?? b.name
          invokes.push(`<invoke name="${name}">\n${params}\n</invoke>`)
          i++
        }
        parts.push(`<function_calls>\n${invokes.join("\n")}\n</function_calls>`)
      } else if (block.type === "tool_result") {
        const results: string[] = []
        while (i < m.content.length && m.content[i].type === "tool_result") {
          const b = m.content[i]
          const body = counter ? serializeToolResultContentToText(b.content, counter, toolPrefix) : (typeof b.content === "string" ? b.content : JSON.stringify(b.content))
          results.push(b.is_error ? `<error>${encodeText(body)}</error>` : `<output>${encodeText(body)}</output>`)
          i++
        }
        parts.push(`<function_results>\n${results.join("\n")}\n</function_results>`)
      } else if (block.type === "image") {
        parts.push(counter ? `${nextMultimodalLabel("image", counter)}: attached` : "(image was attached)")
        i++
      } else if (block.type === "document") {
        parts.push(counter ? `${nextMultimodalLabel("document", counter)}: attached` : "(document was attached)")
        i++
      } else if (block.type === "file") {
        parts.push(counter ? `${nextMultimodalLabel("file", counter)}: attached` : "(file was attached)")
        i++
      } else {
        i++
      }
    }
    return parts.filter(Boolean).join("\n")
  }
  return encodeText(String(m.content))
}

/** Convert a message to an XML-tagged turn for conversation history. */
export function convertMessageToText(
  m: any,
  toolNameById: Map<string, string>,
  counter?: MultimodalCounter,
  toolPrefix?: string,
): string {
  const role = m.role === "assistant" ? "assistant" : "user"
  return `<turn role="${role}">\n${extractMessageContent(m, toolNameById, counter, toolPrefix)}\n</turn>`
}

/**
 * Build a text prompt from messages, wrapping all but the last user message
 * in <conversation_history> to separate history from the current request.
 */
export function buildTextPromptWithHistory(
  messages: Array<{ role: string; content: any }>,
  toolNameById: Map<string, string>,
  counter?: MultimodalCounter,
  toolPrefix?: string,
): string {
  let lastUserIdx = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") { lastUserIdx = i; break }
  }
  if (lastUserIdx > 0) {
    const historyMessages = messages.slice(0, lastUserIdx)
    // Skip conversation_history wrapper when history contains only user messages
    const hasNonUserHistory = historyMessages.some(m => m.role !== "user")
    if (hasNonUserHistory) {
      // Check if the last user message is a tool_result — if so, fold it
      // into history and use a continuation prompt as the current request.
      const lastUserMsg = messages[lastUserIdx]!
      const isToolResult = Array.isArray(lastUserMsg.content)
        ? lastUserMsg.content.some((b: any) => b.type === "tool_result")
        : false

      let historyPart: string
      let currentPart: string
      if (isToolResult) {
        historyPart = messages.slice(0, lastUserIdx + 1).map(m => convertMessageToText(m, toolNameById, counter, toolPrefix)).join("\n\n")
        currentPart = "Continue the unfinished task based on the conversation history and tool results above."
      } else {
        historyPart = historyMessages.map(m => convertMessageToText(m, toolNameById, counter, toolPrefix)).join("\n\n")
        currentPart = extractMessageContent(lastUserMsg, toolNameById, counter, toolPrefix)
      }

      const preamble = `IMPORTANT: <conversation_history> contains prior turns for context only. Do NOT simulate or role-play as any turn — you are the assistant, respond only as yourself.\n\nThe content after </conversation_history> is the current user request.`
      return `${preamble}\n\n<conversation_history>\n${historyPart}\n</conversation_history>\n\n${currentPart}`
    }
  }
  return messages.map(m => extractMessageContent(m, toolNameById, counter, toolPrefix)).join("\n\n") || ""
}

/**
 * Collect multimodal blocks (image/document/file) from messages in order,
 * stripping cache_control. Used to attach actual blocks after the text prompt
 * so that [Image N] labels in the text map to the Nth attached block.
 */
export function collectMultimodalBlocks(messages: Array<{ role: string; content: any }>): any[] {
  const blocks: any[] = []
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue
    for (const block of m.content) {
      if (block.type === "image" || block.type === "document" || block.type === "file") {
        const { cache_control: _cc, ...cleaned } = block
        blocks.push(cleaned)
      }
      if (block.type === "tool_result" && Array.isArray(block.content)) {
        for (const inner of block.content) {
          if (inner.type === "image" || inner.type === "document" || inner.type === "file") {
            const { cache_control: _cc, ...cleaned } = inner
            blocks.push(cleaned)
          }
        }
      }
    }
  }
  return blocks
}

/**
 * Bundle of prompt artifacts for the SDK query.
 * Either `structuredMessages` OR `textPrompt` is populated; `makePrompt`
 * dispatches to the right form and can be called multiple times for retry.
 */
export interface PromptBundle {
  structuredMessages?: Array<{ type: "user"; message: { role: string; content: any }; parent_tool_use_id: null }>
  textPrompt?: string
  toolNameById: Map<string, string>
  toolPrefix: string
  hasMultimodal: boolean
  makePrompt: () => string | AsyncIterable<any>
}

export interface BuildPromptBundleInput {
  messagesToConvert: Array<{ role: string; content: any }>
  allMessages: Array<{ role: string; content: any }>
  isResume: boolean
  useJsonlFresh: boolean
  passthrough: boolean
}

/**
 * Build the SDK prompt (structured or flat text) from the messages selected
 * by the handler. Picks one of three paths:
 *
 * 1. JSONL-fresh + single user message → pass content through as a structured
 *    SDK user message; history already lives in the JSONL transcript.
 * 2. Multimodal (images/documents/files) → flatten text to XML, append blocks.
 * 3. Text-only → `<conversation_history>`-wrapped flat text; on resume, skip
 *    the leading assistant message because the SDK already has it.
 */
export function buildPromptBundle(input: BuildPromptBundleInput): PromptBundle {
  const { messagesToConvert, allMessages, isResume, useJsonlFresh, passthrough } = input

  // Scan ALL messages for tool_use names — undo/fallback paths may slice
  // messagesToConvert to just the last user message whose tool_result blocks
  // reference tool_use ids living in the earlier prefix.
  const toolNameById = new Map<string, string>()
  for (const m of allMessages) {
    if (Array.isArray(m.content)) {
      for (const b of m.content as any[]) {
        if (b.type === "tool_use" && b.id && b.name) toolNameById.set(b.id, b.name)
      }
    }
  }

  const toolPrefix = passthrough ? PASSTHROUGH_MCP_PREFIX : ""
  if (passthrough) {
    for (const [id, name] of toolNameById) {
      toolNameById.set(id, PASSTHROUGH_MCP_PREFIX + name)
    }
  }

  const hasMultimodal = hasMultimodalContent(messagesToConvert ?? [])
  const mmCounter: MultimodalCounter = { image: 0, document: 0, file: 0 }

  let structuredMessages: PromptBundle["structuredMessages"] | undefined
  let textPrompt: string | undefined

  if (useJsonlFresh && messagesToConvert.length === 1 && messagesToConvert[0]?.role === "user") {
    const lastContent = messagesToConvert[0]!.content
    const content = typeof lastContent === "string"
      ? [{ type: "text", text: lastContent }]
      : (Array.isArray(lastContent)
          ? lastContent
          : [{ type: "text", text: String(lastContent ?? "") }])
    structuredMessages = [{
      type: "user" as const,
      message: { role: "user" as const, content },
      parent_tool_use_id: null,
    }]
  } else if (hasMultimodal) {
    let sourceMessages: typeof messagesToConvert
    if (isResume) {
      const skipLeadingAssistant = messagesToConvert[0]?.role === "assistant"
      sourceMessages = skipLeadingAssistant ? messagesToConvert.slice(1) : messagesToConvert
    } else {
      sourceMessages = messagesToConvert
    }

    const textContent = buildTextPromptWithHistory(sourceMessages, toolNameById, mmCounter, toolPrefix)
    const attachedBlocks = collectMultimodalBlocks(sourceMessages)
    structuredMessages = [{
      type: "user" as const,
      message: { role: "user" as const, content: [{ type: "text", text: textContent }, ...attachedBlocks] },
      parent_tool_use_id: null,
    }]
  } else {
    if (isResume) {
      const skipLeadingAssistant = messagesToConvert[0]?.role === "assistant"
      const externalMessages = skipLeadingAssistant ? messagesToConvert.slice(1) : messagesToConvert
      textPrompt = buildTextPromptWithHistory(externalMessages, toolNameById, mmCounter, toolPrefix)
    } else {
      textPrompt = buildTextPromptWithHistory(messagesToConvert, toolNameById, mmCounter, toolPrefix)
    }
  }

  const makePrompt = (): string | AsyncIterable<any> => {
    if (structuredMessages) {
      const msgs = structuredMessages
      return (async function* () { for (const msg of msgs) yield msg })()
    }
    return textPrompt!
  }

  return { structuredMessages, textPrompt, toolNameById, toolPrefix, hasMultimodal, makePrompt }
}

/**
 * Build a prompt from all messages for a fresh (non-resume) session.
 * Used when retrying after a stale session UUID error.
 */
export function buildFreshPrompt(
  messages: Array<{ role: string; content: any }>,
  toolPrefix = "",
): string | AsyncIterable<any> {
  const hasMultimodal = hasMultimodalContent(messages)

  const toolNameById = new Map<string, string>()
  for (const m of messages) {
    if (Array.isArray(m.content)) {
      for (const b of m.content) {
        if (b.type === "tool_use" && b.id && b.name) toolNameById.set(b.id, toolPrefix + b.name)
      }
    }
  }

  if (hasMultimodal) {
    const freshCounter: MultimodalCounter = { image: 0, document: 0, file: 0 }
    const textContent = buildTextPromptWithHistory(messages, toolNameById, freshCounter, toolPrefix)
    const attachedBlocks = collectMultimodalBlocks(messages)
    const structured = [{
      type: "user" as const,
      message: { role: "user" as const, content: [{ type: "text", text: textContent }, ...attachedBlocks] },
      parent_tool_use_id: null,
    }]
    return (async function* () { for (const msg of structured) yield msg })()
  }

  const freshCounter: MultimodalCounter = { image: 0, document: 0, file: 0 }
  return buildTextPromptWithHistory(messages, toolNameById, freshCounter, toolPrefix)
}
