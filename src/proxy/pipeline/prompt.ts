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
  // `prepareFreshSession`. Hand the SDK an immediately-closing AsyncIterable
  // so `streamInput` ends the SDK→claude.exe stdin without writing any
  // user-message frame. Passing the literal string `""` doesn't work — the
  // SDK's `yK` still serialises a `{type:"user", content:[{type:"text",
  // text:""}]}` frame, which lands behind the m3-injected auto-resume in
  // claude.exe's prompt queue and triggers a second turn whose empty text
  // block fails the SDK's `addCacheBreakpoints` (cc-on-empty-text). With an
  // empty iterable, only the m3-injected interrupted-turn prompt drives the
  // agent.
  if (lastContent === "") {
    return { toolPrefix, makePrompt: () => (async function* () {})() }
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
