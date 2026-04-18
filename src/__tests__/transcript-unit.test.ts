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
      { type: "text", text: "..." },
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
    expect(row.message.content[0]).toEqual({
      type: "tool_result",
      tool_use_id: "toolu_abc",
      content: "file\r contents\r here",
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
    // image block unchanged; text block gets crEncode
    expect(row.message.content[0]).toEqual(imageBlock)
    expect(row.message.content[1]).toEqual({ type: "text", text: "what\r's\r this\r?" })
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
    // representation stays stable across requests (SDK's n6A wraps strings
    // only when the message is "last" — without this normalization, the same
    // message has two different shapes in consecutive requests and breaks
    // Anthropic's prompt cache hash at that turn).
    expect(userRow.message.content).toEqual([
      { type: "text", text: "hello\r world" },
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
    expect(userRow.message.content[0]).toEqual({ type: "text", text: "look\r at\r this" })
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
    expect(assistantRow.message.content[0]).toEqual({
      type: "text",
      text: "my answer here",
      cache_control: { type: "ephemeral", ttl: "1h" },
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
    expect(userRow.message.content[1]).toEqual({ type: "text", text: "see\r this" })
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
      { type: "text", text: "answer", cache_control: { type: "ephemeral", ttl: "1h" } },
    ])
    expect(row.message.content[0].signature).toBe(thinkingBlock.signature)
  })

  it("strips caller cache_control at all depths", () => {
    const { lines } = buildJsonlLines(
      [
        {
          role: "user",
          content: [
            { type: "text", text: "hello", cache_control: { type: "ephemeral" } },
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
    expect(row.message.content[0]).toEqual({ type: "text", text: "hello" })
    expect(row.message.content[1]).toEqual({
      type: "tool_result",
      tool_use_id: "toolu_1",
      content: [{ type: "text", text: "inner" }],
    })
  })

  it("adds cache_control only to the most recent assistant text row", () => {
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

    const firstAssistant = JSON.parse(lines[2]!)
    const secondAssistant = JSON.parse(lines[4]!)
    expect(firstAssistant.message.content[0].cache_control).toBeUndefined()
    expect(secondAssistant.message.content[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" })
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
    // Lone-user case: prompt becomes the "Continue." sentinel so the lone
    // user row lives in the JSONL (where it gets the cache breakpoint) and
    // the SDK resumes on top of a well-formed user→assistant chain.
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

  it("uses \"Continue.\" when history ends with assistant", async () => {
    const r = await prepareFreshSession(
      [
        { role: "user", content: "q" },
        { role: "assistant", content: "a" },
      ],
      "/p"
    )
    expect(r.wroteTranscript).toBe(true)
    expect(r.lastUserPrompt).toBe("Continue.")
    // All N messages written: messageUuids has no trailing null
    expect(r.messageUuids.every(u => u !== null)).toBe(true)
  })

  it("augments the Continue. prompt with a StructuredOutput instruction when outputFormat is set", async () => {
    // Lone-user path → synthetic continuation → prompt should direct the
    // model to terminate via the StructuredOutput tool call.
    const loneUser = await prepareFreshSession(
      [{ role: "user", content: "hi" }],
      "/p",
      { outputFormat: true }
    )
    expect(loneUser.lastUserPrompt).toBe("Continue. End by calling the StructuredOutput tool.")

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
    expect(trailingToolUse.lastUserPrompt).toBe("Continue. End by calling the StructuredOutput tool.")

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
