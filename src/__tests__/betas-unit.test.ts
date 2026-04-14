/**
 * Unit tests for filterBetasForProfile.
 *
 * Pure function, no mocks required.
 */

import { describe, it, expect } from "bun:test"
import { filterBetasForProfile } from "../proxy/betas"

describe("filterBetasForProfile", () => {
  describe("empty / undefined input", () => {
    it("returns no forwarded betas for undefined header", () => {
      const result = filterBetasForProfile(undefined, "claude-max")
      expect(result.forwarded).toBeUndefined()
      expect(result.stripped).toEqual([])
    })

    it("returns no forwarded betas for empty string", () => {
      const result = filterBetasForProfile("", "claude-max")
      expect(result.forwarded).toBeUndefined()
      expect(result.stripped).toEqual([])
    })

    it("returns no forwarded betas for whitespace-only string", () => {
      const result = filterBetasForProfile("   ,  ,", "claude-max")
      expect(result.forwarded).toBeUndefined()
      expect(result.stripped).toEqual([])
    })
  })

  describe("api profile — pass-through", () => {
    it("forwards a single beta", () => {
      const result = filterBetasForProfile("context-1m-2025-08-07", "api")
      expect(result.forwarded).toEqual(["context-1m-2025-08-07"])
      expect(result.stripped).toEqual([])
    })

    it("forwards all betas unchanged", () => {
      const result = filterBetasForProfile(
        "prompt-caching-2024-07-31, extended-cache-ttl-2025-04-11, context-1m-2025-08-07",
        "api",
      )
      expect(result.forwarded).toEqual([
        "prompt-caching-2024-07-31",
        "extended-cache-ttl-2025-04-11",
        "context-1m-2025-08-07",
      ])
      expect(result.stripped).toEqual([])
    })

    it("trims whitespace", () => {
      const result = filterBetasForProfile(
        "  prompt-caching-2024-07-31 ,  context-1m-2025-08-07  ",
        "api",
      )
      expect(result.forwarded).toEqual([
        "prompt-caching-2024-07-31",
        "context-1m-2025-08-07",
      ])
    })
  })

  describe("claude-max profile — strip all", () => {
    it("strips a single beta", () => {
      const result = filterBetasForProfile("prompt-caching-2024-07-31", "claude-max")
      expect(result.forwarded).toBeUndefined()
      expect(result.stripped).toEqual(["prompt-caching-2024-07-31"])
    })

    it("strips all betas from a mixed list", () => {
      const result = filterBetasForProfile(
        "prompt-caching-2024-07-31, extended-cache-ttl-2025-04-11, context-1m-2025-08-07",
        "claude-max",
      )
      expect(result.forwarded).toBeUndefined()
      expect(result.stripped).toEqual([
        "prompt-caching-2024-07-31",
        "extended-cache-ttl-2025-04-11",
        "context-1m-2025-08-07",
      ])
    })

    it("trims whitespace and drops empty entries", () => {
      const result = filterBetasForProfile(
        ",,  prompt-caching-2024-07-31 , ,  context-1m-2025-08-07  ,",
        "claude-max",
      )
      expect(result.forwarded).toBeUndefined()
      expect(result.stripped).toEqual([
        "prompt-caching-2024-07-31",
        "context-1m-2025-08-07",
      ])
    })
  })
})
