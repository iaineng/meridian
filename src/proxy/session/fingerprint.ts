/**
 * Conversation fingerprinting.
 */

import { xxh64 as xxh64BigInt } from "@node-rs/xxhash"

/** 64-bit xxHash → 16-char hex string. */
function xxh64(data: string): string {
  return xxh64BigInt(data).toString(16).padStart(16, "0")
}

/**
 * Hash the leading user messages + working directory to fingerprint a conversation.
 * Collects ALL consecutive user-role messages from the start of the array
 * until a non-user role is encountered, producing a more reliable fingerprint
 * than using only the very first user message.
 *
 * For text content blocks the raw text is included; for non-text blocks
 * (images, tool_result, etc.) a per-block hash is included instead.
 *
 * Includes workingDirectory (stable per project, unlike systemContext which
 * contains dynamic file trees/diagnostics that change every request).
 * This prevents cross-project collisions when different projects start
 * with the same first message.
 */
export function getConversationFingerprint(messages: Array<{ role: string; content: any }>, workingDirectory?: string): string {
  if (!messages || messages.length === 0) return ""

  const parts: string[] = []
  for (const m of messages) {
    if (m.role !== "user") break

    if (typeof m.content === "string") {
      parts.push(m.content)
    } else if (Array.isArray(m.content)) {
      for (const block of m.content) {
        if (block.type === "text" && block.text) {
          parts.push(block.text)
        } else {
          // Non-text content: hash individually so binary data
          // (images, etc.) doesn't bloat the seed string.
          parts.push(xxh64(JSON.stringify(block)))
        }
      }
    } else if (m.content != null) {
      parts.push(String(m.content))
    }
  }

  const text = parts.join("")
  if (!text) return ""
  const seed = workingDirectory ? `${workingDirectory}\n${text}` : text
  return xxh64(seed)
}
