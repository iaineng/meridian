/**
 * Session id pool for one-shot JSONL mode.
 *
 * `acquire()` reuses an eligible previously-released id when available,
 * otherwise mints a fresh UUID. `release(id)` puts the id into a `pending`
 * quarantine for REUSE_DELAY_MS before promoting it to the reusable pool.
 *
 * The delay exists because the SDK subprocess may still hold the JSONL file
 * open (background writebacks, lingering fd close) for a short interval after
 * the proxy's async iterable completes and `cleanupEphemeral` runs. Reusing
 * the id immediately could race an in-flight SDK write against the next
 * request's `fs.writeFile`. Ten seconds is well beyond the SDK's normal
 * teardown window while still bounding the pool's effective size.
 *
 * Used only when MERIDIAN_EPHEMERAL_JSONL is enabled; in all other modes
 * the existing session cache/lineage path runs unchanged.
 */
import { randomUUID } from "node:crypto"

const DEFAULT_REUSE_DELAY_MS = 10_000

class EphemeralSessionIdPool {
  private available: string[] = []
  private readonly inUse = new Set<string>()
  /** Released ids not yet eligible for reuse. Each has a pending timer. */
  private readonly pending = new Map<string, ReturnType<typeof setTimeout>>()
  private reuseDelayMs = DEFAULT_REUSE_DELAY_MS

  acquire(): string {
    const id = this.available.pop() ?? randomUUID()
    this.inUse.add(id)
    return id
  }

  release(id: string): void {
    if (!this.inUse.delete(id)) return
    if (this.reuseDelayMs <= 0) {
      this.available.push(id)
      return
    }
    const t = setTimeout(() => {
      if (this.pending.delete(id)) this.available.push(id)
    }, this.reuseDelayMs)
    // Don't let a pending timer keep the Node event loop alive on shutdown.
    t.unref?.()
    this.pending.set(id, t)
  }

  stats(): { available: number; inUse: number; pending: number } {
    return { available: this.available.length, inUse: this.inUse.size, pending: this.pending.size }
  }

  /** Test-only: override the quarantine window. 0 = immediate reuse. */
  _setReuseDelay(ms: number): void {
    this.reuseDelayMs = ms
  }

  /** Test-only: drain the pending queue into `available` without waiting. */
  _flushPending(): void {
    for (const [id, t] of this.pending) {
      clearTimeout(t)
      this.available.push(id)
    }
    this.pending.clear()
  }

  _reset(): void {
    for (const t of this.pending.values()) clearTimeout(t)
    this.pending.clear()
    this.available.length = 0
    this.inUse.clear()
    this.reuseDelayMs = DEFAULT_REUSE_DELAY_MS
  }
}

export const ephemeralSessionIdPool = new EphemeralSessionIdPool()
export type { EphemeralSessionIdPool }
