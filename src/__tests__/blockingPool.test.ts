/**
 * Unit tests for the blocking-MCP session registry.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import {
  blockingPool,
  stringifyBlockingKey,
  type BlockingSessionKey,
} from "../proxy/session/blockingPool"

function testState(key: BlockingSessionKey) {
  return {
    key,
    ephemeralSessionId: "00000000-0000-0000-0000-000000000000",
    workingDirectory: "/tmp",
    priorMessageHashes: ["hash-user-0"],
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
    expect(blockingPool.lookup(key)).toBe(state)

    await blockingPool.release(key, "test")
    expect(blockingPool.lookup(key)).toBeUndefined()
  })

  it("acquire throws when an active session already holds the key", () => {
    const key: BlockingSessionKey = { kind: "lineage", hash: "abc" }
    blockingPool.acquire(key, testState(key))
    expect(() => blockingPool.acquire(key, testState(key))).toThrow(/already in use/)
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

    await blockingPool.release(key, "test")
    await blockingPool.release(key, "test") // idempotent
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
    expect(blockingPool.lookup(key)).toBeUndefined()
  })

  it("touch extends expiresAt", () => {
    blockingPool._setTimeoutMs(10_000)
    const key: BlockingSessionKey = { kind: "header", value: "s4" }
    const state = blockingPool.acquire(key, testState(key))
    const first = state.expiresAt
    // Advance a tiny bit so touch produces a different value
    const before = Date.now()
    blockingPool.touch(key)
    expect(state.expiresAt).toBeGreaterThanOrEqual(before + 10_000 - 5)
    expect(state.expiresAt).toBeGreaterThanOrEqual(first)
  })
})
