/**
 * Unit tests for EphemeralSessionIdPool.
 *
 * Released ids go back into an `available` stack and are reused on the next
 * `acquire()` so a long-running proxy doesn't mint a new UUID for every
 * request. Reuse is safe because each request overwrites its JSONL before
 * the SDK reads it and deletes the file on completion — no two requests
 * share the file at the same time.
 */
import { describe, it, expect, beforeEach } from "bun:test"
import { ephemeralSessionIdPool } from "../proxy/session/ephemeralPool"

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

describe("EphemeralSessionIdPool", () => {
  beforeEach(() => {
    ephemeralSessionIdPool._reset()
    // Disable the reuse delay so the core pool semantics can be asserted
    // synchronously. A separate `describe` block below covers the delay.
    ephemeralSessionIdPool._setReuseDelay(0)
  })

  it("generates a valid UUID on acquire", () => {
    const id = ephemeralSessionIdPool.acquire()
    expect(id).toMatch(UUID_RE)
    expect(ephemeralSessionIdPool.stats()).toEqual({ available: 0, inUse: 1, pending: 0 })
  })

  it("release moves id from inUse to available", () => {
    const id = ephemeralSessionIdPool.acquire()
    ephemeralSessionIdPool.release(id)
    expect(ephemeralSessionIdPool.stats()).toEqual({ available: 1, inUse: 0, pending: 0 })
  })

  it("reuses a released id on the next acquire", () => {
    const first = ephemeralSessionIdPool.acquire()
    ephemeralSessionIdPool.release(first)
    const second = ephemeralSessionIdPool.acquire()
    expect(second).toBe(first)
    expect(ephemeralSessionIdPool.stats()).toEqual({ available: 0, inUse: 1, pending: 0 })
  })

  it("generates distinct ids when acquired concurrently (empty pool)", () => {
    const a = ephemeralSessionIdPool.acquire()
    const b = ephemeralSessionIdPool.acquire()
    const c = ephemeralSessionIdPool.acquire()
    expect(new Set([a, b, c]).size).toBe(3)
    expect(ephemeralSessionIdPool.stats()).toEqual({ available: 0, inUse: 3, pending: 0 })
  })

  it("release of unknown id is a no-op", () => {
    const a = ephemeralSessionIdPool.acquire()
    ephemeralSessionIdPool.release("not-a-pool-id")
    expect(ephemeralSessionIdPool.stats()).toEqual({ available: 0, inUse: 1, pending: 0 })
    ephemeralSessionIdPool.release(a)
  })

  it("double-release is idempotent (second release is a no-op)", () => {
    const a = ephemeralSessionIdPool.acquire()
    ephemeralSessionIdPool.release(a)
    ephemeralSessionIdPool.release(a)
    expect(ephemeralSessionIdPool.stats()).toEqual({ available: 1, inUse: 0, pending: 0 })
  })

  it("_reset clears both available and inUse", () => {
    const a = ephemeralSessionIdPool.acquire()
    ephemeralSessionIdPool.release(a)
    ephemeralSessionIdPool.acquire()
    expect(ephemeralSessionIdPool.stats()).toEqual({ available: 0, inUse: 1, pending: 0 })
    ephemeralSessionIdPool._reset()
    expect(ephemeralSessionIdPool.stats()).toEqual({ available: 0, inUse: 0, pending: 0 })
  })

  it("release-then-acquire cycle reuses the single pool slot", () => {
    const seen = new Set<string>()
    for (let i = 0; i < 5; i++) {
      const id = ephemeralSessionIdPool.acquire()
      seen.add(id)
      ephemeralSessionIdPool.release(id)
    }
    expect(seen.size).toBe(1)
    expect(ephemeralSessionIdPool.stats()).toEqual({ available: 1, inUse: 0, pending: 0 })
  })

  it("concurrent acquires followed by releases fill the available stack", () => {
    const ids: string[] = []
    for (let i = 0; i < 3; i++) ids.push(ephemeralSessionIdPool.acquire())
    for (const id of ids) ephemeralSessionIdPool.release(id)
    expect(ephemeralSessionIdPool.stats()).toEqual({ available: 3, inUse: 0, pending: 0 })
    const next = ephemeralSessionIdPool.acquire()
    expect(ids).toContain(next)
  })
})

describe("EphemeralSessionIdPool — delayed reuse quarantine", () => {
  beforeEach(() => {
    ephemeralSessionIdPool._reset()
  })

  it("released ids land in pending, not available, while the delay window is active", () => {
    ephemeralSessionIdPool._setReuseDelay(10_000)
    const a = ephemeralSessionIdPool.acquire()
    ephemeralSessionIdPool.release(a)
    expect(ephemeralSessionIdPool.stats()).toEqual({ available: 0, inUse: 0, pending: 1 })
  })

  it("next acquire mints a fresh uuid while the previous id is still pending", () => {
    ephemeralSessionIdPool._setReuseDelay(10_000)
    const first = ephemeralSessionIdPool.acquire()
    ephemeralSessionIdPool.release(first)
    const second = ephemeralSessionIdPool.acquire()
    expect(second).not.toBe(first)
    expect(ephemeralSessionIdPool.stats()).toEqual({ available: 0, inUse: 1, pending: 1 })
  })

  it("_flushPending promotes quarantined ids into available", () => {
    ephemeralSessionIdPool._setReuseDelay(10_000)
    const a = ephemeralSessionIdPool.acquire()
    ephemeralSessionIdPool.release(a)
    ephemeralSessionIdPool._flushPending()
    expect(ephemeralSessionIdPool.stats()).toEqual({ available: 1, inUse: 0, pending: 0 })
    const reused = ephemeralSessionIdPool.acquire()
    expect(reused).toBe(a)
  })

  it("after the delay elapses, the id becomes eligible for reuse", async () => {
    ephemeralSessionIdPool._setReuseDelay(25)
    const a = ephemeralSessionIdPool.acquire()
    ephemeralSessionIdPool.release(a)
    expect(ephemeralSessionIdPool.stats()).toEqual({ available: 0, inUse: 0, pending: 1 })
    await new Promise((r) => setTimeout(r, 60))
    expect(ephemeralSessionIdPool.stats()).toEqual({ available: 1, inUse: 0, pending: 0 })
    expect(ephemeralSessionIdPool.acquire()).toBe(a)
  })

  it("_reset cancels pending timers and clears the queue", () => {
    ephemeralSessionIdPool._setReuseDelay(10_000)
    const a = ephemeralSessionIdPool.acquire()
    ephemeralSessionIdPool.release(a)
    expect(ephemeralSessionIdPool.stats().pending).toBe(1)
    ephemeralSessionIdPool._reset()
    expect(ephemeralSessionIdPool.stats()).toEqual({ available: 0, inUse: 0, pending: 0 })
  })
})
