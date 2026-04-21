/**
 * Unit tests for session transcript construction (pure logic + filesystem I/O).
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import {
  sanitizeCwdForProjectDir,
  getProjectSessionPath,
  buildJsonlLines,
  writeSessionTranscript,
  prepareFreshSession,
  deleteSessionTranscript,
  backupSessionTranscript,
  findClientUserBreakpoint,
} from "../proxy/session/transcript"

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

describe("sanitizeCwdForProjectDir", () => {
  it("converts Windows absolute path", () => {
    expect(sanitizeCwdForProjectDir("C:\\Users\\iaine\\Projects\\meridian"))
      .toBe("C--Users-iaine-Projects-meridian")
  })

  it("converts Unix absolute path (leading slash becomes dash)", () => {
    expect(sanitizeCwdForProjectDir("/home/alice/proj")).toBe("-home-alice-proj")
  })

  it("converts root /", () => {
    expect(sanitizeCwdForProjectDir("/")).toBe("-")
  })

  it("leaves string without separators unchanged", () => {
    expect(sanitizeCwdForProjectDir("plain-name")).toBe("plain-name")
  })

  it("preserves dots, spaces, and unicode", () => {
    expect(sanitizeCwdForProjectDir("/home/用户/my project.v2"))
      .toBe("-home-用户-my project.v2")
  })
})

describe("getProjectSessionPath", () => {
  const originalConfigDir = process.env.CLAUDE_CONFIG_DIR

  afterEach(() => {
    if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  })

  it("builds path under ~/.claude/projects/<sanitized>/", () => {
    delete process.env.CLAUDE_CONFIG_DIR
    const p = getProjectSessionPath("/home/u/p", "abc-def")
    expect(p.endsWith(path.join("projects", "-home-u-p", "abc-def.jsonl"))).toBe(true)
    expect(p.startsWith(os.homedir())).toBe(true)
  })

  it("respects CLAUDE_CONFIG_DIR override (read at call time)", () => {
    process.env.CLAUDE_CONFIG_DIR = "/tmp/alt-claude"
    const p = getProjectSessionPath("/home/u/p", "abc-def")
    expect(p).toBe(path.join("/tmp/alt-claude", "projects", "-home-u-p", "abc-def.jsonl"))
  })

  it("has .jsonl extension", () => {
    expect(getProjectSessionPath("/x", "id").endsWith(".jsonl")).toBe(true)
  })
})

describe("buildJsonlLines", () => {
  const sessionId = "11111111-1111-4111-8111-111111111111"
  const cwd = "/tmp/proj"

  it("returns no lines for empty input", () => {
    const { lines, messageUuids } = buildJsonlLines([], sessionId, cwd)
    expect(lines).toEqual([])
    expect(messageUuids).toEqual([])
  })

  it("emits user + synthetic-assistant for a lone user message", () => {
    const { lines, messageUuids } = buildJsonlLines(
      [{ role: "user", content: "hello" }],
      sessionId,
      cwd
    )
    // permission-mode + user + synthetic assistant
    expect(lines).toHaveLength(3)
    const userRow = JSON.parse(lines[1]!)
    const synthRow = JSON.parse(lines[2]!)
    expect(userRow.type).toBe("user")
    expect(userRow.parentUuid).toBeNull()
    expect(synthRow.type).toBe("assistant")
    expect(synthRow.parentUuid).toBe(userRow.uuid)
    expect(synthRow.message.content).toEqual([
      { type: "text", text: "One moment." },
    ])
    // The lone user receives the JSONL history cache breakpoint so the
    // first call can establish prompt cache.
    expect(userRow.message.content[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" })
    // messageUuids points to the lone user (synthetic row is transcript-only).
    expect(messageUuids).toHaveLength(1)
    expect(messageUuids[0]).toBe(userRow.uuid)
  })

  it("writes first N-1 messages for a user/assistant/user history", () => {
    const messages = [
      { role: "user", content: "first question" },
      { role: "assistant", content: [{ type: "text", text: "first answer" }] },
      { role: "user", content: "follow-up" },
    ]
    const { lines, messageUuids } = buildJsonlLines(messages, sessionId, cwd)
    // permission-mode sentinel + 2 message rows
    expect(lines.length).toBe(3)
    expect(messageUuids[0]).toMatch(UUID_RE)
    expect(messageUuids[1]).toMatch(UUID_RE)
    expect(messageUuids[2]).toBeNull()
  })

  it("emits the sentinel permission-mode row first", () => {
    const { lines } = buildJsonlLines(
      [{ role: "user", content: "a" }, { role: "user", content: "b" }],
      sessionId,
      cwd
    )
    const first = JSON.parse(lines[0]!)
    expect(first.type).toBe("permission-mode")
    expect(first.sessionId).toBe(sessionId)
    expect(first.permissionMode).toBe("bypassPermissions")
  })

  it("builds a valid parentUuid chain", () => {
    const { lines, messageUuids } = buildJsonlLines(
      [
        { role: "user", content: "a" },
        { role: "assistant", content: "b" },
        { role: "user", content: "c" },
      ],
      sessionId,
      cwd
    )
    const row1 = JSON.parse(lines[1]!)
    const row2 = JSON.parse(lines[2]!)
    expect(row1.parentUuid).toBeNull()
    expect(row1.uuid).toBe(messageUuids[0])
    expect(row2.parentUuid).toBe(messageUuids[0])
    expect(row2.uuid).toBe(messageUuids[1])
  })

  it("sets isSidechain:false and sessionId on every message row", () => {
    const { lines } = buildJsonlLines(
      [
        { role: "user", content: "a" },
        { role: "assistant", content: "b" },
        { role: "user", content: "c" },
      ],
      sessionId,
      cwd
    )
    for (const line of lines.slice(1)) {
      const row = JSON.parse(line)
      expect(row.isSidechain).toBe(false)
      expect(row.sessionId).toBe(sessionId)
      expect(row.cwd).toBe(cwd)
    }
  })

  it("preserves tool_result block structure on user messages (crEncode applied to body)", () => {
    const toolResult = {
      type: "tool_result",
      tool_use_id: "toolu_abc",
      content: "file contents here",
    }
    const { lines } = buildJsonlLines(
      [
        { role: "user", content: "a" },
        { role: "assistant", content: "b" },
        { role: "user", content: [toolResult] },
        { role: "assistant", content: "done" },
      ],
      sessionId,
      cwd
    )
    const row = JSON.parse(lines[3]!)
    expect(row.type).toBe("user")
    // Fallback breakpoint lands on this last user row (last block).
    expect(row.message.content[0]).toEqual({
      type: "tool_result",
      tool_use_id: "toolu_abc",
      content: "file\r contents\r here",
      cache_control: { type: "ephemeral", ttl: "1h" },
    })
  })

  it("wraps assistant content into a BetaMessage shape", () => {
    const toolUse = { type: "tool_use", id: "toolu_xyz", name: "Read", input: { path: "/x" } }
    const { lines } = buildJsonlLines(
      [
        { role: "user", content: "a" },
        { role: "assistant", content: [toolUse] },
        { role: "user", content: "ok" },
      ],
      sessionId,
      cwd,
      { model: "claude-sonnet-4-6" }
    )
    const row = JSON.parse(lines[2]!)
    expect(row.type).toBe("assistant")
    expect(row.message.type).toBe("message")
    expect(row.message.role).toBe("assistant")
    expect(row.message.id).toMatch(/^msg_01[0-9a-zA-Z]{22}$/)
    expect(row.message.model).toBe("claude-sonnet-4-6")
    expect(row.message.content).toEqual([toolUse])
    expect(row.message.stop_reason).toBe("end_turn")
    expect(row.message.usage).toEqual({ input_tokens: 0, output_tokens: 0 })
  })

  it("preserves multimodal image blocks structurally (no [Image N] fallback)", () => {
    const imageBlock = {
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "AAAA" },
    }
    const { lines } = buildJsonlLines(
      [
        { role: "user", content: [imageBlock, { type: "text", text: "what's this?" }] },
        { role: "assistant", content: "a cat" },
        { role: "user", content: "thanks" },
      ],
      sessionId,
      cwd
    )
    const row = JSON.parse(lines[1]!)
    // image block unchanged; text block gets crEncode + fallback breakpoint
    // (last block of the last user row in JSONL).
    expect(row.message.content[0]).toEqual(imageBlock)
    expect(row.message.content[1]).toEqual({
      type: "text",
      text: "what\r's\r this\r?",
      cache_control: { type: "ephemeral", ttl: "1h" },
    })
  })

  it("applies crEncode to user string content AND wraps as array", () => {
    const { lines } = buildJsonlLines(
      [
        { role: "user", content: "hello world" },
        { role: "assistant", content: "hi there" },
        { role: "user", content: "ok" },
      ],
      sessionId,
      cwd
    )
    const userRow = JSON.parse(lines[1]!)
    // String content is pre-wrapped as [{type:"text", text}] so the byte
    // representation stays stable across requests. Fallback breakpoint is
    // placed on the last (only) block.
    expect(userRow.message.content).toEqual([
      { type: "text", text: "hello\r world", cache_control: { type: "ephemeral", ttl: "1h" } },
    ])
  })

  it("applies crEncode to text blocks in user content arrays", () => {
    const { lines } = buildJsonlLines(
      [
        { role: "user", content: [{ type: "text", text: "look at this" }] },
        { role: "assistant", content: "ok" },
        { role: "user", content: "thanks" },
      ],
      sessionId,
      cwd
    )
    const userRow = JSON.parse(lines[1]!)
    expect(userRow.message.content[0]).toEqual({
      type: "text",
      text: "look\r at\r this",
      cache_control: { type: "ephemeral", ttl: "1h" },
    })
  })

  it("applies crEncode inside tool_result content (string)", () => {
    const { lines } = buildJsonlLines(
      [
        { role: "user", content: "read it" },
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "file body here" }] },
        { role: "assistant", content: "done" },
      ],
      sessionId,
      cwd
    )
    const toolResultRow = JSON.parse(lines[3]!)
    expect(toolResultRow.message.content[0]).toEqual({
      type: "tool_result",
      tool_use_id: "t1",
      content: "file\r body\r here",
      cache_control: { type: "ephemeral", ttl: "1h" },
    })
  })

  it("applies crEncode inside tool_result content (text blocks)", () => {
    const { lines } = buildJsonlLines(
      [
        { role: "user", content: "read" },
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }] },
        {
          role: "user",
          content: [{
            type: "tool_result",
            tool_use_id: "t1",
            content: [{ type: "text", text: "inner body" }],
          }],
        },
        { role: "assistant", content: "done" },
      ],
      sessionId,
      cwd
    )
    const toolResultRow = JSON.parse(lines[3]!)
    expect(toolResultRow.message.content[0].content[0]).toEqual({
      type: "text",
      text: "inner\r body",
    })
  })

  it("does NOT apply crEncode to assistant content", () => {
    const { lines } = buildJsonlLines(
      [
        { role: "user", content: "q" },
        { role: "assistant", content: [{ type: "text", text: "my answer here" }] },
        { role: "user", content: "k" },
      ],
      sessionId,
      cwd
    )
    const assistantRow = JSON.parse(lines[2]!)
    // Fallback places the breakpoint on the last user row, not the assistant.
    expect(assistantRow.message.content[0]).toEqual({
      type: "text",
      text: "my answer here",
    })
  })

  it("does NOT crEncode image source data", () => {
    const imageBlock = {
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "AAAA+/=BBBB" },
    }
    const { lines } = buildJsonlLines(
      [
        { role: "user", content: [imageBlock, { type: "text", text: "see this" }] },
        { role: "assistant", content: "ok" },
        { role: "user", content: "thanks" },
      ],
      sessionId,
      cwd
    )
    const userRow = JSON.parse(lines[1]!)
    expect(userRow.message.content[0]).toEqual(imageBlock)
    expect(userRow.message.content[1]).toEqual({
      type: "text",
      text: "see\r this",
      cache_control: { type: "ephemeral", ttl: "1h" },
    })
  })

  it("preserves thinking blocks with signature verbatim", () => {
    const thinkingBlock = {
      type: "thinking",
      thinking: "Let me reason about this step by step...",
      signature: "EswCClkIDBgCIkDaBcZ+signature_bytes_here",
    }
    const { lines } = buildJsonlLines(
      [
        { role: "user", content: "solve it" },
        { role: "assistant", content: [thinkingBlock, { type: "text", text: "answer" }] },
        { role: "user", content: "thanks" },
      ],
      sessionId,
      cwd
    )
    const row = JSON.parse(lines[2]!)
    expect(row.type).toBe("assistant")
    expect(row.message.content).toEqual([
      thinkingBlock,
      { type: "text", text: "answer" },
    ])
    expect(row.message.content[0].signature).toBe(thinkingBlock.signature)
  })

  it("strips caller cache_control at nested depths and normalizes the mirrored top-level value", () => {
    const { lines } = buildJsonlLines(
      [
        {
          role: "user",
          content: [
            { type: "text", text: "hello", cache_control: { type: "ephemeral", ttl: "5m" } },
            {
              type: "tool_result",
              tool_use_id: "toolu_1",
              content: [{ type: "text", text: "inner", cache_control: { type: "ephemeral" } }],
            },
          ],
        },
        { role: "assistant", content: "hi" },
        { role: "user", content: "k" },
      ],
      sessionId,
      cwd
    )
    const row = JSON.parse(lines[1]!)
    // Client's top-level cache_control position is mirrored but its value is
    // normalized to our 1h ephemeral (ttl="5m" is replaced, not preserved).
    expect(row.message.content[0]).toEqual({
      type: "text",
      text: "hello",
      cache_control: { type: "ephemeral", ttl: "1h" },
    })
    // Nested cache_control inside tool_result.content is fully stripped.
    expect(row.message.content[1]).toEqual({
      type: "tool_result",
      tool_use_id: "toolu_1",
      content: [{ type: "text", text: "inner" }],
    })
  })

  it("falls back to the last user row in JSONL when client has no cache_control and JSONL ends on a real assistant", () => {
    const { lines } = buildJsonlLines(
      [
        { role: "user", content: "first" },
        { role: "assistant", content: [{ type: "text", text: "one" }] },
        { role: "user", content: "second" },
        { role: "assistant", content: [{ type: "text", text: "two" }] },
        { role: "user", content: "third" },
      ],
      sessionId,
      cwd
    )

    // sentinel + first user + first assistant + second user + second assistant
    const firstUser = JSON.parse(lines[1]!)
    const firstAssistant = JSON.parse(lines[2]!)
    const secondUser = JSON.parse(lines[3]!)
    const secondAssistant = JSON.parse(lines[4]!)
    expect(firstUser.message.content[0].cache_control).toBeUndefined()
    expect(firstAssistant.message.content[0].cache_control).toBeUndefined()
    // Last user row in JSONL receives the fallback 1h ephemeral breakpoint.
    expect(secondUser.message.content[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" })
    expect(secondAssistant.message.content[0].cache_control).toBeUndefined()
  })

  it("mirrors the client's last user cache_control onto the same user row and block index", () => {
    const { lines } = buildJsonlLines(
      [
        { role: "user", content: [{ type: "text", text: "first" }] },
        { role: "assistant", content: [{ type: "text", text: "one" }] },
        {
          role: "user",
          content: [
            { type: "text", text: "pick this block", cache_control: { type: "ephemeral", ttl: "5m" } },
            { type: "text", text: "later block" },
          ],
        },
        { role: "assistant", content: [{ type: "text", text: "two" }] },
        { role: "user", content: "third" },
      ],
      sessionId,
      cwd
    )

    // sentinel + user + assistant + user(targeted) + assistant
    const firstUser = JSON.parse(lines[1]!)
    const firstAssistant = JSON.parse(lines[2]!)
    const targetedUser = JSON.parse(lines[3]!)
    const lastAssistant = JSON.parse(lines[4]!)
    expect(firstUser.message.content[0].cache_control).toBeUndefined()
    expect(firstAssistant.message.content[0].cache_control).toBeUndefined()
    // Position preserved (block 0), value substituted with our 1h ephemeral.
    expect(targetedUser.message.content[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" })
    expect(targetedUser.message.content[1].cache_control).toBeUndefined()
    expect(lastAssistant.message.content[0].cache_control).toBeUndefined()
  })

  it("picks the latest cache_control across multiple user breakpoints", () => {
    const { lines } = buildJsonlLines(
      [
        {
          role: "user",
          content: [{ type: "text", text: "earlier", cache_control: { type: "ephemeral" } }],
        },
        { role: "assistant", content: [{ type: "text", text: "mid" }] },
        {
          role: "user",
          content: [{ type: "text", text: "later", cache_control: { type: "ephemeral" } }],
        },
        { role: "assistant", content: [{ type: "text", text: "tail" }] },
      ],
      sessionId,
      cwd
    )
    const earlierUser = JSON.parse(lines[1]!)
    const laterUser = JSON.parse(lines[3]!)
    expect(earlierUser.message.content[0].cache_control).toBeUndefined()
    expect(laterUser.message.content[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" })
  })

  it("treats consecutive-user tail [u1, u2] as lone-user-like: both written + synthetic tail + u2 cache_control preserved", () => {
    const { lines, messageUuids } = buildJsonlLines(
      [
        { role: "user", content: [{ type: "text", text: "prep" }] },
        {
          role: "user",
          content: [{ type: "text", text: "actual", cache_control: { type: "ephemeral", ttl: "5m" } }],
        },
      ],
      sessionId,
      cwd
    )
    // permission-mode + u1 + u2 + synthetic assistant
    expect(lines).toHaveLength(4)
    const u1 = JSON.parse(lines[1]!)
    const u2 = JSON.parse(lines[2]!)
    const syntheticAssistant = JSON.parse(lines[3]!)
    expect(u1.type).toBe("user")
    expect(u2.type).toBe("user")
    expect(syntheticAssistant.type).toBe("assistant")
    expect(syntheticAssistant.message.content).toEqual([{ type: "text", text: "One moment." }])
    // u2's client cache_control position is mirrored, value normalized to 1h.
    expect(u2.message.content[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" })
    // u1 stays untouched.
    expect(u1.message.content[0].cache_control).toBeUndefined()
    // Both uuids are populated (trailing user is no longer the prompt).
    expect(messageUuids).toHaveLength(2)
    expect(messageUuids[0]).toMatch(UUID_RE)
    expect(messageUuids[1]).toMatch(UUID_RE)
  })

  it("treats [u1, u2] without cache_control as lone-user-like and falls back to u2's last block", () => {
    const { lines } = buildJsonlLines(
      [
        { role: "user", content: "prep" },
        { role: "user", content: "actual" },
      ],
      sessionId,
      cwd
    )
    // permission-mode + u1 + u2 + synthetic assistant
    expect(lines).toHaveLength(4)
    const u1 = JSON.parse(lines[1]!)
    const u2 = JSON.parse(lines[2]!)
    expect(u1.message.content[0].cache_control).toBeUndefined()
    expect(u2.message.content[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" })
  })

  it("treats all-user histories [u1, u2, u3] the same way: all written + synthetic tail + breakpoint on latest user with cache_control", () => {
    const { lines, messageUuids } = buildJsonlLines(
      [
        { role: "user", content: [{ type: "text", text: "one" }] },
        {
          role: "user",
          content: [{ type: "text", text: "two", cache_control: { type: "ephemeral" } }],
        },
        { role: "user", content: [{ type: "text", text: "three" }] },
      ],
      sessionId,
      cwd
    )
    // permission-mode + u1 + u2 + u3 + synthetic assistant
    expect(lines).toHaveLength(5)
    const u1 = JSON.parse(lines[1]!)
    const u2 = JSON.parse(lines[2]!)
    const u3 = JSON.parse(lines[3]!)
    const synthetic = JSON.parse(lines[4]!)
    expect(u1.type).toBe("user")
    expect(u2.type).toBe("user")
    expect(u3.type).toBe("user")
    expect(synthetic.type).toBe("assistant")
    // u2 carries the only client cache_control → it wins even though u3 is later.
    expect(u1.message.content[0].cache_control).toBeUndefined()
    expect(u2.message.content[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" })
    expect(u3.message.content[0].cache_control).toBeUndefined()
    // Every input message received a UUID; none was treated as prompt.
    expect(messageUuids).toHaveLength(3)
    expect(messageUuids.every(u => u !== null && UUID_RE.test(u!))).toBe(true)
  })

  it("falls back to the last user row when client only marks the prompt user", () => {
    const { lines } = buildJsonlLines(
      [
        { role: "user", content: [{ type: "text", text: "first" }] },
        { role: "assistant", content: [{ type: "text", text: "reply" }] },
        {
          role: "user",
          content: [{ type: "text", text: "final", cache_control: { type: "ephemeral" } }],
        },
      ],
      sessionId,
      cwd
    )
    // sentinel + user + assistant (prompt user stripped out of JSONL)
    expect(lines).toHaveLength(3)
    const firstUser = JSON.parse(lines[1]!)
    const assistant = JSON.parse(lines[2]!)
    // Prompt-only client breakpoint is not visible to the JSONL scan
    // (sliceEnd excludes the prompt), so the fallback kicks in and places
    // the breakpoint on the single user row in JSONL.
    expect(firstUser.message.content[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" })
    expect(assistant.message.content[0].cache_control).toBeUndefined()
  })

  it("skips the synthetic continue assistant and gives the single breakpoint to the preceding user row", () => {
    const { lines } = buildJsonlLines(
      [
        { role: "user", content: "first" },
        { role: "assistant", content: [{ type: "text", text: "stable answer" }] },
        { role: "user", content: "read" },
        { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "Read", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "body" }] },
      ],
      sessionId,
      cwd
    )

    const earlierAssistant = JSON.parse(lines[2]!)
    const readUser = JSON.parse(lines[3]!)
    const toolResultUser = JSON.parse(lines[5]!)
    const syntheticAssistant = JSON.parse(lines[6]!)
    expect(earlierAssistant.message.content[0].cache_control).toBeUndefined()
    expect(readUser.message.content[0].cache_control).toBeUndefined()
    expect(toolResultUser.message.content[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" })
    expect(syntheticAssistant.message.content[0].cache_control).toBeUndefined()
  })

  it("writes ALL messages when the history ends with an assistant", () => {
    const messages = [
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
      { role: "user", content: "c" },
      { role: "assistant", content: "d" },
    ]
    const { lines, messageUuids } = buildJsonlLines(messages, sessionId, cwd)
    // sentinel + 4 messages
    expect(lines.length).toBe(5)
    expect(messageUuids.every(u => u !== null && UUID_RE.test(u))).toBe(true)
  })

  it("prepends toolPrefix to assistant tool_use.name", () => {
    const { lines } = buildJsonlLines(
      [
        { role: "user", content: "read" },
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "toolu_1", name: "Read", input: { path: "/a" } },
          ],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "body" }],
        },
        { role: "assistant", content: [{ type: "text", text: "done" }] },
      ],
      sessionId,
      cwd,
      { toolPrefix: "mcp__tools__" }
    )
    // sentinel + 4 messages written (trailing assistant keeps all N)
    expect(lines.length).toBe(5)
    const assistantRow = JSON.parse(lines[2]!)
    expect(assistantRow.message.content[0]).toEqual({
      type: "tool_use",
      id: "toolu_1",
      name: "mcp__tools__Read",
      input: { path: "/a" },
    })
    // tool_result.tool_use_id stays unchanged — it references the id, not the name
    const userRow = JSON.parse(lines[3]!)
    expect(userRow.message.content[0].tool_use_id).toBe("toolu_1")
  })

  it("does not double-prefix tool_use.name already carrying the prefix", () => {
    const { lines } = buildJsonlLines(
      [
        { role: "user", content: "a" },
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "toolu_1", name: "mcp__tools__Read", input: {} },
          ],
        },
        { role: "user", content: "k" },
      ],
      sessionId,
      cwd,
      { toolPrefix: "mcp__tools__" }
    )
    const row = JSON.parse(lines[2]!)
    expect(row.message.content[0].name).toBe("mcp__tools__Read")
  })

  it("leaves tool_use.name unchanged when toolPrefix is empty/undefined", () => {
    const { lines } = buildJsonlLines(
      [
        { role: "user", content: "a" },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "toolu_1", name: "Read", input: {} }],
        },
        { role: "user", content: "k" },
      ],
      sessionId,
      cwd
    )
    const row = JSON.parse(lines[2]!)
    expect(row.message.content[0].name).toBe("Read")
  })

  it("propagates gitBranch and version metadata", () => {
    const { lines } = buildJsonlLines(
      [
        { role: "user", content: "a" },
        { role: "user", content: "b" },
      ],
      sessionId,
      cwd,
      { gitBranch: "feature-x", version: "meridian/1.29.2" }
    )
    const row = JSON.parse(lines[1]!)
    expect(row.gitBranch).toBe("feature-x")
    expect(row.version).toBe("meridian/1.29.2")
    expect(row.userType).toBe("external")
  })
})

describe("findClientUserBreakpoint", () => {
  it("returns null when no user message carries cache_control", () => {
    const result = findClientUserBreakpoint(
      [
        { role: "user", content: "hi" },
        { role: "assistant", content: "ok" },
        { role: "user", content: [{ type: "text", text: "again" }] },
      ],
      3,
    )
    expect(result).toBeNull()
  })

  it("ignores cache_control on assistant messages", () => {
    const result = findClientUserBreakpoint(
      [
        { role: "user", content: [{ type: "text", text: "q" }] },
        { role: "assistant", content: [{ type: "text", text: "a", cache_control: { type: "ephemeral" } }] },
      ],
      2,
    )
    expect(result).toBeNull()
  })

  it("returns the latest user message's last cache_control block index", () => {
    const result = findClientUserBreakpoint(
      [
        {
          role: "user",
          content: [{ type: "text", text: "first", cache_control: { type: "ephemeral" } }],
        },
        { role: "assistant", content: "a" },
        {
          role: "user",
          content: [
            { type: "text", text: "keep" },
            { type: "text", text: "pick-me", cache_control: { type: "ephemeral" } },
            { type: "text", text: "tail" },
          ],
        },
        { role: "assistant", content: "b" },
      ],
      4,
    )
    expect(result).toEqual({ messageIndex: 2, blockIndex: 1 })
  })

  it("only considers messages inside the JSONL slice", () => {
    // sliceEnd = 2 means the prompt user at index 2 is NOT in JSONL.
    const result = findClientUserBreakpoint(
      [
        { role: "user", content: [{ type: "text", text: "hi" }] },
        { role: "assistant", content: "ok" },
        {
          role: "user",
          content: [{ type: "text", text: "last", cache_control: { type: "ephemeral" } }],
        },
      ],
      2,
    )
    expect(result).toBeNull()
  })

  it("ignores nested cache_control inside tool_result content", () => {
    const result = findClientUserBreakpoint(
      [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "t1",
              content: [{ type: "text", text: "inner", cache_control: { type: "ephemeral" } }],
            },
          ],
        },
      ],
      1,
    )
    expect(result).toBeNull()
  })
})

describe("writeSessionTranscript", () => {
  let tmp: string
  const originalConfigDir = process.env.CLAUDE_CONFIG_DIR

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "meridian-transcript-"))
    process.env.CLAUDE_CONFIG_DIR = tmp
  })

  afterEach(async () => {
    if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    await fs.rm(tmp, { recursive: true, force: true })
  })

  it("writes lines to the correct project path with newline separators", async () => {
    const sessionId = "22222222-2222-4222-8222-222222222222"
    const cwd = "/my/project"
    const lines = [`{"a":1}`, `{"b":2}`]
    await writeSessionTranscript(cwd, sessionId, lines)
    const expected = path.join(tmp, "projects", "-my-project", `${sessionId}.jsonl`)
    const content = await fs.readFile(expected, "utf8")
    expect(content).toBe(`{"a":1}\n{"b":2}\n`)
  })

  it("creates the projects directory if missing", async () => {
    const sessionId = "33333333-3333-4333-8333-333333333333"
    await writeSessionTranscript("/fresh/path", sessionId, [`{"x":1}`])
    const p = path.join(tmp, "projects", "-fresh-path", `${sessionId}.jsonl`)
    await expect(fs.stat(p)).resolves.toBeTruthy()
  })

  it("is a no-op when given zero lines", async () => {
    const sessionId = "44444444-4444-4444-8444-444444444444"
    await writeSessionTranscript("/x", sessionId, [])
    const p = path.join(tmp, "projects", "-x", `${sessionId}.jsonl`)
    await expect(fs.stat(p)).rejects.toBeTruthy()
  })
})

describe("prepareFreshSession", () => {
  let tmp: string
  const originalConfigDir = process.env.CLAUDE_CONFIG_DIR

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "meridian-transcript-"))
    process.env.CLAUDE_CONFIG_DIR = tmp
  })

  afterEach(async () => {
    if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    await fs.rm(tmp, { recursive: true, force: true })
  })

  it("writes a JSONL with user + synthetic-assistant for a lone user message", async () => {
    const r = await prepareFreshSession([{ role: "user", content: "hi" }], "/p")
    expect(r.wroteTranscript).toBe(true)
    // Lone-user case: prompt is the user_message synthetic-tail user prompt,
    // paired with the matching synthetic assistant filler in the JSONL above.
    expect(r.lastUserPrompt).toBe("Continue.")
    expect(r.sessionId).toMatch(UUID_RE)
    expect(r.messageUuids).toHaveLength(1)
    expect(r.messageUuids[0]).toMatch(UUID_RE)
  })

  it("returns the last user content as lastUserPrompt", async () => {
    const r = await prepareFreshSession(
      [
        { role: "user", content: "first" },
        { role: "assistant", content: "answer" },
        { role: "user", content: "latest" },
      ],
      "/p"
    )
    expect(r.wroteTranscript).toBe(true)
    expect(r.lastUserPrompt).toEqual([{ type: "text", text: "latest" }])
  })

  it("uses the prefill directive when history ends with assistant", async () => {
    const r = await prepareFreshSession(
      [
        { role: "user", content: "q" },
        { role: "assistant", content: "a" },
      ],
      "/p"
    )
    expect(r.wroteTranscript).toBe(true)
    expect(r.lastUserPrompt).toBe("<system-reminder>Resume output starting at the exact character after your previous assistant turn ended. Do not repeat any already-emitted characters. Do not add preamble, commentary, apology, or markdown fences. Emit only the raw continuation.</system-reminder>")
    // All N messages written: messageUuids has no trailing null
    expect(r.messageUuids.every(u => u !== null)).toBe(true)
  })

  it("replaces the continue prompt with a StructuredOutput directive when outputFormat is set", async () => {
    // Lone-user path → synthetic continuation → prompt should direct the
    // model to terminate via the StructuredOutput tool call.
    const loneUser = await prepareFreshSession(
      [{ role: "user", content: "hi" }],
      "/p",
      { outputFormat: true }
    )
    expect(loneUser.lastUserPrompt).toContain("Call the StructuredOutput tool")
    expect(loneUser.lastUserPrompt as string).toMatch(/^<system-reminder>/)

    // Trailing tool_use path → same synthetic continuation path.
    const trailingToolUse = await prepareFreshSession(
      [
        { role: "user", content: "q" },
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
      ],
      "/p",
      { outputFormat: true }
    )
    expect(trailingToolUse.lastUserPrompt).toContain("Call the StructuredOutput tool")
    expect(trailingToolUse.lastUserPrompt as string).toMatch(/^<system-reminder>/)

    // Normal last-user path → outputFormat flag has NO effect (prompt is the
    // real user content, not a synthetic sentinel).
    const normal = await prepareFreshSession(
      [
        { role: "user", content: "first" },
        { role: "assistant", content: "a" },
        { role: "user", content: "latest" },
      ],
      "/p",
      { outputFormat: true }
    )
    expect(normal.lastUserPrompt).toEqual([{ type: "text", text: "latest" }])
  })

  it("uses a conditional StructuredOutput directive when other tools are also registered", async () => {
    // outputFormat + hasOtherTools → softer prompt: only call StructuredOutput
    // when no further tool calls are needed and the final result is ready.
    const loneUserWithTools = await prepareFreshSession(
      [{ role: "user", content: "hi" }],
      "/p",
      { outputFormat: true, hasOtherTools: true }
    )
    expect(loneUserWithTools.lastUserPrompt).toContain(
      "If you do not need to call any other tool this turn and the final result is ready, your response MUST be exactly one StructuredOutput tool call with the final structured result and nothing else. Otherwise, continue using the other tools and do not call StructuredOutput yet."
    )
    expect(loneUserWithTools.lastUserPrompt as string).toMatch(/^<system-reminder>/)

    const trailingToolUseWithTools = await prepareFreshSession(
      [
        { role: "user", content: "q" },
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
      ],
      "/p",
      { outputFormat: true, hasOtherTools: true }
    )
    expect(trailingToolUseWithTools.lastUserPrompt).toContain(
      "If you do not need to call any other tool this turn and the final result is ready, your response MUST be exactly one StructuredOutput tool call with the final structured result and nothing else. Otherwise, continue using the other tools and do not call StructuredOutput yet."
    )
    expect(trailingToolUseWithTools.lastUserPrompt as string).toMatch(/^<system-reminder>/)

    // hasOtherTools without outputFormat → still the plain user_message
    // synthetic-tail user prompt.
    const noOutputFormat = await prepareFreshSession(
      [{ role: "user", content: "hi" }],
      "/p",
      { hasOtherTools: true }
    )
    expect(noOutputFormat.lastUserPrompt).toBe("Continue.")
  })

  it("generates a valid UUIDv4 session id", async () => {
    const r = await prepareFreshSession(
      [{ role: "user", content: "x" }, { role: "user", content: "y" }],
      "/p"
    )
    expect(r.sessionId).toMatch(UUID_RE)
  })

  it("writes the jsonl file to the expected path", async () => {
    const r = await prepareFreshSession(
      [
        { role: "user", content: "q" },
        { role: "assistant", content: "a" },
        { role: "user", content: "q2" },
      ],
      "/x/y"
    )
    const p = path.join(tmp, "projects", "-x-y", `${r.sessionId}.jsonl`)
    const text = await fs.readFile(p, "utf8")
    const lines = text.trim().split("\n")
    expect(lines.length).toBe(3) // sentinel + 2 message rows
    const sentinel = JSON.parse(lines[0]!)
    expect(sentinel.type).toBe("permission-mode")
  })

  it("uses opts.sessionId instead of generating a new UUID", async () => {
    const fixedId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    const r = await prepareFreshSession(
      [
        { role: "user", content: "q" },
        { role: "assistant", content: "a" },
        { role: "user", content: "q2" },
      ],
      "/x/y",
      { sessionId: fixedId }
    )
    expect(r.sessionId).toBe(fixedId)
    const p = path.join(tmp, "projects", "-x-y", `${fixedId}.jsonl`)
    await expect(fs.stat(p)).resolves.toBeTruthy()
  })

})

describe("deleteSessionTranscript", () => {
  let tmp: string
  const originalConfigDir = process.env.CLAUDE_CONFIG_DIR

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "meridian-transcript-"))
    process.env.CLAUDE_CONFIG_DIR = tmp
  })

  afterEach(async () => {
    if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    await fs.rm(tmp, { recursive: true, force: true })
  })

  it("removes a previously-written transcript", async () => {
    const sessionId = "55555555-5555-4555-8555-555555555555"
    await writeSessionTranscript("/a/b", sessionId, [`{"x":1}`])
    const p = path.join(tmp, "projects", "-a-b", `${sessionId}.jsonl`)
    await expect(fs.stat(p)).resolves.toBeTruthy()
    await deleteSessionTranscript("/a/b", sessionId)
    await expect(fs.stat(p)).rejects.toBeTruthy()
  })

  it("is a no-op when the file does not exist", async () => {
    const sessionId = "66666666-6666-4666-8666-666666666666"
    await expect(deleteSessionTranscript("/nope", sessionId)).resolves.toBeUndefined()
  })
})

describe("backupSessionTranscript", () => {
  let tmp: string
  const originalConfigDir = process.env.CLAUDE_CONFIG_DIR

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "meridian-transcript-"))
    process.env.CLAUDE_CONFIG_DIR = tmp
  })

  afterEach(async () => {
    if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    await fs.rm(tmp, { recursive: true, force: true })
  })

  it("renames the file to a uniquely-suffixed .bak", async () => {
    const sessionId = "77777777-7777-4777-8777-777777777777"
    await writeSessionTranscript("/a/b", sessionId, [`{"x":1}`])
    const dir = path.join(tmp, "projects", "-a-b")
    const p = path.join(dir, `${sessionId}.jsonl`)
    await backupSessionTranscript("/a/b", sessionId)
    await expect(fs.stat(p)).rejects.toBeTruthy()
    const entries = await fs.readdir(dir)
    const baks = entries.filter(e => e.startsWith(`${sessionId}.jsonl.`) && e.endsWith(".bak"))
    expect(baks.length).toBe(1)
  })

  it("preserves every backup across successive calls on the same session id", async () => {
    const sessionId = "77777777-7777-4777-8777-777777777778"
    const dir = path.join(tmp, "projects", "-a-b")
    for (let i = 0; i < 3; i++) {
      await writeSessionTranscript("/a/b", sessionId, [`{"x":${i}}`])
      await backupSessionTranscript("/a/b", sessionId)
    }
    const entries = await fs.readdir(dir)
    const baks = entries.filter(e => e.startsWith(`${sessionId}.jsonl.`) && e.endsWith(".bak"))
    expect(baks.length).toBe(3)
  })

  it("is a no-op when the file does not exist", async () => {
    const sessionId = "88888888-8888-4888-8888-888888888888"
    await expect(backupSessionTranscript("/nope", sessionId)).resolves.toBeUndefined()
  })
})
