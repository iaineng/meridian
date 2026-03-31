/**
 * Unit tests for fingerprinting and CWD extraction.
 */
import { describe, it, expect } from "bun:test"
import { extractClientCwd, getConversationFingerprint } from "../proxy/session/fingerprint"

describe("extractClientCwd", () => {
  it("extracts CWD from string system prompt", () => {
    const body = {
      system: "<env>\n  Working directory: /Users/test/project\n  Platform: darwin\n</env>"
    }
    expect(extractClientCwd(body)).toBe("/Users/test/project")
  })

  it("extracts CWD from array system prompt", () => {
    const body = {
      system: [
        { type: "text", text: "<env>\n  Working directory: /home/user/app\n</env>" }
      ]
    }
    expect(extractClientCwd(body)).toBe("/home/user/app")
  })

  it("returns undefined when no system prompt", () => {
    expect(extractClientCwd({})).toBeUndefined()
    expect(extractClientCwd({ system: "" })).toBeUndefined()
  })

  it("returns undefined when no env block", () => {
    expect(extractClientCwd({ system: "You are a helpful assistant" })).toBeUndefined()
  })

  it("returns undefined when no working directory in env", () => {
    expect(extractClientCwd({ system: "<env>\n  Platform: darwin\n</env>" })).toBeUndefined()
  })

  it("handles multiline env blocks", () => {
    const body = {
      system: "Some preamble\n<env>\n  Working directory: /path/to/dir\n  Is a git repository: true\n  Platform: darwin\n</env>\nMore text"
    }
    expect(extractClientCwd(body)).toBe("/path/to/dir")
  })
})

describe("getConversationFingerprint", () => {
  it("returns a 16-char hex fingerprint", () => {
    const fp = getConversationFingerprint([{ role: "user", content: "hello" }])
    expect(fp).toHaveLength(16)
    expect(fp).toMatch(/^[0-9a-f]{16}$/)
  })

  it("returns empty string for no user messages", () => {
    expect(getConversationFingerprint([{ role: "assistant", content: "hi" }])).toBe("")
  })

  it("returns empty string for empty messages", () => {
    expect(getConversationFingerprint([])).toBe("")
  })

  it("returns empty string for empty user content", () => {
    expect(getConversationFingerprint([{ role: "user", content: "" }])).toBe("")
  })

  it("is deterministic", () => {
    const msgs = [{ role: "user", content: "test" }]
    expect(getConversationFingerprint(msgs)).toBe(getConversationFingerprint(msgs))
  })

  it("differs by working directory", () => {
    const msgs = [{ role: "user", content: "same message" }]
    const fp1 = getConversationFingerprint(msgs, "/project/a")
    const fp2 = getConversationFingerprint(msgs, "/project/b")
    expect(fp1).not.toBe(fp2)
  })

  it("handles array content (text blocks)", () => {
    const msgs = [{ role: "user", content: [{ type: "text", text: "hello" }] }]
    const fp = getConversationFingerprint(msgs)
    expect(fp).toHaveLength(16)
  })

  it("uses consecutive user messages from start, stops at non-user role", () => {
    const msgs = [
      { role: "user", content: "first" },
      { role: "assistant", content: "reply" },
      { role: "user", content: "second" },
    ]
    const fpAll = getConversationFingerprint(msgs)
    // Only the first user message is included (assistant breaks the streak)
    const fpFirst = getConversationFingerprint([{ role: "user", content: "first" }])
    expect(fpAll).toBe(fpFirst)
  })

  it("includes multiple consecutive user messages from start", () => {
    const msgs = [
      { role: "user", content: "hello" },
      { role: "user", content: " world" },
      { role: "assistant", content: "reply" },
    ]
    const fpTwo = getConversationFingerprint(msgs)
    const fpOne = getConversationFingerprint([{ role: "user", content: "hello" }])
    // Two consecutive user messages should differ from just one
    expect(fpTwo).not.toBe(fpOne)
    // Should be deterministic
    expect(fpTwo).toBe(getConversationFingerprint(msgs))
  })

  it("hashes non-text content blocks individually", () => {
    const msgs = [
      {
        role: "user",
        content: [
          { type: "text", text: "describe this" },
          { type: "image", source: { type: "base64", data: "abc123" } },
        ],
      },
    ]
    const fp = getConversationFingerprint(msgs)
    expect(fp).toHaveLength(16)
    expect(fp).toMatch(/^[0-9a-f]{16}$/)

    // Non-text block change should produce a different fingerprint
    const msgs2 = [
      {
        role: "user",
        content: [
          { type: "text", text: "describe this" },
          { type: "image", source: { type: "base64", data: "xyz789" } },
        ],
      },
    ]
    expect(getConversationFingerprint(msgs2)).not.toBe(fp)
  })

  it("skips leading non-user messages", () => {
    const msgs = [
      { role: "assistant", content: "hi" },
      { role: "user", content: "hello" },
    ]
    // assistant is first, so loop breaks immediately — no user content collected
    expect(getConversationFingerprint(msgs)).toBe("")
  })
})
