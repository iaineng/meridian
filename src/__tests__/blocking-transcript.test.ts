/**
 * Unit tests for the blockingMode flag on prepareFreshSession and the
 * normalizeToolResultForMcp helper. Verifies:
 *   - blockingMode: false (default) still injects synthetic filler
 *   - blockingMode: true skips synthetic filler on lone-user / trailing-user
 *   - tool_result → MCP CallToolResult shape conversion (string / blocks / images)
 */

import { describe, it, expect } from "bun:test"
import { tmpdir } from "node:os"
import { promises as fs } from "node:fs"
import path from "node:path"
import {
  prepareFreshSession,
  normalizeToolResultForMcp,
} from "../proxy/session/transcript"

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

describe("prepareFreshSession blockingMode", () => {
  it("default mode: lone-user gets synthetic filler + CONTINUE prompt", async () => {
    const cwd = await tmpCwd()
    const messages = [{ role: "user", content: "hello" }]
    const { sessionId, lastUserPrompt, wroteTranscript } = await prepareFreshSession(messages, cwd, {})
    expect(wroteTranscript).toBe(true)
    expect(lastUserPrompt).toBe("Continue.")
    const rows = await readJsonl(cwd, sessionId)
    const hasSyntheticAssistant = rows.some(r =>
      r.type === "assistant" &&
      Array.isArray(r.message?.content) &&
      r.message.content.some((b: any) => b.type === "text" && b.text === "One moment."),
    )
    expect(hasSyntheticAssistant).toBe(true)
  })

  it("blockingMode: lone-user uses real user content as prompt, no synthetic filler", async () => {
    const cwd = await tmpCwd()
    const messages = [{ role: "user", content: "hello there" }]
    const { sessionId, lastUserPrompt, wroteTranscript } = await prepareFreshSession(messages, cwd, {
      blockingMode: true,
    })
    // lone-user + blocking → no JSONL rows needed (last user becomes prompt)
    expect(wroteTranscript).toBe(false)
    // Result is crEncode-processed [{type:"text", text: <encoded>}]
    expect(Array.isArray(lastUserPrompt)).toBe(true)
    const arr = lastUserPrompt as any[]
    expect(arr.length).toBeGreaterThan(0)
    expect(arr[0].type).toBe("text")
    // Session id is generated regardless of wroteTranscript
    expect(sessionId).toMatch(/^[0-9a-f-]{36}$/i)
  })

  it("blockingMode: no JSONL file exists on disk when wroteTranscript is false (regression)", async () => {
    // Regression: the blocking handler must NOT forward `sessionId` as an SDK
    // resume target when no JSONL was written — otherwise the SDK reports
    // "No conversation found with session ID: <uuid>" on the first request.
    const cwd = await tmpCwd()
    const messages = [{ role: "user", content: "first turn" }]
    const { sessionId, wroteTranscript } = await prepareFreshSession(messages, cwd, { blockingMode: true })
    expect(wroteTranscript).toBe(false)
    const baseDir = process.env.CLAUDE_CONFIG_DIR ?? path.join(require("os").homedir(), ".claude")
    const file = path.join(baseDir, "projects", cwd.replace(/[\\/:]/g, "-"), `${sessionId}.jsonl`)
    let existed = true
    try { await fs.access(file) } catch { existed = false }
    expect(existed).toBe(false)
  })

  it("blockingMode: trailing tool_use (pseudo-continuation) also skips synthetic tail", async () => {
    const cwd = await tmpCwd()
    // Assistant with unresolved tool_use + trailing user (simulating resume shape).
    const messages = [
      { role: "user", content: "do something" },
      { role: "assistant", content: [{ type: "tool_use", id: "tu_1", name: "Read", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_1", content: "ok" }] },
    ]
    const { sessionId, wroteTranscript } = await prepareFreshSession(messages, cwd, {
      blockingMode: true,
    })
    expect(wroteTranscript).toBe(true)
    const rows = await readJsonl(cwd, sessionId)
    const hasSyntheticAssistant = rows.some(r =>
      r.type === "assistant" &&
      Array.isArray(r.message?.content) &&
      r.message.content.some((b: any) => b.type === "text" && b.text === "One moment."),
    )
    expect(hasSyntheticAssistant).toBe(false)
  })
})

describe("normalizeToolResultForMcp", () => {
  it("wraps a string tool_result into a single text block", () => {
    const result = normalizeToolResultForMcp({
      type: "tool_result",
      tool_use_id: "tu_1",
      content: "hello output",
    })
    expect(result.content).toEqual([{ type: "text", text: "hello output" }])
    expect(result.isError).toBeUndefined()
  })

  it("passes through text blocks in an array", () => {
    const result = normalizeToolResultForMcp({
      type: "tool_result",
      tool_use_id: "tu_1",
      content: [{ type: "text", text: "line 1" }, { type: "text", text: "line 2" }],
    })
    expect(result.content).toEqual([
      { type: "text", text: "line 1" },
      { type: "text", text: "line 2" },
    ])
  })

  it("remaps image blocks into MCP shape", () => {
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
  })
})
