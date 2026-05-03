/**
 * Error classification for SDK errors.
 * Maps raw error messages to structured HTTP error responses.
 */

export interface ClassifiedError {
  status: number
  type: string
  message: string
}

/**
 * Detect specific SDK errors and return helpful messages to the client.
 */
export function classifyError(errMsg: string): ClassifiedError {
  const lower = errMsg.toLowerCase()

  // Expired OAuth token (more specific than the generic auth check below)
  if (lower.includes("oauth token has expired") || lower.includes("not logged in")) {
    return {
      status: 401,
      type: "authentication_error",
      message: "Claude OAuth token has expired or is missing. Run 'claude login' in your terminal to re-authenticate."
    }
  }

  // Authentication failures
  if (lower.includes("401") || lower.includes("authentication") || lower.includes("invalid auth") || lower.includes("credentials")) {
    return {
      status: 401,
      type: "authentication_error",
      message: "Claude authentication expired or invalid. Run 'claude login' in your terminal to re-authenticate, then restart the proxy."
    }
  }

  // Rate limiting
  if (lower.includes("429") || lower.includes("rate limit") || lower.includes("too many requests")) {
    return {
      status: 429,
      type: "rate_limit_error",
      message: "Claude Max rate limit reached. Wait a moment and try again."
    }
  }

  // Billing / subscription
  if (lower.includes("402") || lower.includes("billing") || lower.includes("subscription") || lower.includes("payment")) {
    return {
      status: 402,
      type: "billing_error",
      message: "Claude Max subscription issue. Check your subscription status at https://claude.ai/settings/subscription"
    }
  }

  // Invalid request (upstream 400). The SDK surfaces upstream Anthropic API
  // errors as `API Error: <status> <body>`, so we match the formatted prefix
  // rather than the bare "400" digits to avoid false positives. The canonical
  // error type ("invalid_request_error") is also a strong signal.
  if (lower.includes("api error: 400") || lower.includes("invalid_request_error")) {
    return {
      status: 400,
      type: "invalid_request_error",
      message: errMsg,
    }
  }

  // SDK process crash
  if (lower.includes("exited with code") || lower.includes("process exited")) {
    const codeMatch = errMsg.match(/exited with code (\d+)/)
    const code = codeMatch ? codeMatch[1] : "unknown"

    // If stderr was captured it will be appended to the message — use it for classification
    const hasStderr = lower.includes("subprocess stderr:")
    const stderrContent = hasStderr ? lower.split("subprocess stderr:")[1]?.trim() ?? "" : ""

    // Explicit auth signal in stderr takes priority
    if (stderrContent.includes("authentication") || stderrContent.includes("401") || stderrContent.includes("oauth")) {
      return {
        status: 401,
        type: "authentication_error",
        message: "Claude authentication expired or invalid. Run 'claude login' in your terminal to re-authenticate, then restart the proxy."
      }
    }

    // Code 1 + no stderr: could be auth, but could also be a bad flag combination
    // or an environment issue. Give a less confident message and include stderr if present.
    if (code === "1" && !lower.includes("tool") && !lower.includes("mcp")) {
      const stderrHint = stderrContent ? ` Subprocess output: ${stderrContent.slice(0, 200)}` : " Run with CLAUDE_PROXY_DEBUG=1 for more detail."
      return {
        status: 401,
        type: "authentication_error",
        message: `Claude Code process exited (code 1). This is often an authentication issue — try 'claude login' and restart the proxy.${stderrHint}`
      }
    }

    return {
      status: 502,
      type: "api_error",
      message: `Claude Code process exited unexpectedly (code ${code}). Check proxy logs for details. If this persists, try 'claude login' to refresh authentication.`
    }
  }

  // Timeout
  if (lower.includes("timeout") || lower.includes("timed out")) {
    return {
      status: 504,
      type: "timeout_error",
      message: "Request timed out. The operation may have been too complex. Try a simpler request."
    }
  }

  // Server errors from Anthropic
  if (lower.includes("500") || lower.includes("server error") || lower.includes("internal error")) {
    return {
      status: 502,
      type: "api_error",
      message: "Claude API returned a server error. This is usually temporary — try again in a moment."
    }
  }

  // Overloaded
  if (lower.includes("503") || lower.includes("overloaded")) {
    return {
      status: 503,
      type: "overloaded_error",
      message: "Claude is temporarily overloaded. Try again in a few seconds."
    }
  }

  // Default
  return {
    status: 500,
    type: "api_error",
    message: errMsg || "Unknown error"
  }
}

/**
 * Error envelope returned to the client. When `body` was extracted verbatim
 * from an upstream Anthropic API error, every field (including `request_id`
 * and the inner `error.type`/`error.message`) is preserved as-is. Otherwise
 * `body` is synthesised from `classifyError`.
 */
export interface ErrorEnvelope {
  status: number
  body: Record<string, unknown>
}

/**
 * Try to pull a verbatim upstream Anthropic API error JSON out of an SDK
 * error message. The SDK surfaces upstream errors as
 *   `Claude Code returned an error result: API Error: <STATUS> <JSON>`
 * sometimes followed by `\nSubprocess stderr: ...`. We locate the first `{`
 * after `API Error: <STATUS>`, walk the brace nesting (string-aware) to find
 * the matching `}`, and JSON.parse only that slice — so trailing stderr or
 * other text doesn't break extraction.
 */
function extractUpstreamErrorBody(errMsg: string): ErrorEnvelope | null {
  const prefix = errMsg.match(/API Error:\s*(\d{3})\s+/)
  if (!prefix || prefix.index === undefined) return null
  const status = parseInt(prefix[1]!, 10)
  const startIdx = prefix.index + prefix[0].length
  if (errMsg[startIdx] !== "{") return null

  let depth = 0
  let inString = false
  let escape = false
  let endIdx = -1
  for (let i = startIdx; i < errMsg.length; i++) {
    const ch = errMsg[i]!
    if (escape) { escape = false; continue }
    if (inString) {
      if (ch === "\\") { escape = true; continue }
      if (ch === '"') { inString = false }
      continue
    }
    if (ch === '"') { inString = true; continue }
    if (ch === "{") depth++
    else if (ch === "}") {
      depth--
      if (depth === 0) { endIdx = i + 1; break }
    }
  }
  if (endIdx === -1) return null

  try {
    const parsed = JSON.parse(errMsg.slice(startIdx, endIdx))
    if (
      parsed &&
      typeof parsed === "object" &&
      (parsed as Record<string, unknown>).type === "error" &&
      typeof (parsed as Record<string, unknown>).error === "object" &&
      (parsed as Record<string, unknown>).error !== null
    ) {
      return { status, body: parsed as Record<string, unknown> }
    }
  } catch {
    // fall through
  }
  return null
}

/**
 * Build the error envelope returned to the client. Prefers an exact
 * pass-through of the upstream Anthropic API error body (preserving
 * `request_id`, the original `error.type`, and the original `error.message`)
 * when the SDK message embeds one. Falls back to a synthesised envelope from
 * `classifyError` for non-API errors (auth, timeouts, process crashes, etc.).
 */
export function buildErrorEnvelope(errMsg: string): ErrorEnvelope {
  const upstream = extractUpstreamErrorBody(errMsg)
  if (upstream) return upstream
  const classified = classifyError(errMsg)
  return {
    status: classified.status,
    body: {
      type: "error",
      error: { type: classified.type, message: classified.message },
    },
  }
}

/**
 * Detect errors caused by stale session/message UUIDs.
 * These happen when the upstream Claude session no longer contains
 * the referenced message (expired, compacted server-side, etc.).
 */
export function isStaleSessionError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  return error.message.includes("No message found with message.uuid")
}

/**
 * Quick check whether an error message indicates a rate limit.
 * Used by server.ts to decide whether to retry with a smaller context window.
 */
export function isRateLimitError(errMsg: string): boolean {
  const lower = errMsg.toLowerCase()
  return lower.includes("429") || lower.includes("rate limit") || lower.includes("too many requests")
}

/**
 * Detect the SDK "Reached maximum number of turns" error.
 * In passthrough mode maxTurns=1 is intentional — the SDK hitting this
 * limit is expected completion, not an error.
 */
export function isMaxTurnsError(errMsg: string): boolean {
  return errMsg.includes("Reached maximum number of turns")
}

/**
 * Detect the SDK "max_output_tokens" error.
 * The SDK throws this after yielding assistant content when the response
 * exceeds CLAUDE_CODE_MAX_OUTPUT_TOKENS. We treat it as normal completion
 * with stop_reason: "max_tokens" since the content was already captured.
 */
export function isMaxOutputTokensError(errMsg: string): boolean {
  return errMsg.includes("output token maximum") || errMsg.includes("max_output_tokens")
}

/**
 * Detect errors caused by the 1M context window requiring Extra Usage.
 * Max subscribers without Extra Usage enabled get this error when using
 * sonnet[1m] or opus[1m]. The fix is to fall back to the base model.
 */
export function isExtraUsageRequiredError(errMsg: string): boolean {
  const lower = errMsg.toLowerCase()
  return lower.includes("extra usage") && lower.includes("1m")
}
