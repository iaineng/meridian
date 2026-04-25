/**
 * Session lineage verification.
 *
 * Pure functions for hashing messages and classifying mutations
 * (continuation, compaction, undo, diverged).
 */

import { xxh64 as xxh64BigInt } from "@node-rs/xxhash"
import { normalizeContent } from "../messages"
import { diagnosticLog } from "../../telemetry"

/** 64-bit xxHash → 16-char hex string. */
function xxh64(data: string): string {
  return xxh64BigInt(data).toString(16).padStart(16, "0")
}

// --- Types ---

/** Token usage counters from the SDK (subset of Anthropic usage object). */
export interface TokenUsage {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

/** Minimum suffix overlap (stored messages found at the end of incoming)
 *  required to classify a mutation as compaction rather than a branch. */
export const MIN_SUFFIX_FOR_COMPACTION = 2

export interface SessionState {
  claudeSessionId: string
  lastAccess: number
  messageCount: number
  /** Hash of messages[0..messageCount-1] for fast-path lineage verification.
   *  When the full prefix matches, the conversation is a strict continuation
   *  and we skip the per-message diff entirely. */
  lineageHash: string
  /** Per-message content hashes from the last stored request.
   *  Used for precise diff-based mutation classification when the aggregate
   *  lineageHash mismatches. */
  messageHashes?: string[]
  /** SDK assistant message UUIDs indexed by message position.
   *  Only assistant messages have UUIDs (user messages are null).
   *  Used to find the rollback point for undo. */
  sdkMessageUuids?: Array<string | null>
  /** Last observed token usage for this session (from SDK message_start / message_delta events) */
  contextUsage?: TokenUsage
}

/**
 * Result of lineage verification — classifies the mutation and provides
 * the information needed to take the correct SDK action.
 *
 * `ephemeral` is synthesised by the ephemeral one-shot handler; it is never
 * produced by `verifyLineage` / `lookupSession` and carries no session state.
 */
export type LineageResult =
  | { type: "continuation"; session: SessionState }
  | { type: "compaction";   session: SessionState }
  | { type: "undo";         session: SessionState; prefixOverlap: number; rollbackUuid: string | undefined }
  | { type: "diverged" }
  | { type: "ephemeral" }

// --- Hashing ---

/**
 * Compute a lineage hash of an ordered message array.
 * Used as a fast-path check: if the aggregate hash matches, the messages
 * are an exact prefix-extension and we skip the per-message diff.
 */
export function computeLineageHash(messages: Array<{ role: string; content: any }>): string {
  if (!messages || messages.length === 0) return ""
  const parts = messages.map(m => `${m.role}:${normalizeContent(m.content)}`)
  return xxh64(parts.join("\n"))
}

/**
 * Compute a content hash for a single message (role + normalised content).
 * Used to build per-message hash arrays for precise diff-based verification.
 */
export function hashMessage(message: { role: string; content: any }): string {
  return xxh64(`${message.role}:${normalizeContent(message.content)}`)
}

/**
 * Compute per-message hashes for an entire message array.
 */
export function computeMessageHashes(messages: Array<{ role: string; content: any }>): string[] {
  if (!messages || messages.length === 0) return []
  return messages.map(hashMessage)
}

// --- Overlap measurement ---

/**
 * Measure how many stored hashes match from the START of the stored array
 * against the incoming hashes (positional comparison).
 *
 * Prefix overlap means the beginning of the conversation is intact (undo
 * changes the end but preserves the beginning).
 *
 * NOTE: Compares stored[i] === incoming[i] positionally. An earlier
 * implementation used a Set for O(1) lookups, but that allowed a stored
 * hash at position i to match an incoming hash at a completely different
 * position, inflating the overlap count when duplicate messages exist
 * in the conversation history.
 */
export function measurePrefixOverlap(storedHashes: string[], incomingHashes: string[]): number {
  let overlap = 0
  const minLen = Math.min(storedHashes.length, incomingHashes.length)
  for (let i = 0; i < minLen; i++) {
    if (storedHashes[i] === incomingHashes[i]) overlap++
    else break
  }
  return overlap
}

/**
 * Compact form of an assistant content block, mirrored from
 * `BlockingSessionState.lastEmittedAssistantBlocks`. Defined here (rather
 * than imported from the pool) because lineage.ts is the pure-helper
 * module — keeping the type local avoids a downward dep into pool state.
 */
export type EmittedAssistantBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; name: string; input: unknown }

/**
 * Canonical-JSON encode: deeply sort object keys before serialising. Used
 * to compare tool_use `input` objects independent of key insertion order.
 * Arrays preserve order; primitives pass through.
 */
function canonicalJson(v: unknown): string {
  return JSON.stringify(canonicalizeValue(v))
}

function canonicalizeValue(v: unknown): unknown {
  if (v === null || typeof v !== "object") return v
  if (Array.isArray(v)) return v.map(canonicalizeValue)
  const sorted: Record<string, unknown> = {}
  for (const k of Object.keys(v as Record<string, unknown>).sort()) {
    sorted[k] = canonicalizeValue((v as Record<string, unknown>)[k])
  }
  return sorted
}

/**
 * Verify that the client's reported assistant turn matches what the SDK
 * actually emitted. Only `text` and `tool_use` blocks are compared
 * (thinking blocks are filtered out of the client's content first — they
 * carry signatures the model returns but we don't track them in the
 * server-side snapshot). For each remaining block:
 *
 *   - block kind must match positionally
 *   - text blocks: exact string equality
 *   - tool_use blocks: name equality AND canonical-JSON input equality
 *     (key order does not matter; arrays preserve order)
 *
 * `tool_use_id` is INTENTIONALLY ignored — many clients rewrite IDs
 * between rounds. Routing is positional via `state.currentRoundToolIds`.
 *
 * Returns a discriminated result so callers can log the precise mismatch
 * reason. A drift detection should release the live sibling and promote
 * the request to a fresh blocking initial (the client has effectively
 * forked from a point the server cannot reconstruct).
 */
export function verifyEmittedAssistant(
  emitted: ReadonlyArray<EmittedAssistantBlock>,
  clientAssistantContent: unknown,
): { match: true } | { match: false; reason: string } {
  // Anthropic's API permits assistant message content to be either a
  // string or a block array. Normalise the string form to a single text
  // block so the rest of the comparison is uniform.
  let clientBlocks: Array<{ type: string; [k: string]: unknown }>
  if (typeof clientAssistantContent === "string") {
    clientBlocks = [{ type: "text", text: clientAssistantContent }]
  } else if (Array.isArray(clientAssistantContent)) {
    clientBlocks = clientAssistantContent.filter(
      (b: any) => b && typeof b === "object" && (b.type === "text" || b.type === "tool_use"),
    )
  } else {
    return { match: false, reason: "client assistant content is neither string nor array" }
  }

  if (clientBlocks.length !== emitted.length) {
    return {
      match: false,
      reason: `block count differs: emitted=${emitted.length}, client=${clientBlocks.length}`,
    }
  }

  for (let i = 0; i < emitted.length; i++) {
    const e = emitted[i]!
    const c = clientBlocks[i]!
    if (c.type !== e.type) {
      return {
        match: false,
        reason: `block[${i}] type differs: emitted=${e.type}, client=${c.type}`,
      }
    }
    if (e.type === "text") {
      const cText = typeof c.text === "string" ? c.text : ""
      if (e.text !== cText) {
        return { match: false, reason: `block[${i}] text content differs` }
      }
    } else {
      const cName = typeof c.name === "string" ? c.name : ""
      if (e.name !== cName) {
        return {
          match: false,
          reason: `block[${i}] tool_use name differs: emitted=${e.name}, client=${cName}`,
        }
      }
      if (canonicalJson(e.input) !== canonicalJson(c.input)) {
        return { match: false, reason: `block[${i}] tool_use input differs` }
      }
    }
  }

  return { match: true }
}

/**
 * Measure how many consecutive messages at the END of the stored array
 * appear as a contiguous run in the incoming array.
 *
 * Suffix overlap means the recent conversation is intact (compaction
 * changes the beginning but preserves the end).
 *
 * Algorithm: find the last stored hash in the incoming array, then walk
 * backward through both arrays verifying contiguous matches. This handles
 * the real-world compaction pattern where new messages are appended AFTER
 * the preserved suffix.
 *
 * NOTE: An earlier implementation used a Set for O(1) lookups, but that
 * allowed a stored suffix hash to match an incoming hash at a completely
 * different position — producing false compaction when duplicate messages
 * exist in the conversation. The current approach verifies positional
 * contiguity.
 */
export function measureSuffixOverlap(storedHashes: string[], incomingHashes: string[]): number {
  if (storedHashes.length === 0 || incomingHashes.length === 0) return 0

  // Find where the last stored hash appears in the incoming array.
  // Search from the end of incoming to prefer the latest match.
  const lastStoredHash = storedHashes[storedHashes.length - 1]!
  let anchorInIncoming = -1
  for (let i = incomingHashes.length - 1; i >= 0; i--) {
    if (incomingHashes[i] === lastStoredHash) {
      anchorInIncoming = i
      break
    }
  }
  if (anchorInIncoming < 0) return 0

  // Walk backward from the anchor, verifying contiguous matches.
  let overlap = 0
  let si = storedHashes.length - 1
  let ii = anchorInIncoming
  while (si >= 0 && ii >= 0) {
    if (storedHashes[si] === incomingHashes[ii]) {
      overlap++
      si--
      ii--
    } else {
      break
    }
  }
  return overlap
}

/**
 * Find the start index in the incoming array where the stored suffix
 * contiguous run begins.  Returns -1 if the suffix overlap is 0.
 */
function findSuffixAnchorStart(
  storedHashes: string[],
  incomingHashes: string[],
  suffixOverlap: number
): number {
  if (suffixOverlap <= 0) return -1
  // The anchor (last stored hash) position in incoming:
  const lastStoredHash = storedHashes[storedHashes.length - 1]!
  let anchor = -1
  for (let i = incomingHashes.length - 1; i >= 0; i--) {
    if (incomingHashes[i] === lastStoredHash) { anchor = i; break }
  }
  if (anchor < 0) return -1
  // The suffix run starts at (anchor - suffixOverlap + 1)
  return anchor - suffixOverlap + 1
}

// --- Lineage verification ---

/** Cache-like interface for verifyLineage — only needs get/set/delete */
export interface SessionCacheLike {
  delete(key: string): boolean
}

/**
 * Verify that incoming messages are a valid continuation of a cached session.
 * Uses per-message hash comparison to deterministically classify mutations.
 *
 * Decision matrix:
 *   Full prefix match (fast-path)          → continuation (resume normally)
 *   Suffix overlap >= MIN_SUFFIX           → compaction   (resume normally)
 *   Prefix overlap > 0, no suffix          → undo         (fork at rollback point)
 *   No overlap                             → diverged     (start fresh)
 */
export function verifyLineage(
  cached: SessionState,
  messages: Array<{ role: string; content: any }>,
  cacheKey: string,
  cache: SessionCacheLike
): LineageResult {
  // No stored lineage (legacy entry or first request) — allow resume,
  // unless the conversation shrank (fewer messages than cached), which
  // indicates an undo or new conversation we can't verify without hashes.
  if (!cached.lineageHash || cached.messageCount === 0) {
    if (cached.messageCount > 0 && messages.length < cached.messageCount) {
      const msg = `Legacy session without lineage data has fewer messages (${messages.length} < ${cached.messageCount}). Treating as diverged.`
      console.error(`[PROXY] ${msg}`)
      diagnosticLog.lineage(msg)
      cache.delete(cacheKey)
      return { type: "diverged" }
    }
    return { type: "continuation", session: cached }
  }

  // --- Fast path: aggregate lineage hash ---
  const prefix = messages.slice(0, cached.messageCount)
  const prefixHash = computeLineageHash(prefix)
  if (prefixHash === cached.lineageHash) {
    // Same or fewer messages with matching hash = replay/retry, not continuation.
    // Without this guard, identical requests resume the old SDK session and
    // re-send the last user message, causing ghost context accumulation.
    if (messages.length <= cached.messageCount) {
      cache.delete(cacheKey)
      return { type: "diverged" }
    }
    return { type: "continuation", session: cached }
  }

  // --- Slow path: per-message diff ---
  if (!cached.messageHashes || cached.messageHashes.length === 0) {
    // No per-message hashes stored (legacy session). Can't diff — reject.
    cache.delete(cacheKey)
    return { type: "diverged" }
  }

  const incomingHashes = computeMessageHashes(messages)

  const prefixOverlap = measurePrefixOverlap(cached.messageHashes, incomingHashes)
  const suffixOverlap = measureSuffixOverlap(cached.messageHashes, incomingHashes)

  // Compaction: suffix preserved, long enough conversation.
  // The suffix must not start at the very beginning of incoming — a valid
  // compaction always has at least one replaced/summarized message before
  // the preserved suffix.  Without this guard, a conversation that simply
  // reuses the stored tail messages at position 0 (e.g. after an undo +
  // retype) would be falsely classified as compaction (#283).
  const MIN_STORED_FOR_COMPACTION = 6
  const suffixStartInIncoming = incomingHashes.length - suffixOverlap >= 0
    ? findSuffixAnchorStart(cached.messageHashes, incomingHashes, suffixOverlap)
    : -1
  if (
    suffixOverlap >= MIN_SUFFIX_FOR_COMPACTION &&
    cached.messageHashes.length >= MIN_STORED_FOR_COMPACTION &&
    suffixStartInIncoming > 0   // at least one changed message before the preserved suffix
  ) {
    const compactionMsg = `Compaction detected (key=${cacheKey.slice(0, 8)}…): suffix overlap ${suffixOverlap}/${cached.messageHashes.length}. Allowing resume.`
    console.error(`[PROXY] ${compactionMsg}`)
    diagnosticLog.lineage(compactionMsg)
    cached.lineageHash = computeLineageHash(messages)
    cached.messageHashes = incomingHashes
    cached.messageCount = messages.length
    return { type: "compaction", session: cached }
  }

  // Undo: prefix preserved (beginning intact) but suffix changed,
  // AND the conversation shrank (fewer messages). If the conversation grew
  // (messages.length > cached.messageCount), the client added new messages
  // after modifying a previous one — that's a continuation, not an undo.
  if (prefixOverlap > 0 && suffixOverlap === 0 && messages.length <= cached.messageCount) {
    // Find the SDK UUID at the last matching position.
    let rollbackUuid: string | undefined
    if (cached.sdkMessageUuids) {
      for (let i = prefixOverlap - 1; i >= 0; i--) {
        if (cached.sdkMessageUuids[i]) {
          rollbackUuid = cached.sdkMessageUuids[i]!
          break
        }
      }
    }
    // Without a rollback UUID, forkSession:true resumes from the end of the
    // conversation — the model sees the full history, defeating the undo.
    // Degrade to diverged so the proxy starts a fresh session instead.
    if (!rollbackUuid) {
      const degradeMsg = `Undo without rollback UUID (key=${cacheKey.slice(0, 8)}…): prefix overlap ${prefixOverlap}/${cached.messageHashes.length}. Degrading to diverged.`
      console.error(`[PROXY] ${degradeMsg}`)
      diagnosticLog.lineage(degradeMsg)
      cache.delete(cacheKey)
      return { type: "diverged" }
    }
    const undoMsg = `Undo detected (key=${cacheKey.slice(0, 8)}…): prefix overlap ${prefixOverlap}/${cached.messageHashes.length}, rollback UUID: ${rollbackUuid}.`
    console.error(`[PROXY] ${undoMsg}`)
    diagnosticLog.lineage(undoMsg)
    return { type: "undo", session: cached, prefixOverlap, rollbackUuid }
  }

  // Modified continuation: most prefix matches but a message was modified
  // (e.g., cache_control added) and new messages were appended. Treat as
  // continuation — update stored hashes and resume normally.
  if (prefixOverlap > 0 && messages.length > cached.messageCount) {
    const modifiedMsg = `Modified continuation (key=${cacheKey.slice(0, 8)}…): prefix overlap ${prefixOverlap}/${cached.messageHashes.length}, incoming ${messages.length} msgs. Allowing resume.`
    console.error(`[PROXY] ${modifiedMsg}`)
    diagnosticLog.lineage(modifiedMsg)
    cached.lineageHash = computeLineageHash(messages.slice(0, messages.length))
    cached.messageHashes = incomingHashes
    cached.messageCount = messages.length
    return { type: "continuation", session: cached }
  }

  // No meaningful overlap — completely different conversation.
  cache.delete(cacheKey)
  return { type: "diverged" }
}
