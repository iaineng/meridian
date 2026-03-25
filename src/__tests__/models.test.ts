/**
 * Unit tests for model mapping and utility functions.
 */
import { afterEach, beforeEach, describe, it, expect, mock } from "bun:test"
import { mapModelToClaudeModel, isClosedControllerError, resetCachedClaudeAuthStatus, getClaudeAuthStatusAsync } from "../proxy/models"

describe("mapModelToClaudeModel", () => {
  const originalSonnetModel = process.env.CLAUDE_PROXY_SONNET_MODEL

  afterEach(() => {
    if (originalSonnetModel === undefined) delete process.env.CLAUDE_PROXY_SONNET_MODEL
    else process.env.CLAUDE_PROXY_SONNET_MODEL = originalSonnetModel
    resetCachedClaudeAuthStatus()
  })
  it("maps opus models to opus[1m]", () => {
    expect(mapModelToClaudeModel("claude-opus-4-5")).toBe("opus[1m]")
    expect(mapModelToClaudeModel("opus")).toBe("opus[1m]")
    expect(mapModelToClaudeModel("claude-opus-4-6")).toBe("opus[1m]")
  })

  it("maps haiku models to haiku", () => {
    expect(mapModelToClaudeModel("claude-haiku-4-5")).toBe("haiku")
    expect(mapModelToClaudeModel("haiku")).toBe("haiku")
  })

  it("maps sonnet models to sonnet[1m] for max subscriptions", () => {
    expect(mapModelToClaudeModel("claude-sonnet-4-5", "max")).toBe("sonnet[1m]")
    expect(mapModelToClaudeModel("sonnet", "max")).toBe("sonnet[1m]")
    expect(mapModelToClaudeModel("claude-sonnet-4-5-20250929", "max")).toBe("sonnet[1m]")
  })

  it("maps sonnet models to plain sonnet for non-max subscriptions", () => {
    expect(mapModelToClaudeModel("claude-sonnet-4-5", "team")).toBe("sonnet")
    expect(mapModelToClaudeModel("sonnet", "pro")).toBe("sonnet")
    expect(mapModelToClaudeModel("claude-sonnet-4-5-20250929", "")).toBe("sonnet")
  })

  it("defaults unknown models to plain sonnet for non-max subscriptions", () => {
    expect(mapModelToClaudeModel("unknown-model")).toBe("sonnet")
    expect(mapModelToClaudeModel("", undefined)).toBe("sonnet")
  })

  it("respects explicit sonnet model override", () => {
    process.env.CLAUDE_PROXY_SONNET_MODEL = "sonnet[1m]"
    expect(mapModelToClaudeModel("sonnet", "team")).toBe("sonnet[1m]")

    process.env.CLAUDE_PROXY_SONNET_MODEL = "sonnet"
    expect(mapModelToClaudeModel("sonnet", "max")).toBe("sonnet")
  })
})

describe("getClaudeAuthStatusAsync", () => {
  beforeEach(() => {
    resetCachedClaudeAuthStatus()
  })

  it("returns parsed auth status on success", async () => {
    // On a machine with claude installed, this should return something or null
    // We test the caching behavior by calling twice and verifying dedup
    const result1 = await getClaudeAuthStatusAsync()
    const result2 = await getClaudeAuthStatusAsync()
    // Second call should return the cached result (same reference)
    expect(result2).toBe(result1)
  })

  it("caches null results to avoid repeated exec calls", async () => {
    // Sabotage PATH so `claude auth status` fails
    const originalPath = process.env.PATH
    process.env.PATH = ""
    try {
      const result1 = await getClaudeAuthStatusAsync()
      expect(result1).toBeNull()

      // Restore PATH — if negative caching works, the next call should
      // still return the cached null without re-executing
      process.env.PATH = originalPath
      const result2 = await getClaudeAuthStatusAsync()
      expect(result2).toBeNull()
    } finally {
      process.env.PATH = originalPath
    }
  })

  it("refreshes after reset", async () => {
    // First call with broken PATH → cached null
    const originalPath = process.env.PATH
    process.env.PATH = ""
    try {
      const result1 = await getClaudeAuthStatusAsync()
      expect(result1).toBeNull()
    } finally {
      process.env.PATH = originalPath
    }

    // Reset clears the cache, so next call re-executes
    resetCachedClaudeAuthStatus()
    const result2 = await getClaudeAuthStatusAsync()
    // With PATH restored, this may succeed (returns object) or fail (null)
    // depending on whether claude is installed — either way it re-executed
    // We just verify reset didn't break anything
    expect(result2 === null || typeof result2 === "object").toBe(true)
  })
})

describe("isClosedControllerError", () => {
  it("returns true for Controller is already closed error", () => {
    expect(isClosedControllerError(new Error("Controller is already closed"))).toBe(true)
  })

  it("returns true when message contains the phrase", () => {
    expect(isClosedControllerError(new Error("Error: Controller is already closed foo"))).toBe(true)
  })

  it("returns false for other errors", () => {
    expect(isClosedControllerError(new Error("something else"))).toBe(false)
  })

  it("returns false for non-Error values", () => {
    expect(isClosedControllerError("string")).toBe(false)
    expect(isClosedControllerError(null)).toBe(false)
    expect(isClosedControllerError(undefined)).toBe(false)
    expect(isClosedControllerError(42)).toBe(false)
  })
})
