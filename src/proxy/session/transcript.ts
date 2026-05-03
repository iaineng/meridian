/**
 * SDK-native JSONL session transcript construction.
 *
 * For "fresh" (diverged) sessions, instead of flattening conversation history
 * into a single XML-tagged text prompt, we:
 *   1. Generate a new session UUID
 *   2. Write history messages as structured JSONL lines to
 *      ~/.claude/projects/<sanitized-cwd>/<sessionId>.jsonl
 *   3. Let the SDK resume from that UUID with just the last user message
 *      as the prompt — the SDK reads the JSONL and rebuilds the conversation
 *      chain via parentUuid links.
 *
 * Pure logic lives in buildJsonlLines / sanitizeCwdForProjectDir; the only
 * I/O is in writeSessionTranscript and prepareFreshSession's write call.
 */
import { randomUUID, randomBytes } from "node:crypto"
import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { crEncode } from "../obfuscate"
import {
  PASSTHROUGH_MCP_PREFIX,
  toPassthroughMcpFullToolName,
} from "../passthroughToolNames"

/**
 * Version string emitted in every JSONL message row. Mirrors real Claude Code
 * transcript output so the SDK treats the file as a legitimate resume source.
 * Kept as a single exported constant to make future bumps a one-line change.
 */
export const TRANSCRIPT_VERSION = "2.1.126"

/** Base62 alphabet matching Anthropic's message id payload. */
const BASE62 = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"

/** Generate a random base62 string of the given length. */
function randomBase62(len: number): string {
  const buf = randomBytes(len)
  let out = ""
  for (let i = 0; i < len; i++) out += BASE62[buf[i]! % 62]
  return out
}

/**
 * Build an Anthropic-style message id: `msg_01` + 22 base62 chars,
 * e.g. `msg_01A1X1WuTwUtf8XFhLAPN5y3`. The SDK does not strictly validate
 * the format but matching the real shape reduces compatibility risk.
 *
 * The id is JSONL metadata only: the SDK strips it when building the
 * Anthropic API request (cli.js ≈ pos 9648156 maps assistant to
 * `{role, content}` only), so randomness here does not affect prompt cache.
 */
function buildMessageId(): string {
  return `msg_01${randomBase62(22)}`
}

export interface TranscriptOptions {
  gitBranch?: string
  model?: string
  version?: string
  /**
   * Prefix to prepend to `tool_use.name` in assistant messages. Used in
   * passthrough mode where client-visible names are unprefixed (e.g., "Read")
   * but the SDK's registered MCP tools carry a normalised MCP name
   * (e.g., "mcp__tools__read").
   * Without this, SDK resume sees tool_use names that don't match any
   * registered tool. Empty or undefined → no rewrite.
   */
  toolPrefix?: string
  /**
   * Override the generated session id. Used by the ephemeral pool to reuse
   * a previously-released UUID instead of minting a new one each request.
   */
  sessionId?: string
}

export interface BuildJsonlResult {
  lines: string[]
  /** Parallel to the input messages: uuid[i] is the UUID assigned to messages[i],
   *  or null if that message was not written (e.g. the trailing user prompt). */
  messageUuids: Array<string | null>
}

export interface FreshSessionResult {
  sessionId: string
  /** The content to send as the current prompt (last user message or "Continue from where you left off."). */
  lastUserPrompt: string | any[]
  messageUuids: Array<string | null>
  wroteTranscript: boolean
  /** True when the prompt path defers to the SDK's CLAUDE_CODE_RESUME_INTERRUPTED_TURN
   *  auto-resume — the JSONL ends on the trailing user message (no synthetic
   *  assistant filler), `lastUserPrompt` is the empty-content sentinel that
   *  `buildPromptBundle` lowers to an immediately-closing AsyncIterable so
   *  no user frame reaches claude.exe stdin, and the SDK itself replays the
   *  trailing user content as the next turn's prompt. Caller must wire
   *  `CLAUDE_CODE_RESUME_INTERRUPTED_TURN=1` into the SDK env. */
  useSdkInterruptedResume: boolean
}

/**
 * Turn an absolute CWD into the sanitized directory name used under
 * ~/.claude/projects/ by Claude Code.
 *
 * Rule (verified from real Claude Code session files): replace `:`, `/`, and `\`
 * with `-`. Other characters (dots, spaces, Unicode) pass through.
 *
 * Examples:
 *   C:\Users\iaine\Projects\meridian → C--Users-iaine-Projects-meridian
 *   /home/alice/proj                 → -home-alice-proj
 */
export function sanitizeCwdForProjectDir(cwd: string): string {
  return cwd.replace(/[\\/:]/g, "-")
}

/**
 * Absolute path to the JSONL session file for a given (cwd, sessionId).
 * Respects CLAUDE_CONFIG_DIR if set (profile overlays use it), read at call
 * time so profile switches take effect mid-run.
 */
export function getProjectSessionPath(cwd: string, sessionId: string): string {
  const baseDir = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude")
  return path.join(baseDir, "projects", sanitizeCwdForProjectDir(cwd), `${sessionId}.jsonl`)
}

export const JSONL_HISTORY_CACHE_CONTROL = { type: "ephemeral", ttl: "1h" } as const

// Runtime directive wrapper: the SDK forces us to send proxy-generated
// prompts (prefill, StructuredOutput terminators) as ordinary user turns.
// When the transcript is later fed to a summarizer or title-generator,
// those turns look indistinguishable from real user input and leak into
// the output. Wrapping each injected prompt with a <system-reminder> tag
// lets downstream readers mechanically skip them while leaving the current
// model's instruction-following unchanged.
function wrapSystemReminder(text: string): string {
  return `<system-reminder>${text}</system-reminder>`
}

// Prefill path: when the client's last message is an assistant turn, treat
// the request as a continuation of that turn. The SDK architecture forces us
// to send a new user turn as the prompt, so we instruct the model to resume
// from the exact character where its previous turn ended, suppressing any
// preamble that would corrupt the stitched output.
//
// Compliance is fragile because the model treats this as a fresh assistant
// turn, not a true API prefill. Three reinforcements raise the hit rate:
//   1. Anchor — the prefill content's text tail is inlined inside
//      <previous_tail> so the model has a concrete reference for "the next
//      character", instead of having to guess at the cut point.
//   2. Tight imperative — one positive instruction (continuation only) plus
//      one short negation (no preamble/fences); long lists of "Do not..."
//      diffuse attention.
//   3. Directive framing — the inner text leads with `Directive (this turn
//      only):` so it reads as a system-level constraint while the outer
//      <system-reminder> wrap keeps the downstream summarizer skip-pattern
//      intact.
//
// Anchorless fallback when the prefill carries only thinking/tool_use blocks
// (no recoverable text) — directive still fires, just without the anchor.

/** Maximum number of characters of the prefill tail to inline as anchor. */
const PREFILL_TAIL_MAX_CHARS = 200

/**
 * Walk a content value backwards collecting trailing text, skipping
 * thinking/tool_use blocks (which never contribute to the visible
 * output stream the model is "continuing"). Returns at most `maxChars`
 * trailing characters, or `""` when no recoverable text is found.
 */
function extractAssistantTextTail(content: any, maxChars: number): string {
  if (typeof content === "string") return content.slice(-maxChars)
  if (!Array.isArray(content)) return ""
  let buf = ""
  for (let i = content.length - 1; i >= 0; i--) {
    const block = content[i]
    if (!block || typeof block !== "object") continue
    if (block.type === "text" && typeof block.text === "string") {
      buf = block.text + buf
      if (buf.length >= maxChars) break
    }
  }
  return buf.slice(-maxChars)
}

/**
 * Construct the prefill continuation prompt for a given assistant prefill.
 * Inlines the recoverable text tail as `<previous_tail>` when available.
 *
 * Exported for tests and for callers that want to preview the prompt; the
 * production caller is `prepareFreshSession`'s prefill branch.
 */
export function buildPrefillContinuePrompt(prefillContent: any): string {
  const tail = extractAssistantTextTail(prefillContent, PREFILL_TAIL_MAX_CHARS)
  if (tail.length > 0) {
    return wrapSystemReminder(
      "Directive (this turn only): your previous assistant turn was truncated. " +
      "The exact characters you had emitted are below; this turn's response is " +
      "the immediate continuation — output only the next characters.\n" +
      "<previous_tail>\n" + tail + "\n</previous_tail>\n" +
      "Begin with the very next character. Do not repeat any byte from " +
      "<previous_tail>. No preamble, no markdown fences."
    )
  }
  return wrapSystemReminder(
    "Directive (this turn only): your previous assistant turn was truncated. " +
    "Output only the next characters of that response. Begin with the very " +
    "next character. No preamble, no markdown fences."
  )
}

export interface ClientUserBreakpoint {
  messageIndex: number
  blockIndex: number
}

/**
 * Scan messages written to the JSONL (i < sliceEnd) for the last user-message
 * top-level block carrying a `cache_control`. The client's breakpoint value is
 * not preserved — callers only borrow the position and substitute our own 1h
 * ephemeral cache_control. Nested cache_control inside `tool_result.content`
 * is ignored so the scan surface matches the top-level block index used by
 * the placement helper.
 */
export function findClientUserBreakpoint(
  messages: ReadonlyArray<{ role: string; content: any }>,
  sliceEnd: number,
): ClientUserBreakpoint | null {
  const end = Math.min(sliceEnd, messages.length)
  for (let i = end - 1; i >= 0; i--) {
    const m = messages[i]
    if (m?.role !== "user" || !Array.isArray(m.content)) continue
    for (let j = m.content.length - 1; j >= 0; j--) {
      if (m.content[j]?.cache_control) {
        return { messageIndex: i, blockIndex: j }
      }
    }
  }
  return null
}

/**
 * Recursively strip `cache_control` from content blocks. Handles strings
 * (returned unchanged), arrays (mapped), and objects (rest-spread, with
 * tool_result.content recursed into).
 *
 * Exported so leaf modules outside transcript.ts (e.g. queryDirect) can
 * apply the SAME stripping rule to user content destined for the SDK
 * AsyncIterable prompt path. Cross-path byte equality with the JSONL
 * writer depends on both sides calling this exact function.
 *
 * Distinct from `prompt.ts:stripCacheControl`, which is array-only and used
 * by the flat-text prompt path.
 */
export function stripCacheControlDeep(content: any): any {
  if (content == null) return content
  if (Array.isArray(content)) return content.map(stripCacheControlDeep)
  if (typeof content !== "object") return content
  const { cache_control, ...rest } = content
  if (rest.type === "tool_result" && Array.isArray(rest.content)) {
    return { ...rest, content: rest.content.map(stripCacheControlDeep) }
  }
  return rest
}

/**
 * Stamp meridian's 1h ephemeral `cache_control` onto a specific block in a
 * content array. Returns a new array (no in-place mutation). Out-of-range
 * indices and non-array inputs are returned unchanged so callers can pipe
 * unknown content through safely.
 *
 * Exported so the query-direct path (queryDirect.ts) can establish the same
 * prompt-cache anchor that `applyJsonlHistoryBreakpoints` plants on R2's
 * JSONL — without that, R1 query-direct never writes a cache entry and R2
 * cannot hit it.
 */
export function setCacheControlAt(content: any, blockIndex: number): any {
  if (!Array.isArray(content)) return content
  if (blockIndex < 0 || blockIndex >= content.length) return content
  return content.map((block: any, index: number) => index === blockIndex
    ? { ...block, cache_control: { ...JSONL_HISTORY_CACHE_CONTROL } }
    : block
  )
}

/**
 * Place at most one JSONL history breakpoint.
 *
 *  1. clientBreakpoint (mirrored from caller's request body) — place on the
 *     corresponding user row at the same block index, overwriting any prior
 *     cache_control with our own 1h ephemeral value.
 *  2. Fallback — put the breakpoint on the last user row's last block so
 *     every JSONL-backed call establishes a prompt-cache entry, whether the
 *     trailing JSONL row is a synthetic-continue assistant or a real one.
 */
function applyJsonlHistoryBreakpoints(
  rows: Array<Record<string, any>>,
  clientBreakpoint: ClientUserBreakpoint | null,
): void {
  if (clientBreakpoint) {
    const row = rows[clientBreakpoint.messageIndex]
    if (row?.type !== "user") return
    const content = row.message?.content
    const next = setCacheControlAt(content, clientBreakpoint.blockIndex)
    if (next === content) return
    row.message = { ...row.message, content: next }
    return
  }

  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i]
    if (row?.type !== "user") continue
    const content = row.message?.content
    if (!Array.isArray(content)) return
    const next = setCacheControlAt(content, content.length - 1)
    if (next === content) return
    row.message = { ...row.message, content: next }
    return
  }
}

/**
 * Apply crEncode to textual fields of a user-side content value while
 * normalizing to an array shape at the top level.
 *
 * Why wrap strings as [{type:"text", text}]?
 * The SDK's n6A transform (cli.js ≈ pos 11846297) wraps a user message's
 * string content into `[{type:"text", text, cache_control}]` ONLY when the
 * message is "last" in the request. When the same message later appears as
 * "non-last" history (next request), the SDK leaves the string untouched —
 * so Anthropic sees two different shapes for the same turn across requests
 * and the prompt cache hash diverges at that turn. Pre-wrapping here keeps
 * the byte representation stable regardless of position.
 *
 * - string → [{type:"text", text: crEncode(string)}]
 * - array → map each block (text → crEncode; tool_result → Claude Code MCP final shape)
 * - other → unchanged
 *
 * Exported so the query-direct path (queryDirect.ts) can produce SDK input
 * bytes identical to what buildJsonlLines writes for the same message.
 */
export function normalizeUserContentForSdk(content: any): any {
  if (content == null) return content
  if (typeof content === "string") return [{ type: "text", text: crEncode(content) }]
  if (Array.isArray(content)) return content.map(crEncodeUserBlock)
  if (typeof content !== "object") return content
  return crEncodeUserBlock(content)
}

/**
 * Convenience wrapper for the query-direct path: strip cache_control then
 * apply SDK-shape normalization, guaranteeing byte identity with the
 * corresponding user row produced by buildJsonlLines (line ~459-463).
 *
 * Always returns an array — the SDK AsyncIterable path expects user
 * `message.content` to be an array of blocks.
 */
export function normalizeUserContentForSdkPath(content: any): any[] {
  const stripped = stripCacheControlDeep(content)
  const normalized = normalizeUserContentForSdk(stripped)
  return Array.isArray(normalized) ? normalized : []
}

type NormalizedMcpToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }

type SdkToolResultContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } }

/** Per-block variant for user-side SDK input. */
function crEncodeUserBlock(block: any): any {
  if (block == null || typeof block !== "object") return block
  if (block.type === "text" && typeof block.text === "string") {
    return { ...block, text: crEncode(block.text) }
  }
  if (block.type === "tool_result") {
    return normalizeToolResultBlockForSdk(block)
  }
  // Non-standard `tool_reference` block (some clients emit it inside
  // tool_result.content to nudge the model toward a related tool). Anthropic
  // does not accept `tool_reference` as a valid tool_result inner type, so
  // collapse it to a text block. Format matches `serializeToolResultContentToText`
  // in messages.ts so the textual prompt path and the JSONL/MCP path agree.
  if (block.type === "tool_reference" && typeof block.tool_name === "string") {
    return { type: "text", text: crEncode(`tool_reference: ${block.tool_name}`) }
  }
  return block
}

function normalizeToolResultContentForMcp(content: unknown): NormalizedMcpToolContent[] {
  const out: NormalizedMcpToolContent[] = []
  if (typeof content === "string") {
    out.push({ type: "text", text: crEncode(content) })
  } else if (Array.isArray(content)) {
    for (const b of content) {
      if (!b || typeof b !== "object") continue
      const rec = b as Record<string, unknown>
      if (rec.type === "text" && typeof rec.text === "string") {
        out.push({ type: "text", text: crEncode(rec.text) })
      } else if (rec.type === "image" && rec.source && typeof rec.source === "object") {
        const src = rec.source as Record<string, unknown>
        const data = typeof src.data === "string" ? src.data : ""
        const mimeType = typeof src.media_type === "string" ? src.media_type : "image/png"
        if (data) out.push({ type: "image", data, mimeType })
      } else if (rec.type === "tool_reference" && typeof rec.tool_name === "string") {
        out.push({ type: "text", text: crEncode(`tool_reference: ${rec.tool_name}`) })
      } else if (typeof rec.text === "string") {
        out.push({ type: "text", text: crEncode(rec.text) })
      }
    }
  } else if (content == null) {
    // empty content: leave array empty
  } else {
    out.push({ type: "text", text: crEncode(String(content)) })
  }
  return out
}

function mcpContentToSdkToolResultContent(content: NormalizedMcpToolContent[]): SdkToolResultContentBlock[] {
  return content.map((block) => {
    if (block.type === "text") return block
    return {
      type: "image",
      source: {
        type: "base64",
        media_type: block.mimeType,
        data: block.data,
      },
    }
  })
}

function formatMcpToolErrorContent(content: string): string {
  if (content.length <= 10000) return content
  const halfLength = 5000
  const start = content.slice(0, halfLength)
  const end = content.slice(-halfLength)
  return `${start}\n\n... [${content.length - 10000} characters truncated] ...\n\n${end}`
}

/**
 * Normalize a client-sent Anthropic `tool_result` block to the same model-facing
 * block Claude Code emits after our blocking MCP handler resolves.
 *
 * Success path:
 *   MCP CallToolResult.content -> processMCPResult -> MCPTool.mapToolResult...
 *   => { tool_use_id, type:"tool_result", content: ContentBlockParam[] }
 *
 * Error path:
 *   MCP CallToolResult.isError -> McpToolCallError -> formatError
 *   => { type:"tool_result", content: string, is_error:true, tool_use_id }
 */
function normalizeToolResultBlockForSdk(block: any): any {
  const content = normalizeToolResultContentForMcp(block?.content)
  const toolUseId = block?.tool_use_id

  if (block?.is_error) {
    const first = content[0]
    const errorContent = first?.type === "text"
      ? formatMcpToolErrorContent(first.text)
      : "Unknown error"
    return {
      type: "tool_result",
      content: errorContent,
      is_error: true,
      tool_use_id: toolUseId,
    }
  }

  return {
    tool_use_id: toolUseId,
    type: "tool_result",
    content: mcpContentToSdkToolResultContent(content),
  }
}

/** Validate that a string is a UUID — used to accept client-supplied ids unchanged. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
function isUuid(s: unknown): s is string {
  return typeof s === "string" && UUID_RE.test(s)
}

/**
 * Prepend `prefix` to every `tool_use.name` in an assistant content array.
 * No-op when prefix is empty/undefined or content is not an array of blocks.
 * Preserves referential equality for non-tool_use blocks.
 */
function applyToolPrefixToAssistant(content: any, prefix: string | undefined): any {
  if (!prefix) return content
  if (!Array.isArray(content)) return content
  return content.map((block: any) => {
    if (block && block.type === "tool_use" && typeof block.name === "string") {
      if (prefix === PASSTHROUGH_MCP_PREFIX) {
        return { ...block, name: toPassthroughMcpFullToolName(block.name) }
      }
      if (!block.name.startsWith(prefix)) return { ...block, name: prefix + block.name }
    }
    return block
  })
}

/**
 * Build a BetaMessage-shaped assistant payload from an Anthropic content array.
 * The SDK does not validate `id` format or `model` — any opaque strings work.
 */
function wrapAssistantMessage(content: any, model: string | undefined): Record<string, unknown> {
  const id = buildMessageId()
  return {
    id,
    type: "message",
    role: "assistant",
    model: model ?? "claude-sonnet-4-5",
    content: Array.isArray(content) ? content : [{ type: "text", text: String(content ?? "") }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  }
}

/**
 * Shape decision shared by buildJsonlLines (where it drives slicing + the
 * synthetic assistant tail) and prepareFreshSession (where it drives the
 * "Continue from where you left off." prompt). Kept as a pure helper so the two sites cannot drift.
 *
 * Semantics:
 *  - lastIsUser:       trailing message is a user turn (normal request shape).
 *  - hasTrailingToolUse: the assistant adjacent to the tail has any tool_use
 *    block — if left unbalanced, SDK's z77() auto-injects a synthetic
 *    "Continue from where you left off" turn and forks the chain. Detection
 *    looks at messages[n-2] when last is user, else messages[n-1].
 *  - isLoneUser:       only one message and it's a user turn — we can't drop
 *    it (nothing to replay) and can't leave it as the last JSONL row (SDK's
 *    n6A would shape-shift it between requests, breaking prompt cache).
 *  - includesLastUser: either reason above — include the last user in the
 *    JSONL and append a synthetic assistant tail so the transcript ends on
 *    an assistant turn; caller sends "Continue from where you left off." as prompt.
 */
export function classifyContinuation(
  messages: ReadonlyArray<{ role: string; content: any }>
): { lastIsUser: boolean; hasTrailingToolUse: boolean; isLoneUser: boolean; includesLastUser: boolean } {
  const n = messages.length
  if (n === 0) return { lastIsUser: false, hasTrailingToolUse: false, isLoneUser: false, includesLastUser: false }
  const lastIsUser = messages[n - 1]?.role === "user"
  const idx = lastIsUser ? n - 2 : n - 1
  let hasTrailingToolUse = false
  if (idx >= 0) {
    const m = messages[idx]
    if (m?.role === "assistant" && Array.isArray(m.content)) {
      hasTrailingToolUse = m.content.some((b: any) => b?.type === "tool_use")
    }
  }
  const isLoneUser = n === 1 && lastIsUser
  // Treat "trailing user with no anchoring assistant before it" (lone user OR
  // consecutive users like [u1, u2]) the same way as lone-user: include the
  // trailing user in the JSONL and append a synthetic assistant tail. Without
  // this, [u1, u2] would slice off u2 as prompt, leave the JSONL ending on a
  // user row (byte-shape instability), and drop any cache_control u2 carried.
  const trailingUserLacksAssistant = lastIsUser && (idx < 0 || messages[idx]?.role !== "assistant")
  return {
    lastIsUser,
    hasTrailingToolUse,
    isLoneUser,
    includesLastUser: hasTrailingToolUse || trailingUserLacksAssistant,
  }
}

/**
 * Pure: turn an Anthropic-format message history into JSONL lines plus the
 * parallel messageUuids array.
 *
 * Behavior:
 *  - Empty or single-message input → no lines written; messageUuids matches input length with all nulls.
 *  - Normal case (last message is a user prompt): messages[0..N-2] are written,
 *    messageUuids[N-1] is null (the final user message is the prompt, not history).
 *  - Trailing assistant message: ALL N messages are written (caller synthesizes
 *    a "Continue from where you left off." prompt).
 *  - First written message has parentUuid: null; each subsequent line's parentUuid
 *    points to the previous line's uuid.
 *  - A permission-mode sentinel line is emitted as the first JSONL row to mirror
 *    real Claude Code transcripts and reduce compatibility risk.
 */
export function buildJsonlLines(
  messages: ReadonlyArray<{ role: string; content: any }>,
  sessionId: string,
  cwd: string,
  opts?: TranscriptOptions
): BuildJsonlResult {
  const n = messages.length
  const messageUuids: Array<string | null> = new Array(n).fill(null)

  if (n === 0) {
    return { lines: [], messageUuids }
  }

  const rawClass = classifyContinuation(messages)
  const includesLastUser = rawClass.includesLastUser
  const lastIsUser = rawClass.lastIsUser
  const sliceEnd = (lastIsUser && !includesLastUser) ? n - 1 : n

  if (sliceEnd === 0) {
    return { lines: [], messageUuids }
  }

  // Must capture client breakpoints from the original messages BEFORE any
  // stripCacheControlDeep runs — the per-row build below wipes cache_control as
  // part of normal cleanup.
  const clientBreakpoint = findClientUserBreakpoint(messages, sliceEnd)

  const timestamp = new Date().toISOString()
  const version = opts?.version ?? TRANSCRIPT_VERSION
  const gitBranch = opts?.gitBranch ?? ""
  const model = opts?.model
  const toolPrefix = opts?.toolPrefix

  const transcriptRows: Array<Record<string, any>> = []

  let parentUuid: string | null = null
  for (let i = 0; i < sliceEnd; i++) {
    const m = messages[i]!
    const uuid = randomUUID()
    const role = m.role === "assistant" ? "assistant" : "user"
    const cleaned = stripCacheControlDeep(m.content)

    const message = role === "assistant"
      ? wrapAssistantMessage(applyToolPrefixToAssistant(cleaned, toolPrefix), model)
      : { role: "user", content: normalizeUserContentForSdk(cleaned) }

    transcriptRows.push({
      parentUuid,
      isSidechain: false,
      type: role,
      message,
      uuid,
      timestamp,
      userType: "external",
      cwd,
      sessionId,
      version,
      gitBranch,
    })

    messageUuids[i] = uuid
    parentUuid = uuid
  }

  // When the trailing JSONL row is a user message (balanced tool_result
  // slicing, or a lone user at turn 1), the SDK-driven
  // CLAUDE_CODE_RESUME_INTERRUPTED_TURN path takes over: we leave the JSONL
  // ending on the user row and the SDK's `uL9`/`kwq` classify the trailing
  // user as `interrupted_turn` / `interrupted_prompt`, replaying the user
  // content as the next turn's prompt. The only special case left in
  // meridian is the prefill (last is assistant) path — see
  // `prepareFreshSession`.

  applyJsonlHistoryBreakpoints(transcriptRows, clientBreakpoint)

  const lines = [JSON.stringify({
    type: "permission-mode",
    permissionMode: "bypassPermissions",
    sessionId,
  }), ...transcriptRows.map(row => JSON.stringify(row))]

  // Sanity: UUID format must be valid (randomUUID() always produces valid UUIDs;
  // this guards against accidental misuse from tests)
  for (const u of messageUuids) {
    if (u !== null && !isUuid(u)) {
      throw new Error(`buildJsonlLines produced invalid UUID: ${u}`)
    }
  }

  return { lines, messageUuids }
}

/**
 * Write the JSONL lines to disk. One atomic writeFile call to avoid races
 * with SDK subprocess startup. File mode 0o600 matches SDK's own perms.
 */
export async function writeSessionTranscript(
  cwd: string,
  sessionId: string,
  lines: string[]
): Promise<void> {
  if (lines.length === 0) return
  const filePath = getProjectSessionPath(cwd, sessionId)
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  const body = lines.map(l => l + "\n").join("")
  await fs.writeFile(filePath, body, { encoding: "utf8", mode: 0o600 })
}

/**
 * Delete the JSONL transcript for a session. Silently ignores ENOENT so
 * callers can invoke it in a cleanup finally without first checking.
 */
export async function deleteSessionTranscript(
  cwd: string,
  sessionId: string
): Promise<void> {
  const filePath = getProjectSessionPath(cwd, sessionId)
  try {
    await fs.unlink(filePath)
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") throw e
  }
}

/**
 * Atomically rename the JSONL transcript to a uniquely-suffixed `.bak` so
 * every request keeps its own backup (the ephemeral UUID pool reuses ids,
 * so a fixed `<file>.bak` would be overwritten on the next request). Used
 * by the ephemeral path when MERIDIAN_EPHEMERAL_JSONL_BACKUP is enabled.
 */
export async function backupSessionTranscript(
  cwd: string,
  sessionId: string
): Promise<void> {
  const filePath = getProjectSessionPath(cwd, sessionId)
  const ts = new Date().toISOString().replace(/[:.]/g, "-")
  const rand = randomBytes(3).toString("hex")
  try {
    await fs.rename(filePath, `${filePath}.${ts}-${rand}.bak`)
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") throw e
  }
}

/**
 * High-level orchestrator. Generates a session UUID, builds JSONL lines,
 * writes them to disk (if any), and returns the prompt + auto-resume signal
 * the caller hands to the SDK.
 *
 * Three prompt-path shapes:
 *  - Prefill (last message is assistant): we own the prompt — emit the
 *    `buildPrefillContinuePrompt` directive that instructs the model to
 *    resume from the truncated assistant tail. The SDK does NOT auto-resume
 *    (its `uL9` returns `kind:"none"` when the trailing JSONL row is
 *    assistant). `useSdkInterruptedResume` is false.
 *  - Trailing user with anchoring assistant (`[u1, a1, u2]`): JSONL is
 *    sliced to `[u1, a1]` and the trailing user content is sent verbatim
 *    as the SDK prompt. `useSdkInterruptedResume` is false.
 *  - Trailing user without anchor (lone user, `[u1, u2]`, or tool_result-
 *    tail): JSONL ends on the user row (no synthetic assistant filler), the
 *    prompt is the empty-content sentinel (`buildPromptBundle` lowers it
 *    to an immediately-closing AsyncIterable so claude.exe stdin sees no
 *    user frame), and `useSdkInterruptedResume` is true so the caller
 *    wires `CLAUDE_CODE_RESUME_INTERRUPTED_TURN=1` into the SDK env. The
 *    SDK's `uL9`/`kwq` then classify the trailing user as
 *    `interrupted_turn`/`interrupted_prompt` and replay its content (and
 *    for `interrupted_turn`, an injected "Continue from where you left off."
 *    sibling) as the next turn.
 *
 * Only `messages.length === 0` short-circuits with `wroteTranscript: false`.
 */
export async function prepareFreshSession(
  messages: ReadonlyArray<{ role: string; content: any }>,
  cwd: string,
  opts?: TranscriptOptions
): Promise<FreshSessionResult> {
  const sessionId = opts?.sessionId ?? randomUUID()
  const { lines, messageUuids } = buildJsonlLines(messages, sessionId, cwd, opts)

  const n = messages.length
  const lastMsg = messages[n - 1]
  const rawClass = classifyContinuation(messages)
  const lastIsUser = rawClass.lastIsUser
  const includesLastUser = rawClass.includesLastUser

  // Apply the same crEncode used when writing history to JSONL so that
  // the u_N bytes on request N (prompt path) match u_N bytes on request N+1
  // (JSONL history). Without this, Anthropic's prompt cache breaks at every
  // new user turn — only the system/tools prefix stays stable.
  const useSdkInterruptedResume = lastIsUser && includesLastUser
  let lastUserPrompt: string | any[]
  if (useSdkInterruptedResume) {
    lastUserPrompt = ""
  } else if (lastIsUser && !includesLastUser) {
    lastUserPrompt = normalizeUserContentForSdk(stripCacheControlDeep(lastMsg!.content))
  } else if (n > 0 && !lastIsUser) {
    lastUserPrompt = buildPrefillContinuePrompt(lastMsg!.content)
  } else {
    lastUserPrompt = ""
  }

  if (lines.length === 0) {
    return { sessionId, lastUserPrompt, messageUuids, wroteTranscript: false, useSdkInterruptedResume: false }
  }

  await writeSessionTranscript(cwd, sessionId, lines)
  return { sessionId, lastUserPrompt, messageUuids, wroteTranscript: true, useSdkInterruptedResume }
}

/**
 * Convert an Anthropic-format `tool_result` block into MCP's CallToolResult
 * shape used to resolve suspended blocking-MCP tool handlers.
 *
 *  - string content → `[{type:"text", text}]`
 *  - block array    → preserve text blocks; image blocks remapped to MCP shape
 *  - `is_error`      → `isError: true`
 *
 * `crEncode` is applied to every text payload and the content normalization is
 * shared with the JSONL rebuild path. That keeps the eventual Anthropic
 * `tool_result` block shape/fields/content identical whether the result
 * reaches Claude Code through the live MCP continuation or through resumed
 * JSONL history on a later request.
 */
export function normalizeToolResultForMcp(block: {
  type?: string
  tool_use_id?: string
  content?: unknown
  is_error?: boolean
}): { content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>; isError?: boolean } {
  const content = normalizeToolResultContentForMcp(block.content)
  return block.is_error ? { content, isError: true } : { content }
}
