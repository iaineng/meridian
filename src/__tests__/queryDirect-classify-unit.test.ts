/**
 * Pure unit tests for `classifyQueryDirect` and `cacheBreakpointOnTrailingOnly`.
 * Covers every eligible/ineligible branch with explicit reason codes.
 */

import { describe, it, expect } from "bun:test"
import {
  classifyQueryDirect,
  cacheBreakpointOnTrailingOnly,
} from "../proxy/session/queryDirect"

const u = (text: string, extra: Record<string, any> = {}) => ({
  role: "user",
  content: [{ type: "text", text, ...extra }],
})
const uString = (text: string) => ({ role: "user", content: text })
const aText = (text: string) => ({
  role: "assistant",
  content: [{ type: "text", text }],
})
const aToolUse = (id: string, name: string) => ({
  role: "assistant",
  content: [{ type: "tool_use", id, name, input: {} }],
})
const uToolResult = (id: string, content: any = "ok") => ({
  role: "user",
  content: [{ type: "tool_result", tool_use_id: id, content }],
})

describe("classifyQueryDirect", () => {
  it("[u1] string → eligible / lone_user", () => {
    const v = classifyQueryDirect([uString("hello")])
    expect(v).toEqual({ eligible: true, reason: "lone_user" })
  })

  it("[u1] block → eligible / lone_user", () => {
    const v = classifyQueryDirect([u("hello")])
    expect(v).toEqual({ eligible: true, reason: "lone_user" })
  })

  it("[u1, u2] → eligible / trailing_user_no_assistant", () => {
    const v = classifyQueryDirect([u("a"), u("b")])
    expect(v).toEqual({ eligible: true, reason: "trailing_user_no_assistant" })
  })

  it("[u1, a1, u2] → ineligible / has_assistant_tail", () => {
    const v = classifyQueryDirect([u("a"), aText("ok"), u("b")])
    expect(v).toEqual({
      eligible: false,
      reason: "ineligible_has_assistant_tail",
    })
  })

  it("[u1, a1(tool_use), tool_result] → ineligible / trailing_tool_use", () => {
    const v = classifyQueryDirect([
      u("a"),
      aToolUse("t1", "Read"),
      uToolResult("t1"),
    ])
    expect(v).toEqual({ eligible: false, reason: "ineligible_trailing_tool_use" })
  })

  it("[u1, a1] (last is assistant, prefill) → ineligible / last_not_user", () => {
    const v = classifyQueryDirect([u("a"), aText("partial")])
    expect(v).toEqual({ eligible: false, reason: "ineligible_last_not_user" })
  })

  it("[] → ineligible / empty", () => {
    const v = classifyQueryDirect([])
    expect(v).toEqual({ eligible: false, reason: "ineligible_empty" })
  })

  it("[u1{cc on block 0}, u2] → ineligible / cache_breakpoint_not_last", () => {
    const msgs = [
      u("a", { cache_control: { type: "ephemeral" } }),
      u("b"),
    ]
    const v = classifyQueryDirect(msgs)
    expect(v).toEqual({
      eligible: false,
      reason: "ineligible_cache_breakpoint_not_last",
    })
  })

  it("[u1, u2{cc on last block}] → eligible (breakpoint on trailing is fine)", () => {
    const msgs = [u("a"), u("b", { cache_control: { type: "ephemeral" } })]
    const v = classifyQueryDirect(msgs)
    expect(v).toEqual({ eligible: true, reason: "trailing_user_no_assistant" })
  })

  it("[u1{cc on last/only block}] (lone with cc) → eligible", () => {
    const v = classifyQueryDirect([
      u("only", { cache_control: { type: "ephemeral" } }),
    ])
    expect(v).toEqual({ eligible: true, reason: "lone_user" })
  })

  it("lone-user with image block → eligible (multimodal pass-through)", () => {
    const v = classifyQueryDirect([
      {
        role: "user",
        content: [
          { type: "text", text: "look" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "x" } },
        ],
      },
    ])
    expect(v).toEqual({ eligible: true, reason: "lone_user" })
  })

  it("lone-user with document block → eligible (multimodal pass-through)", () => {
    const v = classifyQueryDirect([
      {
        role: "user",
        content: [
          { type: "document", source: { type: "base64", media_type: "application/pdf", data: "y" } },
          { type: "text", text: "summarize" },
        ],
      },
    ])
    expect(v).toEqual({ eligible: true, reason: "lone_user" })
  })

  it("[u1, u2, u3] (three consecutive users) → eligible / trailing_user_no_assistant", () => {
    const v = classifyQueryDirect([u("a"), u("b"), u("c")])
    expect(v).toEqual({ eligible: true, reason: "trailing_user_no_assistant" })
  })

  it("tool_result.content.cache_control nested is NOT a top-level breakpoint", () => {
    // The trailing user is u_last; an earlier user has a tool_result whose
    // INNER content carries cache_control. findClientUserBreakpoint ignores
    // such nested values, so cacheBreakpointOnTrailingOnly must too.
    // This shape (tool_result on u_prev) makes the request a continuation
    // shape if the assistant before it had tool_use — but here we put a
    // plain assistant, so it's `[u(tr), a, u]` which is the
    // has_assistant_tail path, not the gate we are testing.
    // Use a simpler shape: [u_with_tr_inner_cc, u_last]
    const msgs = [
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "t1",
            content: [
              { type: "text", text: "x", cache_control: { type: "ephemeral" } },
            ],
          },
        ],
      },
      u("trailing"),
    ]
    // Above shape would not happen organically (tool_result without preceding
    // tool_use), but classifyQueryDirect's cache_control gate must still
    // ignore the nested value. The earlier user has no top-level cc, so this
    // passes the breakpoint gate; the only remaining gate is shape — both
    // are users, so trailing_user_no_assistant.
    const v = classifyQueryDirect(msgs)
    expect(v).toEqual({ eligible: true, reason: "trailing_user_no_assistant" })
  })
})

describe("cacheBreakpointOnTrailingOnly", () => {
  it("empty → true", () => {
    expect(cacheBreakpointOnTrailingOnly([])).toBe(true)
  })

  it("single user with cc → true", () => {
    expect(
      cacheBreakpointOnTrailingOnly([
        u("x", { cache_control: { type: "ephemeral" } }),
      ]),
    ).toBe(true)
  })

  it("cc on non-last user → false", () => {
    expect(
      cacheBreakpointOnTrailingOnly([
        u("x", { cache_control: { type: "ephemeral" } }),
        u("y"),
      ]),
    ).toBe(false)
  })

  it("cc on last user only → true", () => {
    expect(
      cacheBreakpointOnTrailingOnly([
        u("x"),
        u("y", { cache_control: { type: "ephemeral" } }),
      ]),
    ).toBe(true)
  })

  it("cc on assistant in middle → false", () => {
    expect(
      cacheBreakpointOnTrailingOnly([
        u("x"),
        {
          role: "assistant",
          content: [
            { type: "text", text: "ok", cache_control: { type: "ephemeral" } },
          ],
        },
        u("y"),
      ]),
    ).toBe(false)
  })

  it("string content (no array) is treated as no breakpoints", () => {
    expect(
      cacheBreakpointOnTrailingOnly([uString("x"), uString("y")]),
    ).toBe(true)
  })
})
