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

/**
 * Version string emitted in every JSONL message row. Mirrors real Claude Code
 * transcript output so the SDK treats the file as a legitimate resume source.
 * Kept as a single exported constant to make future bumps a one-line change.
 */
export const TRANSCRIPT_VERSION = "2.1.112"

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
   * but the SDK's registered MCP tools carry a prefix (e.g., "mcp__tools__Read").
   * Without this, SDK resume sees tool_use names that don't match any
   * registered tool. Empty or undefined → no rewrite.
   */
  toolPrefix?: string
  /**
   * Override the generated session id. Used by the ephemeral pool to reuse
   * a previously-released UUID instead of minting a new one each request.
   */
  sessionId?: string
  /**
   * When true AND the synthetic "Continue." path is taken (lone-user or
   * trailing tool_use), augment the prompt with an explicit instruction
   * to call the "StructuredOutput" tool so the model terminates via the
   * structured-output tool call expected by outputFormat consumers.
   */
  outputFormat?: boolean
  /**
   * When true together with `outputFormat`, the client has also registered
   * other callable tools (custom tools or web_search). In that case we must
   * NOT force the model to call StructuredOutput immediately — it may still
   * need another tool round — so the synthetic prompt becomes conditional:
   * call StructuredOutput only when no further tool calls are required and
   * the final result is ready. Ignored when `outputFormat` is false.
   */
  hasOtherTools?: boolean
  /**
   * Blocking MCP mode: the SDK query will live across multiple HTTP rounds
   * with real Promise-blocked MCP handlers. No synthetic filler / continue
   * prompt is needed because `resume` is never used. Trailing-user histories
   * are sliced normally (last user becomes the prompt); trailing tool_use is
   * treated as a normal prefix write without the synthetic tail.
   */
  blockingMode?: boolean
}

export interface BuildJsonlResult {
  lines: string[]
  /** Parallel to the input messages: uuid[i] is the UUID assigned to messages[i],
   *  or null if that message was not written (e.g. the trailing user prompt). */
  messageUuids: Array<string | null>
}

export interface FreshSessionResult {
  sessionId: string
  /** The content to send as the current prompt (last user message or "Continue."). */
  lastUserPrompt: string | any[]
  messageUuids: Array<string | null>
  wroteTranscript: boolean
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

const JSONL_HISTORY_CACHE_CONTROL = { type: "ephemeral", ttl: "1h" } as const

// Synthetic-tail fillers: each synthetic-tail path emits a paired
// (assistant, user) turn with minimal neutral continuation text rather
// than empty placeholder tokens. The texts are constant string literals
// so the JSONL byte shape stays stable across requests (Anthropic
// prompt-cache invariant). Two pairs are defined, keyed by which
// synthetic path the request takes:
//   - tool_result: trailing assistant has unresolved tool_use; the
//     synthetic pair sits between the tool_result we just wrote and the
//     model's next reasoning turn.
//   - user_message: trailing user lacks an anchoring assistant (lone user
//     turn 1, or consecutive [u1, u2]); the pair sits between that user
//     and the model's next reply.
const TOOL_RESULT_FILLER_ASSISTANT_TEXT = "One moment."
const USER_MESSAGE_FILLER_ASSISTANT_TEXT = "One moment."

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
const PREFILL_CONTINUE_PROMPT = wrapSystemReminder("Resume output starting at the exact character after your previous assistant turn ended. Do not repeat any already-emitted characters. Do not add preamble, commentary, apology, or markdown fences. Emit only the raw continuation.")

// Synthetic-tail user prompts (the "user" half of each filler pair).
// Sent as the SDK prompt on the turn that emits a synthetic assistant
// tail. Intentionally unwrapped — short neutral continuation phrases
// that read like an ordinary user turn rather than a directive system
// injection. The DEFAULT_CONTINUE_PROMPT fallback is effectively a dead
// branch (reachable only when n === 0, which short-circuits earlier),
// but we keep it as a single source aliased to the user_message variant.
const TOOL_RESULT_CONTINUE_PROMPT = "Proceed as appropriate."
const USER_MESSAGE_CONTINUE_PROMPT = "Continue."
const DEFAULT_CONTINUE_PROMPT = USER_MESSAGE_CONTINUE_PROMPT

// StructuredOutput terminators: when the caller has registered a
// StructuredOutput tool and needs the response shaped through it, force the
// model to terminate via that tool. The strict variant applies when no other
// tool is available this turn (the only valid action is StructuredOutput);
// the conditional variant defers to the model's judgment when other tools
// are registered and a further tool round may still be needed.
const STRUCTURED_OUTPUT_STRICT_PROMPT = wrapSystemReminder("Call the StructuredOutput tool immediately. Your entire response this turn MUST be exactly one StructuredOutput tool call — no preceding text, no trailing text, no reasoning output, no other tool calls. Invoke StructuredOutput now with the final structured result.")
const STRUCTURED_OUTPUT_CONDITIONAL_PROMPT = wrapSystemReminder("If you do not need to call any other tool this turn and the final result is ready, your response MUST be exactly one StructuredOutput tool call with the final structured result and nothing else. Otherwise, continue using the other tools and do not call StructuredOutput yet.")

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

/** Recursively strip `cache_control` from content blocks. */
function stripCacheControl(content: any): any {
  if (content == null) return content
  if (Array.isArray(content)) return content.map(stripCacheControl)
  if (typeof content !== "object") return content
  const { cache_control, ...rest } = content
  if (rest.type === "tool_result" && Array.isArray(rest.content)) {
    return { ...rest, content: rest.content.map(stripCacheControl) }
  }
  return rest
}

function setCacheControlAt(content: any, blockIndex: number): any {
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
 * - array → map each block (text → crEncode; tool_result → recurse into .content)
 * - other → unchanged
 */
function crEncodeUserContent(content: any): any {
  if (content == null) return content
  if (typeof content === "string") return [{ type: "text", text: crEncode(content) }]
  if (Array.isArray(content)) return content.map(crEncodeUserBlock)
  if (typeof content !== "object") return content
  return crEncodeUserBlock(content)
}

/** Per-block variant: never wraps a string into an array (used for
 *  `tool_result.content` which must stay a string-or-block-list per Anthropic). */
function crEncodeUserBlock(block: any): any {
  if (block == null || typeof block !== "object") return block
  if (block.type === "text" && typeof block.text === "string") {
    return { ...block, text: crEncode(block.text) }
  }
  if (block.type === "tool_result") {
    return { ...block, content: crEncodeToolResultContent(block.content) }
  }
  return block
}

/** tool_result.content: string stays string (crEncoded); array → map blocks. */
function crEncodeToolResultContent(content: any): any {
  if (content == null) return content
  if (typeof content === "string") return crEncode(content)
  if (Array.isArray(content)) return content.map(crEncodeUserBlock)
  return content
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
    if (block && block.type === "tool_use" && typeof block.name === "string" && !block.name.startsWith(prefix)) {
      return { ...block, name: prefix + block.name }
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
 * "Continue." prompt). Kept as a pure helper so the two sites cannot drift.
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
 *    an assistant turn; caller sends "Continue." as prompt.
 */
function classifyContinuation(
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
 *    a "Continue." prompt).
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
  // Blocking mode never needs the synthetic tail: the SDK query lives across
  // turns, so there is no resume-time byte-shape stability concern. Slice
  // trailing-user histories normally (last user becomes the prompt).
  const includesLastUser = opts?.blockingMode ? false : rawClass.includesLastUser
  const lastIsUser = rawClass.lastIsUser
  const hasTrailingToolUse = rawClass.hasTrailingToolUse
  const sliceEnd = (lastIsUser && !includesLastUser) ? n - 1 : n

  if (sliceEnd === 0) {
    return { lines: [], messageUuids }
  }

  // Must capture client breakpoints from the original messages BEFORE any
  // stripCacheControl runs — the per-row build below wipes cache_control as
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
    const cleaned = stripCacheControl(m.content)

    const message = role === "assistant"
      ? wrapAssistantMessage(applyToolPrefixToAssistant(cleaned, toolPrefix), model)
      : { role: "user", content: crEncodeUserContent(cleaned) }

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
  // slicing, or a lone user at turn 1), append a synthetic assistant text
  // message so the transcript always ends on assistant. This guarantees:
  //   1. SDK's n6A never sees a "last" user row in the JSONL (stable byte
  //      shape across requests — the same user is always "non-last" next
  //      time).
  //   2. The caller's "Continue." prompt is a clean new turn on top of a
  //      well-formed user→assistant chain.
  //   3. applyJsonlHistoryBreakpoints can place the cache breakpoint on the
  //      preceding user row, enabling first-call cache establishment.
  if (lastIsUser && includesLastUser) {
    const uuid = randomUUID()
    const syntheticText = hasTrailingToolUse
      ? TOOL_RESULT_FILLER_ASSISTANT_TEXT
      : USER_MESSAGE_FILLER_ASSISTANT_TEXT
    const syntheticAssistant = wrapAssistantMessage(
      [{ type: "text", text: syntheticText }],
      model
    )
    transcriptRows.push({
      parentUuid,
      isSidechain: false,
      type: "assistant",
      message: syntheticAssistant,
      uuid,
      timestamp,
      userType: "external",
      cwd,
      sessionId,
      version,
      gitBranch,
    })
    // Not tracked in messageUuids — it does not correspond to an input message.
  }

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
 * writes them to disk (if any), and returns everything the caller needs.
 *
 * When at least one input message is present the transcript is always
 * written:
 *  - Lone user (n === 1): permission-mode + user + synthetic assistant tail,
 *    so the first call still establishes a JSONL-backed resume chain and
 *    the user row can carry the cache breakpoint.
 *  - Normal histories (n >= 2): standard slice (dropping the trailing user
 *    when it's the prompt, or appending a synthetic tail when the trailing
 *    assistant has an unresolved tool_use).
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
  // Shared classifier — identical decision surface as buildJsonlLines so the
  // prompt (here) and the JSONL tail (there) can never drift out of sync.
  const rawClass = classifyContinuation(messages)
  const lastIsUser = rawClass.lastIsUser
  const hasTrailingToolUse = rawClass.hasTrailingToolUse
  // Blocking mode: skip synthetic tail injection for the same reason as
  // buildJsonlLines. The last user content becomes the real prompt.
  const includesLastUser = opts?.blockingMode ? false : rawClass.includesLastUser

  // Apply the SAME crEncode we use when writing history to JSONL so that
  // the u_N bytes on request N (prompt path) match u_N bytes on request N+1
  // (JSONL history). Without this, Anthropic's prompt cache breaks at every
  // new user turn — only system/tools prefix stays stable.
  //
  // When outputFormat is enabled AND we are on the synthetic path, the
  // caller is waiting for a StructuredOutput tool call — so replace the
  // neutral continuation prompt with an explicit directive that forces the
  // model to terminate via StructuredOutput rather than plain text.
  //
  // If other tools (custom tools or web_search) are also registered, the
  // model may still need another tool round, so soften the directive:
  // only call StructuredOutput when no further tool calls are needed and
  // the final result is ready.
  let continuePrompt: string
  if (n > 0 && !lastIsUser) {
    continuePrompt = PREFILL_CONTINUE_PROMPT
  } else if (opts?.outputFormat) {
    continuePrompt = opts.hasOtherTools
      ? STRUCTURED_OUTPUT_CONDITIONAL_PROMPT
      : STRUCTURED_OUTPUT_STRICT_PROMPT
  } else if (hasTrailingToolUse) {
    continuePrompt = TOOL_RESULT_CONTINUE_PROMPT
  } else if (lastIsUser && includesLastUser) {
    continuePrompt = USER_MESSAGE_CONTINUE_PROMPT
  } else {
    continuePrompt = DEFAULT_CONTINUE_PROMPT
  }
  const lastUserPrompt: string | any[] = (lastIsUser && !includesLastUser)
    ? crEncodeUserContent(stripCacheControl(lastMsg!.content))
    : continuePrompt

  if (lines.length === 0) {
    return { sessionId, lastUserPrompt, messageUuids, wroteTranscript: false }
  }

  await writeSessionTranscript(cwd, sessionId, lines)
  return { sessionId, lastUserPrompt, messageUuids, wroteTranscript: true }
}

/**
 * Convert an Anthropic-format `tool_result` block into MCP's CallToolResult
 * shape used to resolve suspended blocking-MCP tool handlers.
 *
 *  - string content → `[{type:"text", text}]`
 *  - block array    → preserve text blocks; image blocks remapped to MCP shape
 *  - `is_error`      → `isError: true`
 */
export function normalizeToolResultForMcp(block: {
  type?: string
  tool_use_id?: string
  content?: unknown
  is_error?: boolean
}): { content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>; isError?: boolean } {
  const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = []
  const raw = block.content
  if (typeof raw === "string") {
    content.push({ type: "text", text: raw })
  } else if (Array.isArray(raw)) {
    for (const b of raw) {
      if (!b || typeof b !== "object") continue
      const rec = b as Record<string, unknown>
      if (rec.type === "text" && typeof rec.text === "string") {
        content.push({ type: "text", text: rec.text })
      } else if (rec.type === "image" && rec.source && typeof rec.source === "object") {
        const src = rec.source as Record<string, unknown>
        const data = typeof src.data === "string" ? src.data : ""
        const mimeType = typeof src.media_type === "string" ? src.media_type : "image/png"
        if (data) content.push({ type: "image", data, mimeType })
      } else if (typeof rec.text === "string") {
        content.push({ type: "text", text: rec.text })
      }
    }
  } else if (raw == null) {
    // empty content — leave array empty
  } else {
    content.push({ type: "text", text: String(raw) })
  }
  return block.is_error ? { content, isError: true } : { content }
}
