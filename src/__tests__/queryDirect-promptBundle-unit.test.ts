/**
 * `buildPromptBundle` Path-0 (query-direct) tests. The new branch must
 * short-circuit the JSONL/multimodal/text paths and produce an
 * AsyncIterable that yields the exact records the handler supplied.
 */

import { describe, it, expect } from "bun:test"
import { buildPromptBundle } from "../proxy/pipeline/prompt"
import type { QueryDirectMessage } from "../proxy/session/queryDirect"

function direct(text: string): QueryDirectMessage {
  return {
    type: "user",
    message: { role: "user", content: [{ type: "text", text }] },
    parent_tool_use_id: null,
  }
}

describe("buildPromptBundle path 0 (query-direct)", () => {
  it("directPromptMessages provided → structuredMessages identity, textPrompt undefined", () => {
    const direct1 = direct("hi")
    const direct2 = direct("there")
    const bundle = buildPromptBundle({
      messagesToConvert: [],
      allMessages: [{ role: "user", content: "hi" }, { role: "user", content: "there" }],
      isResume: false,
      useJsonlFresh: false,
      passthrough: false,
      directPromptMessages: [direct1, direct2],
    })
    expect(bundle.structuredMessages).toEqual([direct1, direct2])
    expect(bundle.textPrompt).toBeUndefined()
    expect(bundle.hasMultimodal).toBe(false)
  })

  it("makePrompt() yields each record in order", async () => {
    const direct1 = direct("a")
    const direct2 = direct("b")
    const bundle = buildPromptBundle({
      messagesToConvert: [],
      allMessages: [],
      isResume: false,
      useJsonlFresh: false,
      passthrough: false,
      directPromptMessages: [direct1, direct2],
    })
    const out: QueryDirectMessage[] = []
    const iter = bundle.makePrompt()
    if (typeof iter === "string") throw new Error("expected AsyncIterable")
    for await (const m of iter) out.push(m as QueryDirectMessage)
    expect(out).toEqual([direct1, direct2])
  })

  it("path 0 wins even when useJsonlFresh is also true (defensive)", () => {
    const d = direct("only")
    const bundle = buildPromptBundle({
      messagesToConvert: [{ role: "user", content: "only" }],
      allMessages: [{ role: "user", content: "only" }],
      isResume: false,
      useJsonlFresh: true,
      passthrough: false,
      directPromptMessages: [d],
    })
    expect(bundle.structuredMessages).toEqual([d])
    expect(bundle.textPrompt).toBeUndefined()
  })

  it("empty directPromptMessages array falls through to existing paths", () => {
    const bundle = buildPromptBundle({
      messagesToConvert: [{ role: "user", content: "fall through" }],
      allMessages: [{ role: "user", content: "fall through" }],
      isResume: false,
      useJsonlFresh: false,
      passthrough: false,
      directPromptMessages: [],
    })
    // Should hit the text-only path and produce a textPrompt.
    expect(bundle.textPrompt).toBeDefined()
    expect(bundle.structuredMessages).toBeUndefined()
  })

  it("toolPrefix reflects passthrough flag", () => {
    const d = direct("x")
    const bundleNoPass = buildPromptBundle({
      messagesToConvert: [],
      allMessages: [],
      isResume: false,
      useJsonlFresh: false,
      passthrough: false,
      directPromptMessages: [d],
    })
    expect(bundleNoPass.toolPrefix).toBe("")

    const bundlePass = buildPromptBundle({
      messagesToConvert: [],
      allMessages: [],
      isResume: false,
      useJsonlFresh: false,
      passthrough: true,
      directPromptMessages: [d],
    })
    expect(bundlePass.toolPrefix.length).toBeGreaterThan(0)
  })
})
