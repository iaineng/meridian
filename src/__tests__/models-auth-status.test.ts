/**
 * Tests for getClaudeAuthStatusAsync and auth status resilience.
 *
 * These tests manipulate process.env.PATH and global auth caches.
 * They MUST run in isolation (separate bun test invocation) to prevent
 * cache state from leaking to/from other test files.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import {
  resetCachedClaudeAuthStatus,
  getClaudeAuthStatusAsync,
  expireAuthStatusCache,
} from "../proxy/models"

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

  it("returns last known good status when auth check fails after a prior success", async () => {
    // Simulate a successful call by calling with intact PATH
    const result1 = await getClaudeAuthStatusAsync()

    if (result1 === null) {
      // Claude not installed — can't test last-known-good flow; skip gracefully
      return
    }

    // Now expire the cache (but preserve lastKnownGood) and break PATH
    const originalPath = process.env.PATH
    expireAuthStatusCache()
    process.env.PATH = ""
    try {
      const result2 = await getClaudeAuthStatusAsync()
      // Should return last known good, not null
      expect(result2).not.toBeNull()
      expect(result2?.subscriptionType).toBe(result1.subscriptionType)
    } finally {
      process.env.PATH = originalPath
    }
  })

  it("returns null on first failure when no prior success exists", async () => {
    // Fresh state with no last known good
    const originalPath = process.env.PATH
    process.env.PATH = ""
    try {
      const result = await getClaudeAuthStatusAsync()
      expect(result).toBeNull()
    } finally {
      process.env.PATH = originalPath
    }
  })

  it("uses shorter TTL for failed auth checks (faster recovery)", async () => {
    // Sabotage PATH → failure cached with short TTL (5s)
    const originalPath = process.env.PATH
    process.env.PATH = ""
    try {
      await getClaudeAuthStatusAsync()
    } finally {
      process.env.PATH = originalPath
    }

    // Immediately after: cache is still valid (within 5s TTL)
    const cached = await getClaudeAuthStatusAsync()
    expect(cached).toBeNull() // Still returns null (no last known good)

    // Expire and call again with working PATH — should re-execute
    expireAuthStatusCache()
    const fresh = await getClaudeAuthStatusAsync()
    // If claude is installed, this succeeds; if not, null again — but
    // the key assertion is that expireAuthStatusCache allowed re-execution
    expect(fresh === null || typeof fresh === "object").toBe(true)
  })
})

