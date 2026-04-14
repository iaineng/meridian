/**
 * anthropic-beta header filtering for Max vs API profiles.
 *
 * All betas are stripped for claude-max profiles. API profiles pass through
 * unchanged. This module is pure — no I/O, no imports from server.ts or
 * session/.
 */

import type { ProfileType } from "./profiles"

export interface BetaFilterResult {
  /** Betas to forward upstream. `undefined` means no header should be sent. */
  forwarded: string[] | undefined
  /** Betas that were removed. Empty for api-type profiles. */
  stripped: string[]
}

/**
 * Filter an `anthropic-beta` header value for the given profile type.
 *
 * - For `api` profiles, all betas pass through unchanged.
 * - For `claude-max` profiles, all betas are stripped.
 * - Whitespace and empty entries are trimmed.
 * - Returns `forwarded: undefined` when the result would be an empty list so
 *   callers can omit the header entirely.
 */
export function filterBetasForProfile(
  rawBetaHeader: string | undefined,
  profileType: ProfileType,
): BetaFilterResult {
  if (!rawBetaHeader) {
    return { forwarded: undefined, stripped: [] }
  }

  const parsed = rawBetaHeader
    .split(",")
    .map((b) => b.trim())
    .filter(Boolean)

  if (parsed.length === 0) {
    return { forwarded: undefined, stripped: [] }
  }

  // api profiles always pass through unchanged.
  if (profileType === "api") {
    return { forwarded: parsed, stripped: [] }
  }

  // claude-max: strip all betas.
  return { forwarded: undefined, stripped: parsed }
}
