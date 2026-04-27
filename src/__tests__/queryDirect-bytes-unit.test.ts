/**
 * Byte-equivalence guarantee: the user-message content produced by the
 * query-direct path (`buildQueryDirectMessages`) must equal — byte-for-byte —
 * the corresponding `message.content` written into the JSONL by
 * `buildJsonlLines` for the same input message. This is the load-bearing
 * invariant that keeps Anthropic's prompt cache warm across the
 * R1 (query-direct) → R2 (rebuilt JSONL) boundary.
 *
 * Drift detection: if anyone edits one of the two normalization paths
 * without updating the other, this test fails immediately.
 */

import { describe, it, expect } from "bun:test"
import { buildQueryDirectMessages } from "../proxy/session/queryDirect"
import {
  buildJsonlLines,
  normalizeUserContentForSdk,
  normalizeUserContentForSdkPath,
  stripCacheControlDeep,
} from "../proxy/session/transcript"

/**
 * R1 query-direct path emits content with NO cache_control — the SDK applies
 * its own breakpoint to the trailing message via `addCacheBreakpoints` →
 * `userMessageToMessageParam(addCache=true)` (cli.js
 * services/api/claude.ts:609-620), unconditionally overwriting whatever the
 * caller passed in.
 *
 * R2 prepareFreshSession path writes the JSONL u1 row WITH meridian's
 * `JSONL_HISTORY_CACHE_CONTROL` stamped on by `applyJsonlHistoryBreakpoints`
 * — that row is non-last on R2 and SDK's addCacheBreakpoints leaves
 * non-marker content untouched.
 *
 * Byte alignment for prompt cache reuse therefore demands non-cc content
 * equality, not full equality. We strip cache_control from both sides
 * before comparing so the assertion stays meaningful even when one side
 * carries the meridian anchor and the other does not.
 */

/**
 * Pull the first user row's `message.content` out of a JSONL line set.
 * Line 0 is the permission-mode sentinel; line 1 is the first transcript row.
 */
function firstUserRowContent(lines: string[]): any {
  // Skip the permission-mode sentinel; find the first user row.
  for (let i = 1; i < lines.length; i++) {
    const row = JSON.parse(lines[i]!)
    if (row?.type === "user") return row.message?.content
  }
  throw new Error("no user row in JSONL")
}

describe("normalizeUserContentForSdk byte stability", () => {
  it("string → wrapped [{type:text}] (with crEncode applied)", () => {
    const out = normalizeUserContentForSdk("hello world")
    expect(Array.isArray(out)).toBe(true)
    expect(out[0]?.type).toBe("text")
    // We don't assert exact crEncode output (encoding is deterministic but
    // implementation-specific); just that the wrapping shape is correct.
    expect(typeof out[0]?.text).toBe("string")
  })

  it("array passes through (text crEncoded, tool_result recursed)", () => {
    const out = normalizeUserContentForSdk([{ type: "text", text: "hi" }])
    expect(Array.isArray(out)).toBe(true)
    expect(out[0]?.type).toBe("text")
  })
})

describe("stripCacheControlDeep", () => {
  it("strips cache_control from top-level blocks", () => {
    const out = stripCacheControlDeep([
      { type: "text", text: "x", cache_control: { type: "ephemeral" } },
    ])
    expect(out[0]).toEqual({ type: "text", text: "x" })
  })

  it("recurses into tool_result.content", () => {
    const out = stripCacheControlDeep([
      {
        type: "tool_result",
        tool_use_id: "t1",
        content: [
          { type: "text", text: "y", cache_control: { type: "ephemeral" } },
        ],
      },
    ])
    expect(out[0]?.content[0]).toEqual({ type: "text", text: "y" })
  })

  it("returns null/undefined unchanged", () => {
    expect(stripCacheControlDeep(null)).toBe(null)
    expect(stripCacheControlDeep(undefined)).toBe(undefined)
  })

  it("returns string unchanged", () => {
    expect(stripCacheControlDeep("plain")).toBe("plain")
  })
})

describe("byte alignment: query-direct vs JSONL row", () => {
  // The fixture content set covers the four real-world shapes the proxy sees:
  //  - plain string user content
  //  - explicit text-block array
  //  - text content with client-supplied cache_control (must be stripped)
  //  - tool_result content (rare for lone-user, but the function path must
  //    still produce equal bytes for any shape it accepts)
  const fixtures: Array<{ label: string; content: any }> = [
    { label: "string", content: "hello" },
    { label: "string with non-ascii (crEncode)", content: "你好" },
    {
      label: "text-block array",
      content: [{ type: "text", text: "block content" }],
    },
    {
      label: "text-block with cache_control (must be stripped)",
      content: [
        { type: "text", text: "cached", cache_control: { type: "ephemeral" } },
      ],
    },
    {
      label: "tool_result block (nested cache_control)",
      content: [
        {
          type: "tool_result",
          tool_use_id: "t1",
          content: [
            { type: "text", text: "nested", cache_control: { type: "ephemeral" } },
          ],
        },
      ],
    },
    {
      label: "tool_result with tool_reference (folded to text)",
      content: [
        {
          type: "tool_result",
          tool_use_id: "t1",
          content: [
            { type: "text", text: "consider also:" },
            { type: "tool_reference", tool_name: "Grep" },
          ],
        },
      ],
    },
    {
      label: "image block (multimodal pass-through)",
      content: [
        { type: "text", text: "describe this:" },
        {
          type: "image",
          source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" },
        },
      ],
    },
    {
      label: "document block (multimodal pass-through)",
      content: [
        {
          type: "document",
          source: { type: "base64", media_type: "application/pdf", data: "JVBERi0=" },
        },
        { type: "text", text: "summarize" },
      ],
    },
  ]

  for (const fx of fixtures) {
    it(`fixture: ${fx.label}`, () => {
      // Query-direct path: build SDKUserMessage and inspect message.content.
      const direct = buildQueryDirectMessages([
        { role: "user", content: fx.content },
      ])
      const fromQuery = direct[0]!.message.content

      // JSONL path: include a dummy trailing user so the fixture row is
      // written as a NON-LAST history row (sliceEnd = n - 1 ⇒ fixture is
      // index 0 and gets written; trailing user is dropped). This mirrors
      // R2's behavior where R1's user becomes a non-last history row.
      const { lines } = buildJsonlLines(
        [
          { role: "user", content: fx.content },
          { role: "assistant", content: [{ type: "text", text: "stub" }] },
          { role: "user", content: "trigger" },
        ],
        "00000000-0000-4000-8000-000000000000",
        "/fixture/cwd",
      )
      const fromJsonl = firstUserRowContent(lines)

      // Strip cache_control from both sides before comparing. R1 carries
      // none (SDK auto-anchors); R2's JSONL u1 row carries meridian's
      // history anchor. The non-cc bytes must match for prompt cache to
      // hit when meridian_cc happens to equal the SDK's getCacheControl()
      // value for the active querySource.
      expect(JSON.stringify(stripCacheControlDeep(fromQuery)))
        .toBe(JSON.stringify(stripCacheControlDeep(fromJsonl)))
    })
  }

  it("R1 query-direct content carries NO cache_control (SDK auto-anchors)", () => {
    const direct = buildQueryDirectMessages([
      { role: "user", content: "hello" },
      { role: "user", content: "world" },
    ])
    for (const m of direct) {
      for (const block of m.message.content) {
        expect(block?.cache_control).toBeUndefined()
      }
    }
  })
})

describe("normalizeUserContentForSdkPath edge cases", () => {
  it("strips then normalizes — strings remain wrapped", () => {
    const out = normalizeUserContentForSdkPath("plain")
    expect(Array.isArray(out)).toBe(true)
    expect(out[0]?.type).toBe("text")
  })

  it("non-array non-object falls back to empty array", () => {
    // Only reachable when content is genuinely malformed; the wrapper
    // ensures callers always receive an array of blocks, never a scalar.
    expect(normalizeUserContentForSdkPath(42 as any)).toEqual([])
  })

  it("empty array stays empty array", () => {
    expect(normalizeUserContentForSdkPath([])).toEqual([])
  })
})
