/**
 * Query-direct lone-user path: classify whether a request can bypass
 * `prepareFreshSession` and JSONL filler, sending the user message(s)
 * directly to SDK `query()` as an `AsyncIterable<SDKUserMessage>`.
 *
 * Rationale:
 *  - The current JSONL path appends a synthetic assistant filler ("No
 *    response requested.") plus a "Continue from where you left off." prompt
 *    for lone-user shapes, polluting the transcript and making the next
 *    request's rebuilt JSONL prefix ([u1, a1, ...]) byte-incompatible with
 *    what the SDK saw the first time (`[u1, "No response requested."]`) —
 *    the prompt cache misses on every R2.
 *  - This module's `buildQueryDirectMessages` produces user content blocks
 *    via the SAME primitives (`stripCacheControlDeep` + `normalizeUserContentForSdk`)
 *    that `buildJsonlLines` uses for non-last history rows. So R1's wire
 *    bytes match R2's JSONL u1 row bytes — prompt cache hits.
 *
 * Pure leaf module: zero I/O, zero state, no imports beyond pure helpers.
 */

import {
  classifyContinuation,
  normalizeUserContentForSdkPath,
} from "./transcript"

export type QueryDirectVerdict =
  | { eligible: true; reason: "lone_user" | "trailing_user_no_assistant" }
  | {
      eligible: false
      reason:
        | "ineligible_empty"
        | "ineligible_last_not_user"
        | "ineligible_trailing_tool_use"
        | "ineligible_has_assistant_tail"
        | "ineligible_assistant_in_history"
        | "ineligible_cache_breakpoint_not_last"
    }

export interface QueryDirectMessage {
  type: "user"
  message: { role: "user"; content: any[] }
  parent_tool_use_id: null
}

/**
 * True when every top-level `cache_control` breakpoint sits on the
 * trailing user message. False (i.e. an earlier message carries one) means
 * we cannot honor the breakpoint via the AsyncIterable prompt — the SDK
 * has no place to embed it — so we must fall through to the JSONL path
 * where `applyJsonlHistoryBreakpoints` preserves position.
 *
 * Mirrors `findClientUserBreakpoint`'s scan surface: only top-level blocks,
 * `tool_result.content`-nested cache_control is ignored.
 */
export function cacheBreakpointOnTrailingOnly(
  messages: ReadonlyArray<{ role: string; content: any }>,
): boolean {
  const n = messages.length
  if (n === 0) return true
  const lastIdx = n - 1
  for (let i = 0; i < n; i++) {
    const m = messages[i]
    if (!m || !Array.isArray(m.content)) continue
    if (i === lastIdx) {
      for (let j = 0; j < m.content.length - 1; j++) {
        const block = m.content[j]
        if (block && typeof block === "object" && block.cache_control) {
          return false
        }
      }
      continue
    }
    for (const block of m.content) {
      if (block && typeof block === "object" && block.cache_control) {
        return false
      }
    }
  }
  return true
}

/**
 * Decide whether the request matches the broadened lone-user shape AND
 * carries no cache_control breakpoint that would force the JSONL path.
 *
 * Eligible shapes:
 *  - `[u1]` (strict lone-user)
 *  - `[u1, u2, ...]` where every message is a user turn — no assistant
 *    anywhere in the history (the AsyncIterable prompt is user-only;
 *    buildQueryDirectMessages would otherwise flatten an interleaved
 *    assistant into role:"user" and leak its thinking/tool_use blocks).
 *
 * Ineligible cases are marked with explicit reasons for telemetry.
 */
export function classifyQueryDirect(
  messages: ReadonlyArray<{ role: string; content: any }>,
): QueryDirectVerdict {
  const n = messages.length
  if (n === 0) {
    return { eligible: false, reason: "ineligible_empty" }
  }
  const last = messages[n - 1]
  if (last?.role !== "user") {
    return { eligible: false, reason: "ineligible_last_not_user" }
  }

  const cls = classifyContinuation(messages)
  if (cls.hasTrailingToolUse) {
    return { eligible: false, reason: "ineligible_trailing_tool_use" }
  }
  // includesLastUser=false means the trailing user is anchored by an
  // assistant turn (the [u1, a1, u2] shape) — existing path already drops
  // the trailing user and avoids filler, no need to take it over here.
  if (!cls.includesLastUser) {
    return { eligible: false, reason: "ineligible_has_assistant_tail" }
  }
  // Full-history scan: classifyContinuation only inspects messages[n-2].
  // For shapes like [u1, a1, u2, u3] the trailing-user check passes (u2 is
  // user) even though a1 sits in the middle — buildQueryDirectMessages would
  // then flatten a1 to role:"user", carrying its thinking/tool_use blocks
  // into a non-assistant message. Anthropic rejects with
  // `thinking blocks may only be in 'assistant' messages`. Reject any
  // assistant in the prior history to keep query-direct strictly
  // user-only.
  for (let i = 0; i < n - 1; i++) {
    if (messages[i]?.role === "assistant") {
      return { eligible: false, reason: "ineligible_assistant_in_history" }
    }
  }

  // Multimodal blocks (image/document/file) are passed through unchanged by
  // `normalizeUserContentForSdk` — the SDK's AsyncIterable prompt accepts the
  // same Anthropic block shape natively, so query-direct is multimodal-safe
  // without the flatten-to-XML workaround that `buildPromptBundle`'s path 2
  // applies to history-bearing requests.

  if (!cacheBreakpointOnTrailingOnly(messages)) {
    return { eligible: false, reason: "ineligible_cache_breakpoint_not_last" }
  }

  return {
    eligible: true,
    reason: cls.isLoneUser ? "lone_user" : "trailing_user_no_assistant",
  }
}

/**
 * Build the SDKUserMessage records to yield through the AsyncIterable
 * prompt. Each entry's `message.content` is the SAME shape that
 * `buildJsonlLines` writes for non-last history rows (strip cache_control,
 * crEncode text, wrap strings as `[{type:"text", text}]`).
 *
 * Why no cache_control here: the SDK applies its own `cache_control` to the
 * final message of every API request via `addCacheBreakpoints` →
 * `userMessageToMessageParam(msg, addCache=true)` (cli.js
 * services/api/claude.ts:609-620). Any cache_control we set on the trailing
 * message would be unconditionally overwritten by `getCacheControl(...)`.
 * Setting it would be wasted work and would also break byte equality with
 * R2's JSONL u1 row (which is no longer the last message on R2 and so
 * keeps meridian's `applyJsonlHistoryBreakpoints` value untouched).
 *
 * Cache-hit boundary: R1 SDK auto-anchors at u_last; R2's JSONL anchors
 * `JSONL_HISTORY_CACHE_CONTROL` on u1 of the rebuilt rows. R2 hits R1's
 * cache when the SDK's `getCacheControl({querySource})` returns the same
 * `{type:"ephemeral", ttl:"1h"}` value meridian writes into the JSONL —
 * true for 1h-eligible querySources. Outside that, R2 cache hit is not
 * achievable; the filler-free transcript win still applies.
 */
export function buildQueryDirectMessages(
  messages: ReadonlyArray<{ role: string; content: any }>,
): QueryDirectMessage[] {
  return messages.map((m) => ({
    type: "user" as const,
    message: {
      role: "user" as const,
      content: normalizeUserContentForSdkPath(m.content),
    },
    parent_tool_use_id: null,
  }))
}
