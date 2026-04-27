/**
 * Unit tests for prepareFreshSession (ephemeral/blocking share the same JSONL
 * construction) and the normalizeToolResultForMcp helper. Verifies:
 *   - lone-user, [u1, u2], trailing tool_use paths all get synthetic FILLER
 *     so the JSONL always ends on assistant (avoids CLI's
 *     deserializeMessages injecting a `NO_RESPONSE_REQUESTED` sentinel on
 *     resume).
 *   - tool_result → MCP CallToolResult shape conversion (string / blocks /
 *     images)
 */

import { describe, it, expect } from "bun:test"
import { tmpdir } from "node:os"
import { promises as fs } from "node:fs"
import path from "node:path"
import {
  prepareFreshSession,
  normalizeToolResultForMcp,
} from "../proxy/session/transcript"
import { crEncode } from "../proxy/obfuscate"

async function tmpCwd(): Promise<string> {
  const dir = path.join(tmpdir(), `meridian-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  await fs.mkdir(dir, { recursive: true })
  return dir
}

async function readJsonl(cwd: string, sessionId: string): Promise<any[]> {
  const baseDir = process.env.CLAUDE_CONFIG_DIR ?? path.join(require("os").homedir(), ".claude")
  const file = path.join(baseDir, "projects", cwd.replace(/[\\/:]/g, "-"), `${sessionId}.jsonl`)
  const text = await fs.readFile(file, "utf8")
  return text.trim().split("\n").map(l => JSON.parse(l))
}

function hasSyntheticAssistant(rows: any[]): boolean {
  return rows.some(r =>
    r.type === "assistant" &&
    Array.isArray(r.message?.content) &&
    r.message.content.some((b: any) => b.type === "text" && b.text === "No response requested."),
  )
}

describe("prepareFreshSession (ephemeral/blocking share identical JSONL construction)", () => {
  it("lone-user: filler appended, prompt = 'Continue from where you left off.', JSONL ends on assistant", async () => {
    const cwd = await tmpCwd()
    const { sessionId, lastUserPrompt, wroteTranscript } = await prepareFreshSession(
      [{ role: "user", content: "hello" }], cwd, {},
    )
    expect(wroteTranscript).toBe(true)
    expect(lastUserPrompt).toBe("Continue from where you left off.")
    const rows = await readJsonl(cwd, sessionId)
    expect(hasSyntheticAssistant(rows)).toBe(true)
    // CLI-compat invariant: JSONL last row must be assistant so
    // deserializeMessages does NOT splice in a NO_RESPONSE_REQUESTED sentinel.
    expect(rows[rows.length - 1]!.type).toBe("assistant")
  })

  it("[u1, u2] (no assistant history): filler appended, prompt = 'Continue from where you left off.', JSONL ends on assistant", async () => {
    const cwd = await tmpCwd()
    const { sessionId, lastUserPrompt, wroteTranscript } = await prepareFreshSession(
      [
        { role: "user", content: "prep context" },
        { role: "user", content: "do the thing" },
      ], cwd, {},
    )
    expect(wroteTranscript).toBe(true)
    expect(lastUserPrompt).toBe("Continue from where you left off.")
    const rows = await readJsonl(cwd, sessionId)
    expect(hasSyntheticAssistant(rows)).toBe(true)
    expect(rows[rows.length - 1]!.type).toBe("assistant")
  })

  it("trailing tool_use + tool_result: filler appended, prompt = 'Continue from where you left off.'", async () => {
    const cwd = await tmpCwd()
    const messages = [
      { role: "user", content: "do something" },
      { role: "assistant", content: [{ type: "tool_use", id: "tu_1", name: "Read", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_1", content: "ok" }] },
    ]
    const { sessionId, lastUserPrompt, wroteTranscript } = await prepareFreshSession(messages, cwd, {})
    expect(wroteTranscript).toBe(true)
    expect(lastUserPrompt).toBe("Continue from where you left off.")
    const rows = await readJsonl(cwd, sessionId)
    expect(hasSyntheticAssistant(rows)).toBe(true)
    expect(rows[rows.length - 1]!.type).toBe("assistant")
  })

  it("normal [u, a, u]: no filler, prompt = real u content, JSONL ends on assistant a", async () => {
    const cwd = await tmpCwd()
    const messages = [
      { role: "user", content: "first" },
      { role: "assistant", content: [{ type: "text", text: "hi" }] },
      { role: "user", content: "follow-up" },
    ]
    const { sessionId, lastUserPrompt, wroteTranscript } = await prepareFreshSession(messages, cwd, {})
    expect(wroteTranscript).toBe(true)
    // Trailing user becomes the prompt (crEncoded + wrapped as array).
    expect(Array.isArray(lastUserPrompt)).toBe(true)
    expect((lastUserPrompt as any[])[0].text).toBe(crEncode("follow-up"))
    const rows = await readJsonl(cwd, sessionId)
    expect(hasSyntheticAssistant(rows)).toBe(false)
    // JSONL last row is real assistant `a`, not a filler.
    expect(rows[rows.length - 1]!.type).toBe("assistant")
  })
})

describe("normalizeToolResultForMcp", () => {
  it("wraps a string tool_result into a single crEncoded text block", () => {
    const result = normalizeToolResultForMcp({
      type: "tool_result",
      tool_use_id: "tu_1",
      content: "hello output",
    })
    expect(result.content).toEqual([{ type: "text", text: crEncode("hello output") }])
    expect(result.isError).toBeUndefined()
  })

  it("crEncodes text blocks in an array", () => {
    const result = normalizeToolResultForMcp({
      type: "tool_result",
      tool_use_id: "tu_1",
      content: [{ type: "text", text: "line 1" }, { type: "text", text: "line 2" }],
    })
    expect(result.content).toEqual([
      { type: "text", text: crEncode("line 1") },
      { type: "text", text: crEncode("line 2") },
    ])
  })

  it("remaps image blocks into MCP shape without encoding", () => {
    const result = normalizeToolResultForMcp({
      type: "tool_result",
      tool_use_id: "tu_1",
      content: [{
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo" },
      }],
    })
    expect(result.content).toEqual([
      { type: "image", data: "iVBORw0KGgo", mimeType: "image/png" },
    ])
  })

  it("propagates is_error → isError", () => {
    const result = normalizeToolResultForMcp({
      type: "tool_result",
      tool_use_id: "tu_1",
      content: "oops",
      is_error: true,
    })
    expect(result.isError).toBe(true)
    expect(result.content).toEqual([{ type: "text", text: crEncode("oops") }])
  })

  it("text bytes match crEncodeToolResultContent output for cache-prefix parity", () => {
    // Cache-parity guarantee: the bytes handed to the MCP handler during the
    // agent loop MUST equal the bytes a follow-up JSONL rebuild would produce
    // from the same client-sent string. If this invariant breaks, prior
    // mid-loop cache_control markers are invalidated on the next user turn.
    const raw = "line one: details (v1) -> result"
    const result = normalizeToolResultForMcp({
      type: "tool_result",
      tool_use_id: "tu_1",
      content: raw,
    })
    expect(result.content[0]).toEqual({ type: "text", text: crEncode(raw) })
  })

  it("collapses tool_reference blocks to a crEncoded text label", () => {
    // Some clients emit `tool_reference` inside tool_result.content to nudge
    // the model toward a related tool. Anthropic does not accept that as a
    // valid inner type, so the proxy folds it to a text block with a stable
    // "tool_reference: <name>" label that mirrors serializeToolResultContentToText.
    const result = normalizeToolResultForMcp({
      type: "tool_result",
      tool_use_id: "tu_1",
      content: [{ type: "tool_reference", tool_name: "Read" }],
    })
    expect(result.content).toEqual([
      { type: "text", text: crEncode("tool_reference: Read") },
    ])
  })

  it("preserves sibling text/image blocks alongside tool_reference", () => {
    const result = normalizeToolResultForMcp({
      type: "tool_result",
      tool_use_id: "tu_1",
      content: [
        { type: "text", text: "see also:" },
        { type: "tool_reference", tool_name: "Grep" },
      ],
    })
    expect(result.content).toEqual([
      { type: "text", text: crEncode("see also:") },
      { type: "text", text: crEncode("tool_reference: Grep") },
    ])
  })

  it("drops tool_reference blocks without a tool_name", () => {
    // No tool_name → no useful payload. Skip the block instead of emitting
    // an empty `tool_reference: ` label that would just confuse the model.
    const result = normalizeToolResultForMcp({
      type: "tool_result",
      tool_use_id: "tu_1",
      content: [{ type: "tool_reference" }],
    })
    expect(result.content).toEqual([])
  })
})
