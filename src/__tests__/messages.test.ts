/**
 * Unit tests for message parsing utilities.
 */
import { describe, it, expect } from "bun:test"
import { normalizeContent, getLastUserMessage, hasMultimodalContent, nextMultimodalLabel, serializeToolResultContentToText, mergeAdjacentSameRole, type MultimodalCounter } from "../proxy/messages"

describe("normalizeContent", () => {
  it("returns string content as-is", () => {
    expect(normalizeContent("hello")).toBe("hello")
  })

  it("extracts text from text content blocks", () => {
    const content = [{ type: "text", text: "hello world" }]
    expect(normalizeContent(content)).toBe("hello world")
  })

  it("handles tool_use blocks", () => {
    const content = [{ type: "tool_use", id: "tu_1", name: "Read", input: { file: "a.ts" } }]
    const result = normalizeContent(content)
    expect(result).toContain("tool_use:Read:")
    expect(result).toContain('"file":"a.ts"')
    expect(result).not.toContain("tu_1")
  })

  it("normalizes tool_use ids and input object key order like drift checks", () => {
    const a = [{ type: "tool_use", id: "tu_1", name: "Read", input: { path: "a.ts", opts: { depth: 1, mode: "r" } } }]
    const b = [{ type: "tool_use", id: "tu_REWRITTEN", name: "Read", input: { opts: { mode: "r", depth: 1 }, path: "a.ts" } }]
    expect(normalizeContent(a)).toBe(normalizeContent(b))
  })

  it("handles tool_result blocks with string content", () => {
    const content = [{ type: "tool_result", tool_use_id: "tu_1", content: "file contents" }]
    const result = normalizeContent(content)
    expect(result).toBe("tool_result:tu_1:file contents")
  })

  it("handles tool_result blocks with object content", () => {
    const content = [{ type: "tool_result", tool_use_id: "tu_1", content: { key: "val" } }]
    const result = normalizeContent(content)
    expect(result).toContain("tool_result:tu_1:")
    expect(result).toContain('"key":"val"')
  })

  it("handles mixed content blocks", () => {
    const content = [
      { type: "text", text: "hello" },
      { type: "text", text: "world" },
    ]
    expect(normalizeContent(content)).toBe("hello\nworld")
  })

  it("JSON stringifies unknown block types", () => {
    const content = [{ type: "image", data: "base64" }]
    const result = normalizeContent(content)
    expect(result).toContain('"type":"image"')
  })

  it("produces stable hashes when cache_control is added to text blocks", () => {
    const without = [{ type: "text", text: "hello" }]
    const withCC = [{ type: "text", text: "hello", cache_control: { type: "ephemeral" } }]
    // text blocks extract only .text, so cache_control is already ignored
    expect(normalizeContent(without)).toBe(normalizeContent(withCC))
  })

  it("produces stable hashes when cache_control is added to tool_result content blocks", () => {
    const without = [{ type: "tool_result", tool_use_id: "tu_1", content: [{ type: "text", text: "result" }] }]
    const withCC = [{ type: "tool_result", tool_use_id: "tu_1", content: [{ type: "text", text: "result", cache_control: { type: "ephemeral" } }] }]
    expect(normalizeContent(without)).toBe(normalizeContent(withCC))
  })

  it("produces stable hashes when cache_control is added to unknown block types", () => {
    const without = [{ type: "image", data: "base64" }]
    const withCC = [{ type: "image", data: "base64", cache_control: { type: "ephemeral" } }]
    expect(normalizeContent(without)).toBe(normalizeContent(withCC))
  })

  it("converts non-string non-array to string", () => {
    expect(normalizeContent(42)).toBe("42")
    expect(normalizeContent(null)).toBe("null")
    expect(normalizeContent(true)).toBe("true")
  })
})

describe("getLastUserMessage", () => {
  it("returns the last user message", () => {
    const messages = [
      { role: "user", content: "first" },
      { role: "assistant", content: "reply" },
      { role: "user", content: "second" },
    ]
    const result = getLastUserMessage(messages)
    expect(result).toHaveLength(1)
    expect(result[0]!.content).toBe("second")
  })

  it("returns last message as fallback when no user messages", () => {
    const messages = [
      { role: "assistant", content: "reply" },
    ]
    const result = getLastUserMessage(messages)
    expect(result).toHaveLength(1)
    expect(result[0]!.content).toBe("reply")
  })

  it("handles empty array", () => {
    const result = getLastUserMessage([])
    expect(result).toHaveLength(0)
  })

  it("returns single user message from single-message array", () => {
    const messages = [{ role: "user", content: "only" }]
    const result = getLastUserMessage(messages)
    expect(result).toHaveLength(1)
    expect(result[0]!.content).toBe("only")
  })
})

describe("nextMultimodalLabel", () => {
  it("returns sequential labels for the same type", () => {
    const counter: MultimodalCounter = { image: 0, document: 0, file: 0 }
    expect(nextMultimodalLabel("image", counter)).toBe("[Image 1]")
    expect(nextMultimodalLabel("image", counter)).toBe("[Image 2]")
  })

  it("tracks types independently", () => {
    const counter: MultimodalCounter = { image: 0, document: 0, file: 0 }
    expect(nextMultimodalLabel("image", counter)).toBe("[Image 1]")
    expect(nextMultimodalLabel("document", counter)).toBe("[Document 1]")
    expect(nextMultimodalLabel("file", counter)).toBe("[File 1]")
    expect(nextMultimodalLabel("image", counter)).toBe("[Image 2]")
  })
})

describe("hasMultimodalContent", () => {
  it("detects top-level image block", () => {
    const messages = [{ role: "user", content: [{ type: "image", source: { type: "base64", data: "abc" } }] }]
    expect(hasMultimodalContent(messages)).toBe(true)
  })

  it("detects image nested inside tool_result.content", () => {
    const messages = [{
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: "tu_1",
        content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "abc" } }],
      }],
    }]
    expect(hasMultimodalContent(messages)).toBe(true)
  })

  it("returns false for text-only messages", () => {
    const messages = [{ role: "user", content: [{ type: "text", text: "hello" }] }]
    expect(hasMultimodalContent(messages)).toBe(false)
  })

  it("returns false for tool_result with string content", () => {
    const messages = [{ role: "user", content: [{ type: "tool_result", tool_use_id: "tu_1", content: "text result" }] }]
    expect(hasMultimodalContent(messages)).toBe(false)
  })

  it("handles string message content", () => {
    const messages = [{ role: "user", content: "hello" }]
    expect(hasMultimodalContent(messages)).toBe(false)
  })
})

describe("serializeToolResultContentToText", () => {
  it("returns string content as-is", () => {
    const counter: MultimodalCounter = { image: 0, document: 0, file: 0 }
    expect(serializeToolResultContentToText("file contents", counter)).toBe("file contents")
  })

  it("extracts text from text blocks", () => {
    const counter: MultimodalCounter = { image: 0, document: 0, file: 0 }
    const content = [{ type: "text", text: "result line 1" }, { type: "text", text: "result line 2" }]
    expect(serializeToolResultContentToText(content, counter)).toBe("result line 1\nresult line 2")
  })

  it("replaces image blocks with indexed labels", () => {
    const counter: MultimodalCounter = { image: 0, document: 0, file: 0 }
    const content = [{ type: "image", source: { type: "base64", media_type: "image/png", data: "iVBOR..." } }]
    const result = serializeToolResultContentToText(content, counter)
    expect(result).toBe("[Image 1]: attached")
    expect(result).not.toContain("iVBOR")
  })

  it("handles mixed text and image content", () => {
    const counter: MultimodalCounter = { image: 0, document: 0, file: 0 }
    const content = [
      { type: "text", text: "Screenshot captured:" },
      { type: "image", source: { type: "base64", data: "abc" } },
    ]
    expect(serializeToolResultContentToText(content, counter)).toBe("Screenshot captured:\n[Image 1]: attached")
  })

  it("returns empty string for null/undefined", () => {
    const counter: MultimodalCounter = { image: 0, document: 0, file: 0 }
    expect(serializeToolResultContentToText(null, counter)).toBe("")
    expect(serializeToolResultContentToText(undefined, counter)).toBe("")
  })
})

describe("mergeAdjacentSameRole", () => {
  it("returns original array when no adjacent same-role messages", () => {
    const msgs = [
      { role: "user", content: "hello" },
      { role: "assistant", content: [{ type: "text", text: "hi" }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_1", content: "ok" }] },
    ]
    expect(mergeAdjacentSameRole(msgs)).toBe(msgs)
  })

  it("returns original array for empty input", () => {
    const msgs: any[] = []
    expect(mergeAdjacentSameRole(msgs)).toBe(msgs)
  })

  it("returns original array for single message", () => {
    const msgs = [{ role: "user", content: "only" }]
    expect(mergeAdjacentSameRole(msgs)).toBe(msgs)
  })

  it("merges two adjacent assistant messages (string + array with tool_use)", () => {
    const msgs = [
      { role: "user", content: "go" },
      { role: "assistant", content: "Let me check." },
      { role: "assistant", content: [
        { type: "text", text: "..." },
        { type: "tool_use", id: "tu_1", name: "Read", input: { path: "README" } },
      ] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_1", content: "readme" }] },
    ]
    const result = mergeAdjacentSameRole(msgs)
    expect(result).toHaveLength(3)
    expect(result[0]!.role).toBe("user")
    expect(result[1]!.role).toBe("assistant")
    expect(Array.isArray(result[1]!.content)).toBe(true)
    expect(result[1]!.content).toHaveLength(3)
    expect(result[1]!.content[0]).toEqual({ type: "text", text: "Let me check." })
    expect(result[1]!.content[1]).toEqual({ type: "text", text: "..." })
    expect(result[1]!.content[2].type).toBe("tool_use")
    expect(result[1]!.content[2].name).toBe("Read")
    expect(result[2]!.role).toBe("user")
  })

  it("merges two adjacent user messages", () => {
    const msgs = [
      { role: "user", content: "first" },
      { role: "user", content: [{ type: "text", text: "second" }] },
    ]
    const result = mergeAdjacentSameRole(msgs)
    expect(result).toHaveLength(1)
    expect(result[0]!.content).toEqual([
      { type: "text", text: "first" },
      { type: "text", text: "second" },
    ])
  })

  it("merges three consecutive same-role messages into one", () => {
    const msgs = [
      { role: "assistant", content: "part1" },
      { role: "assistant", content: "part2" },
      { role: "assistant", content: [{ type: "tool_use", id: "tu_1", name: "Read", input: {} }] },
    ]
    const result = mergeAdjacentSameRole(msgs)
    expect(result).toHaveLength(1)
    expect(result[0]!.content).toHaveLength(3)
    expect(result[0]!.content[0]).toEqual({ type: "text", text: "part1" })
    expect(result[0]!.content[1]).toEqual({ type: "text", text: "part2" })
    expect(result[0]!.content[2].type).toBe("tool_use")
  })

  it("handles the reported ClaudeCode scenario end-to-end", () => {
    const msgs = [
      { role: "user", content: [{ text: "测试工具ClaudeCode", type: "text" }] },
      { role: "assistant", content: "    好的，我来测试 ClaudeCode 工具的功能。" },
      { role: "assistant", content: [
        { text: "...", type: "text" },
        { id: "view_file_outline", input: { absolutePath: "/some/path" }, name: "view_file_outline", type: "tool_use" },
      ] },
      { role: "user", content: [
        { content: [{ text: "Total lines: 43", type: "text" }], tool_use_id: "view_file_outline", type: "tool_result" },
      ] },
    ]
    const result = mergeAdjacentSameRole(msgs)
    expect(result).toHaveLength(3)
    expect(result[1]!.role).toBe("assistant")
    expect(Array.isArray(result[1]!.content)).toBe(true)
    const assistantContent = result[1]!.content
    expect(assistantContent.some((b: any) => b.type === "tool_use" && b.name === "view_file_outline")).toBe(true)
    expect(assistantContent[0]).toEqual({ type: "text", text: "    好的，我来测试 ClaudeCode 工具的功能。" })
  })
})
