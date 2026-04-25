/**
 * Unit tests for the blocking-MCP session registry.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import {
  blockingPool,
  stringifyBlockingKey,
  type BlockingSessionKey,
} from "../proxy/session/blockingPool"

function testState(key: BlockingSessionKey, priorMessageHashes: string[] = ["hash-user-0"]) {
  return {
    key,
    ephemeralSessionId: "00000000-0000-0000-0000-000000000000",
    workingDirectory: "/tmp",
    priorMessageHashes,
    cleanup: async () => {},
  }
}

describe("blockingPool", () => {
  beforeEach(async () => {
    await blockingPool._reset()
  })

  afterEach(async () => {
    await blockingPool._reset()
  })

  it("stringifyBlockingKey distinguishes header vs lineage", () => {
    expect(stringifyBlockingKey({ kind: "header", value: "abc" })).toBe("h:abc")
    expect(stringifyBlockingKey({ kind: "lineage", hash: "abc" })).toBe("l:abc")
    expect(stringifyBlockingKey({ kind: "header", value: "abc" }))
      .not.toBe(stringifyBlockingKey({ kind: "lineage", hash: "abc" }))
  })

  it("acquire → lookup returns the same state; release removes it", async () => {
    const key: BlockingSessionKey = { kind: "header", value: "s1" }
    const state = blockingPool.acquire(key, testState(key))
    expect(state.status).toBe("streaming")
    expect(state.pendingTools.size).toBe(0)
    expect(blockingPool.lookup(key, ["hash-user-0"])).toBe(state)

    await blockingPool.release(state, "test")
    expect(blockingPool.lookup(key, ["hash-user-0"])).toBeUndefined()
    expect(blockingPool.totalSize()).toBe(0)
  })

  it("acquire appends a sibling when one already holds the key", () => {
    const key: BlockingSessionKey = { kind: "lineage", hash: "abc" }
    const s1 = blockingPool.acquire(key, testState(key, ["h0"]))
    const s2 = blockingPool.acquire(key, testState(key, ["h0", "h1a"]))
    expect(s1).not.toBe(s2)
    expect(blockingPool.size()).toBe(1)
    expect(blockingPool.totalSize()).toBe(2)
  })

  it("lookup returns the longest-prefix sibling", () => {
    const key: BlockingSessionKey = { kind: "lineage", hash: "root" }
    const sA = blockingPool.acquire(key, testState(key, ["h0"]))
    const sB = blockingPool.acquire(key, testState(key, ["h0", "h1a", "h2a"]))

    // Incoming extends sB — longer prefix wins.
    expect(blockingPool.lookup(key, ["h0", "h1a", "h2a", "h3a"])).toBe(sB)
    // Incoming extends sA but diverges from sB at position 1 — sA wins.
    expect(blockingPool.lookup(key, ["h0", "h1b", "h2b"])).toBe(sA)
    // Incoming doesn't even match sA's first hash — undefined.
    expect(blockingPool.lookup(key, ["other", "h1"])).toBeUndefined()
  })

  it("release rejects pending handlers and invokes cleanup exactly once", async () => {
    let cleanupCalls = 0
    const key: BlockingSessionKey = { kind: "header", value: "s2" }
    const init = testState(key)
    init.cleanup = async () => { cleanupCalls++ }
    const state = blockingPool.acquire(key, init)

    let rejected = false
    state.pendingTools.set("tu_1", {
      mcpToolName: "Read",
      clientToolName: "Read",
      toolUseId: "tu_1",
      input: {},
      resolve: () => {},
      reject: () => { rejected = true },
      startedAt: Date.now(),
    })

    await blockingPool.release(state, "test")
    await blockingPool.release(state, "test") // idempotent
    expect(cleanupCalls).toBe(1)
    expect(rejected).toBe(true)
    expect(state.status).toBe("terminated")
  })

  it("janitor reaps expired sessions on _runJanitor", async () => {
    blockingPool._setTimeoutMs(1) // 1ms TTL
    const key: BlockingSessionKey = { kind: "header", value: "s3" }
    blockingPool.acquire(key, testState(key))

    await new Promise(r => setTimeout(r, 5))
    await blockingPool._runJanitor()
    expect(blockingPool.lookup(key, ["hash-user-0"])).toBeUndefined()
  })

  it("touch extends expiresAt", () => {
    blockingPool._setTimeoutMs(10_000)
    const key: BlockingSessionKey = { kind: "header", value: "s4" }
    const state = blockingPool.acquire(key, testState(key))
    const first = state.expiresAt
    // Advance a tiny bit so touch produces a different value
    const before = Date.now()
    blockingPool.touch(state)
    expect(state.expiresAt).toBeGreaterThanOrEqual(before + 10_000 - 5)
    expect(state.expiresAt).toBeGreaterThanOrEqual(first)
  })

  it("releaseAll tears down every sibling under a key", async () => {
    const key: BlockingSessionKey = { kind: "lineage", hash: "root" }
    const sA = blockingPool.acquire(key, testState(key, ["h0"]))
    const sB = blockingPool.acquire(key, testState(key, ["h0", "h1"]))
    expect(blockingPool.totalSize()).toBe(2)

    await blockingPool.releaseAll(key, "test")
    expect(sA.status).toBe("terminated")
    expect(sB.status).toBe("terminated")
    expect(blockingPool.totalSize()).toBe(0)
    expect(blockingPool.size()).toBe(0)
  })
})
