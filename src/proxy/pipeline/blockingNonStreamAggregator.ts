/**
 * Reverse-parse the SSE frames produced by `translateBlockingMessage`
 * into a single Anthropic-format JSON Message.
 *
 * Used by `runBlockingNonStream` so the non-streaming HTTP variant of
 * blocking-MCP can re-use the exact same `BufferedEvent` stream that the
 * streaming variant forwards verbatim. The aggregator covers exactly one
 * SDK turn (one HTTP round): consumer pushes frames as they arrive, the
 * non-stream sink calls `build` at `close_round` or `end`.
 *
 * Frame shape produced by `translateBlockingMessage`:
 *   event: <type>\ndata: <json>\n\n
 *
 * `message_stop` is intentionally never emitted in SSE form by the
 * blocking pipeline (suppressed at the translator and synthesised at the
 * sink), so this aggregator never observes it.
 */

export interface BlockingJsonMessage {
  id: string
  type: "message"
  role: "assistant"
  content: Array<Record<string, unknown>>
  model: string
  stop_reason: string
  usage: Record<string, unknown>
}

export interface BlockingJsonAggregator {
  consumeSseFrame(frame: Uint8Array): void
  /** Mark how the SDK terminated; used only by `end` events from the consumer. */
  markEnd(reason: "end_turn" | "max_tokens" | "error"): void
  build(model: string): BlockingJsonMessage
}

function parseFrame(text: string): { type: string; data: any } | null {
  // Format is exactly "event: <type>\ndata: <json>\n\n". Heartbeats start
  // with ":" and never reach this aggregator (stream-mode-only). Any other
  // shape is a wire-protocol violation: ignore.
  if (!text.startsWith("event: ")) return null
  const nl = text.indexOf("\n", 7)
  if (nl < 0) return null
  const type = text.slice(7, nl)
  if (!text.startsWith("data: ", nl + 1)) return null
  const dataStart = nl + 1 + 6
  const dataEnd = text.indexOf("\n\n", dataStart)
  const json = text.slice(dataStart, dataEnd < 0 ? undefined : dataEnd)
  try {
    return { type, data: JSON.parse(json) }
  } catch {
    return null
  }
}

export function createBlockingJsonAggregator(): BlockingJsonAggregator {
  const decoder = new TextDecoder()
  const contentBlocks: Array<Record<string, unknown>> = []
  const sdkIndexToContentIdx = new Map<number, number>()
  const jsonBuffers = new Map<number, string>()
  let messageId: string | undefined
  let baseUsage: Record<string, unknown> = {}
  let finalOutputTokens = 0
  let stopReason = "end_turn"

  return {
    consumeSseFrame(frame): void {
      const text = decoder.decode(frame)
      const parsed = parseFrame(text)
      if (!parsed) return
      const { type, data } = parsed
      const eventIndex = data?.index as number | undefined

      if (type === "message_start") {
        const id = data?.message?.id
        if (typeof id === "string" && !messageId) messageId = id
        const startUsage = data?.message?.usage
        if (startUsage && typeof startUsage === "object") {
          baseUsage = { ...startUsage }
        }
        sdkIndexToContentIdx.clear()
        jsonBuffers.clear()
        return
      }

      if (type === "content_block_start") {
        const block = { ...(data?.content_block || {}) } as Record<string, unknown>
        contentBlocks.push(block)
        if (eventIndex !== undefined) {
          sdkIndexToContentIdx.set(eventIndex, contentBlocks.length - 1)
        }
        return
      }

      if (type === "content_block_delta") {
        if (eventIndex === undefined) return
        const blockIdx = sdkIndexToContentIdx.get(eventIndex)
        if (blockIdx === undefined) return
        const block = contentBlocks[blockIdx] as Record<string, unknown>
        const delta = data?.delta
        if (!delta || typeof delta !== "object") return
        if (delta.type === "text_delta" && typeof delta.text === "string") {
          block.text = ((block.text as string | undefined) ?? "") + delta.text
        } else if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
          jsonBuffers.set(eventIndex, (jsonBuffers.get(eventIndex) ?? "") + delta.partial_json)
        } else if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
          block.thinking = ((block.thinking as string | undefined) ?? "") + delta.thinking
        } else if (delta.type === "signature_delta" && typeof delta.signature === "string") {
          block.signature = ((block.signature as string | undefined) ?? "") + delta.signature
        }
        return
      }

      if (type === "content_block_stop") {
        if (eventIndex !== undefined && jsonBuffers.has(eventIndex)) {
          const blockIdx = sdkIndexToContentIdx.get(eventIndex)
          if (blockIdx !== undefined) {
            try {
              (contentBlocks[blockIdx] as any).input = JSON.parse(jsonBuffers.get(eventIndex)!)
            } catch {
              // malformed JSON — leave whatever input the content_block_start carried
            }
          }
          jsonBuffers.delete(eventIndex)
        }
        return
      }

      if (type === "message_delta") {
        const ds = data?.delta?.stop_reason
        if (typeof ds === "string") stopReason = ds
        const u = data?.usage
        if (u && typeof u === "object" && u.output_tokens != null) {
          finalOutputTokens = u.output_tokens as number
        }
        return
      }
    },

    markEnd(reason): void {
      if (reason === "max_tokens") stopReason = "max_tokens"
      // end_turn / error: keep whatever message_delta provided.
    },

    build(model): BlockingJsonMessage {
      const hasToolUse = contentBlocks.some((b) => b.type === "tool_use")
      const finalStopReason = stopReason === "end_turn" && hasToolUse ? "tool_use" : stopReason
      return {
        id: messageId || `msg_${Date.now()}`,
        type: "message",
        role: "assistant",
        content: contentBlocks,
        model,
        stop_reason: finalStopReason,
        usage: { ...baseUsage, output_tokens: finalOutputTokens },
      }
    },
  }
}
