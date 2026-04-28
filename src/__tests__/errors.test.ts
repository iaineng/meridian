/**
 * Unit tests for classifyError — pure function, no mocks needed.
 */
import { describe, it, expect } from "bun:test"
import { classifyError, buildErrorEnvelope, isStaleSessionError, isExtraUsageRequiredError } from "../proxy/errors"

describe("classifyError", () => {
  describe("authentication errors", () => {
    it("detects 401 status codes", () => {
      const result = classifyError("API Error: 401 authentication_error")
      expect(result.status).toBe(401)
      expect(result.type).toBe("authentication_error")
    })

    it("detects 'authentication' keyword", () => {
      const result = classifyError("authentication failed")
      expect(result.status).toBe(401)
    })

    it("detects 'invalid auth' keyword", () => {
      const result = classifyError("invalid auth token")
      expect(result.status).toBe(401)
    })

    it("detects 'credentials' keyword", () => {
      const result = classifyError("bad credentials provided")
      expect(result.status).toBe(401)
    })

    it("detects process exit code 1 as auth error", () => {
      const result = classifyError("Claude Code process exited with code 1")
      expect(result.status).toBe(401)
      expect(result.type).toBe("authentication_error")
    })

    it("does NOT classify exit code 1 as auth when 'tool' is mentioned", () => {
      const result = classifyError("Claude Code process exited with code 1 - tool error")
      expect(result.status).toBe(502)
      expect(result.type).toBe("api_error")
    })

    it("does NOT classify exit code 1 as auth when 'mcp' is mentioned", () => {
      const result = classifyError("Claude Code process exited with code 1 - mcp server crashed")
      expect(result.status).toBe(502)
      expect(result.type).toBe("api_error")
    })

    it("includes captured stderr in exit code 1 message", () => {
      const result = classifyError("Claude Code process exited with code 1\nSubprocess stderr: --permission-mode: invalid value 'bypassPermissions'")
      expect(result.status).toBe(401)
      expect(result.type).toBe("authentication_error")
      expect(result.message).toContain("permission-mode")
    })

    it("classifies as auth error when stderr contains authentication keyword", () => {
      const result = classifyError("Claude Code process exited with code 1\nSubprocess stderr: OAuth token expired")
      expect(result.status).toBe(401)
      expect(result.type).toBe("authentication_error")
    })
  })

  describe("rate limiting", () => {
    it("detects 429 status codes", () => {
      const result = classifyError("429 Too Many Requests")
      expect(result.status).toBe(429)
      expect(result.type).toBe("rate_limit_error")
    })

    it("detects 'rate limit' keyword", () => {
      const result = classifyError("rate limit exceeded")
      expect(result.status).toBe(429)
    })

    it("detects 'too many requests' keyword", () => {
      const result = classifyError("too many requests")
      expect(result.status).toBe(429)
    })
  })

  describe("billing errors", () => {
    it("detects 402 status codes", () => {
      const result = classifyError("402 billing_error")
      expect(result.status).toBe(402)
      expect(result.type).toBe("billing_error")
    })

    it("detects 'subscription' keyword", () => {
      const result = classifyError("subscription expired")
      expect(result.status).toBe(402)
    })
  })

  describe("invalid request errors", () => {
    it("detects 'API Error: 400' prefix from the SDK", () => {
      const result = classifyError(
        'Claude Code returned an error result: API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"messages.24.content.0.image.source.base64.data: At least one of the image dimensions exceed max allowed size: 8000 pixels"},"request_id":"req_011CaVb1QAN35qty4rbccC8M"}'
      )
      expect(result.status).toBe(400)
      expect(result.type).toBe("invalid_request_error")
      expect(result.message).toContain("image dimensions exceed")
    })

    it("detects the 'invalid_request_error' canonical type", () => {
      const result = classifyError("invalid_request_error: missing required field")
      expect(result.status).toBe(400)
      expect(result.type).toBe("invalid_request_error")
    })

    it("does NOT match a bare '400' that is not an API Error prefix", () => {
      const result = classifyError("processed 400 events successfully but then failed")
      expect(result.status).toBe(500)
      expect(result.type).toBe("api_error")
    })
  })

  describe("process crashes", () => {
    it("detects exit code with specific number", () => {
      const result = classifyError("exited with code 137")
      expect(result.status).toBe(502)
      expect(result.type).toBe("api_error")
      expect(result.message).toContain("137")
    })

    it("detects 'process exited' keyword", () => {
      const result = classifyError("process exited unexpectedly")
      expect(result.status).toBe(502)
    })

    it("uses 'unknown' when exit code not parseable", () => {
      const result = classifyError("process exited somehow")
      expect(result.message).toContain("unknown")
    })
  })

  describe("timeout errors", () => {
    it("detects 'timeout' keyword", () => {
      const result = classifyError("Request timeout after 120s")
      expect(result.status).toBe(504)
      expect(result.type).toBe("timeout_error")
    })

    it("detects 'timed out' keyword", () => {
      const result = classifyError("connection timed out")
      expect(result.status).toBe(504)
    })
  })

  describe("server errors", () => {
    it("detects 500 status codes", () => {
      const result = classifyError("HTTP 500 from API")
      expect(result.status).toBe(502)
      expect(result.type).toBe("api_error")
    })

    it("detects 'server error' keyword", () => {
      const result = classifyError("internal server error")
      expect(result.status).toBe(502)
    })
  })

  describe("overloaded", () => {
    it("detects 503 status codes", () => {
      const result = classifyError("503 overloaded")
      expect(result.status).toBe(503)
      expect(result.type).toBe("overloaded_error")
    })

    it("detects 'overloaded' keyword", () => {
      const result = classifyError("service overloaded")
      expect(result.status).toBe(503)
    })
  })

  describe("stale session detection", () => {
    it("detects 'No message found with message.uuid' errors", () => {
      expect(isStaleSessionError(new Error("No message found with message.uuid of: e663b687-6d08-4cc4-b9a9-5245ce8f1e07"))).toBe(true)
    })

    it("detects the error embedded in longer messages", () => {
      expect(isStaleSessionError(new Error("claude code returned an error result: No message found with message.uuid of: abc123"))).toBe(true)
    })

    it("returns false for unrelated errors", () => {
      expect(isStaleSessionError(new Error("rate limit exceeded"))).toBe(false)
      expect(isStaleSessionError(new Error("authentication failed"))).toBe(false)
    })

    it("returns false for non-Error values", () => {
      expect(isStaleSessionError("No message found with message.uuid")).toBe(false)
      expect(isStaleSessionError(null)).toBe(false)
      expect(isStaleSessionError(undefined)).toBe(false)
    })
  })

  describe("extra usage required", () => {
    it("detects the exact error from Claude SDK", () => {
      expect(isExtraUsageRequiredError(
        "Claude Code returned an error result: API Error: Extra usage is required for 1M context · enable extra usage at claude.ai/settings/usage, or use --model to switch"
      )).toBe(true)
    })

    it("detects lowercase variant", () => {
      expect(isExtraUsageRequiredError("extra usage is required for 1m context")).toBe(true)
    })

    it("returns false for unrelated errors", () => {
      expect(isExtraUsageRequiredError("rate limit exceeded")).toBe(false)
      expect(isExtraUsageRequiredError("authentication failed")).toBe(false)
    })

    it("returns false when only 'extra usage' but no '1m'", () => {
      expect(isExtraUsageRequiredError("extra usage enabled")).toBe(false)
    })

    it("returns false when only '1m' but no 'extra usage'", () => {
      expect(isExtraUsageRequiredError("using 1m context window")).toBe(false)
    })
  })

  describe("buildErrorEnvelope (upstream pass-through)", () => {
    it("preserves every upstream field verbatim — type, error.type, error.message, request_id", () => {
      const sdkErr =
        'Claude Code returned an error result: API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"messages.0.content: thinking blocks may only be in `assistant` messages"},"request_id":"req_011CaVcBf1yJrn4zwNo22znW"}'
      const env = buildErrorEnvelope(sdkErr)
      expect(env.status).toBe(400)
      expect(env.body).toEqual({
        type: "error",
        error: {
          type: "invalid_request_error",
          message: "messages.0.content: thinking blocks may only be in `assistant` messages",
        },
        request_id: "req_011CaVcBf1yJrn4zwNo22znW",
      })
    })

    it("uses the upstream HTTP status (e.g. 429) when present", () => {
      const sdkErr =
        'Claude Code returned an error result: API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"too many requests"},"request_id":"req_X"}'
      const env = buildErrorEnvelope(sdkErr)
      expect(env.status).toBe(429)
      expect((env.body.error as any).type).toBe("rate_limit_error")
      expect(env.body.request_id).toBe("req_X")
    })

    it("ignores trailing stderr appended after the JSON body", () => {
      const sdkErr =
        'Claude Code returned an error result: API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"bad"},"request_id":"req_Y"}\nSubprocess stderr: noise that is not JSON'
      const env = buildErrorEnvelope(sdkErr)
      expect(env.status).toBe(400)
      expect(env.body).toEqual({
        type: "error",
        error: { type: "invalid_request_error", message: "bad" },
        request_id: "req_Y",
      })
    })

    it("falls back to classifyError envelope for non-API SDK errors", () => {
      const env = buildErrorEnvelope("Request timed out")
      expect(env.status).toBe(504)
      expect((env.body.error as any).type).toBe("timeout_error")
      expect(env.body.request_id).toBeUndefined()
    })

    it("falls back when the upstream JSON body is malformed", () => {
      const env = buildErrorEnvelope('API Error: 400 {not real json}')
      expect(env.status).toBe(400) // still classified as 400 by classifyError's API Error branch
      expect((env.body.error as any).type).toBe("invalid_request_error")
      expect(env.body.request_id).toBeUndefined()
    })

    it("falls back when JSON parses but has wrong shape", () => {
      const env = buildErrorEnvelope('API Error: 400 {"foo":"bar"}')
      // No top-level type:"error" → not an upstream envelope.
      expect(env.body.request_id).toBeUndefined()
    })
  })

  describe("default/unknown", () => {
    it("returns 500 for unknown errors", () => {
      const result = classifyError("Something weird happened")
      expect(result.status).toBe(500)
      expect(result.type).toBe("api_error")
      expect(result.message).toBe("Something weird happened")
    })

    it("returns 'Unknown error' for empty string", () => {
      const result = classifyError("")
      expect(result.status).toBe(500)
      expect(result.message).toBe("Unknown error")
    })
  })
})
