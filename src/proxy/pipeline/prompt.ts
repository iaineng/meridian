import { PASSTHROUGH_MCP_PREFIX } from "../passthroughToolNames"
import type { QueryDirectMessage } from "../session/queryDirect"

/**
 * Bundle of prompt artifacts for the SDK query.
 *
 * Two real shapes:
 *   - `directPromptMessages` (lone-user query-direct path) → AsyncIterable
 *     of pre-built SDKUserMessage records.
 *   - JSONL-prewarm path → exactly one trailing user message; everything
 *     else lives in the JSONL transcript the SDK resumes from.
 *
 * `<conversation_history>` text packing is no longer reachable because
 * passthrough + blocking-MCP always backs history with a JSONL transcript.
 */
export interface PromptBundle {
  toolPrefix: string
  makePrompt: () => string | AsyncIterable<any>
}

export interface BuildPromptBundleInput {
  /** Trailing user message (one entry) when going through the JSONL path. */
  messagesToConvert: Array<{ role: string; content: any }>
  /** Pre-built SDKUserMessage records from the lone-user query-direct path. */
  directPromptMessages?: QueryDirectMessage[]
}

export function buildPromptBundle(input: BuildPromptBundleInput): PromptBundle {
  const { messagesToConvert } = input
  const toolPrefix = PASSTHROUGH_MCP_PREFIX

  // Path A: query-direct lone-user. The handler has already produced
  // byte-stable SDKUserMessage records.
  if (input.directPromptMessages && input.directPromptMessages.length > 0) {
    const direct = input.directPromptMessages
    return {
      toolPrefix,
      makePrompt: () => (async function* () { for (const m of direct) yield m })(),
    }
  }

  // Path B: JSONL-backed history. messagesToConvert is exactly one user
  // message — content can be a string or an Anthropic content-block array
  // (text / image / document / file / tool_result). Pass through as-is so
  // multimodal blocks reach the SDK natively.
  const lastContent = messagesToConvert[0]?.content

  // Empty-prompt sentinel: paired with `useSdkInterruptedResume` in
  // `prepareFreshSession`. We need to hand the SDK something so the
  // bidirectional channel stays open until the run completes — but it must
  // not become a user frame for claude.exe.
  //
  // Yielding a single `{type:"keep_alive"}` satisfies both:
  //  - SDK's `streamInput` only awaits `waitForFirstResult` (and thus only
  //    keeps stdin open for control-RPC like `mcp_message`) when
  //    `X > 0 && hasBidirectionalNeeds()`. An empty iterable leaves X=0 and
  //    short-circuits the await; SDK closes claude.exe's stdin immediately,
  //    so the SDK MCP `tools/list` round-trip never gets its response and
  //    every passthrough tool is dropped from the API request.
  //  - claude.exe's `processLine` (cli.js) returns immediately on
  //    `type === "keep_alive"`, so the message is not enqueued as a prompt
  //    and does not interfere with the m3-injected auto-resume.
  //
  // Passing the literal string `""` is still wrong — the SDK's `yK`
  // serialises it as `{type:"user", content:[{type:"text", text:""}]}`,
  // which lands in claude.exe's prompt queue behind the auto-resume and
  // triggers a second turn whose empty text fails `addCacheBreakpoints`.
  if (lastContent === "") {
    return {
      toolPrefix,
      makePrompt: () => (async function* () { yield { type: "keep_alive" } })(),
    }
  }

  const content = typeof lastContent === "string"
    ? [{ type: "text", text: lastContent }]
    : (Array.isArray(lastContent)
        ? lastContent
        : [{ type: "text", text: String(lastContent ?? "") }])
  const structured = [{
    type: "user" as const,
    message: { role: "user" as const, content },
    parent_tool_use_id: null,
  }]
  return {
    toolPrefix,
    makePrompt: () => (async function* () { for (const m of structured) yield m })(),
  }
}
