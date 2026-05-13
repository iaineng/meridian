/**
 * Session id pool for one-shot JSONL mode.
 *
 * `acquire(seed?)` reuses an eligible previously-released id when available,
 * otherwise mints a fresh UUID. The mint strategy depends on whether the
 * caller supplied a profile seed:
 *
 *   - With seed: deterministic UUID derived from `sha256(seed || counter)`.
 *     Each profile (email → setup-token → profile id) keeps its own pool
 *     and its own monotonic counter, so two consecutive cold starts of the
 *     same profile reuse the exact same UUID set. Concrete benefit: the
 *     JSONL file path `<configDir>/projects/<cwd>/<uuid>.jsonl` becomes
 *     stable across restarts, and the "rely on overwrite instead of delete"
 *     cleanup model (see `handlers/blocking.ts`) can naturally bound the
 *     on-disk transcript count at peak concurrency.
 *   - Without seed: falls back to `randomUUID()`. Used when the profile is
 *     unauthenticated or the resolver returned `undefined`.
 *
 * `release(id)` puts the id into a `pending` quarantine for REUSE_DELAY_MS
 * before promoting it back to the reusable pool. Five seconds is long enough
 * for the SDK subprocess (Claude binary) to fully exit and release any open
 * file descriptors on the transcript — once that's true, the next acquirer
 * of the same id can safely overwrite the JSONL via `fs.writeFile` without
 * racing background writes from the previous subprocess.
 */

const DEFAULT_REUSE_DELAY_MS = 5_000

/** Sentinel key for the seed-less (random) pool. Real seeds are non-empty. */
const RANDOM_POOL_KEY = ""

interface SeedPool {
  /** Stable identifier; "" means the random fallback pool. */
  seed: string
  /** Ids ready for immediate reuse. */
  available: string[]
  /** Ids currently checked out. */
  inUse: Set<string>
  /** Ids in the post-release quarantine window (each owns a setTimeout). */
  pending: Map<string, ReturnType<typeof setTimeout>>
  /** Monotonic counter feeding `deriveUuid` for deterministic mints. */
  counter: number
}

function createSeedPool(seed: string): SeedPool {
  return { seed, available: [], inUse: new Set(), pending: new Map(), counter: 0 }
}

/**
 * Derive a UUID-shaped (8-4-4-4-12 hex) string from a seed plus a counter.
 * Uses SHA-256 truncated to 16 bytes — the SDK only validates the regex
 * shape, not the v4 random-bit metadata, so a hash-formatted id passes
 * unchanged through the resume path.
 *
 * Seeds carry account-identifying material (email or setup-token), so the
 * hash provides a one-way barrier between the on-disk JSONL filename and
 * the underlying identifier.
 */
function deriveUuid(seed: string, counter: number): string {
  const hasher = new Bun.CryptoHasher("sha256")
  hasher.update(seed)
  hasher.update("\x00")
  hasher.update(String(counter))
  const hash = hasher.digest("hex")
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    hash.slice(12, 16),
    hash.slice(16, 20),
    hash.slice(20, 32),
  ].join("-")
}

class EphemeralSessionIdPool {
  private readonly pools = new Map<string, SeedPool>()
  /** Reverse lookup so `release` is O(1) regardless of how many seeds exist. */
  private readonly idToPool = new Map<string, SeedPool>()
  private reuseDelayMs = DEFAULT_REUSE_DELAY_MS

  acquire(seed?: string): string {
    const key = seed ?? RANDOM_POOL_KEY
    let pool = this.pools.get(key)
    if (!pool) {
      pool = createSeedPool(key)
      this.pools.set(key, pool)
    }
    const id = pool.available.pop() ?? this.mint(pool)
    pool.inUse.add(id)
    this.idToPool.set(id, pool)
    return id
  }

  release(id: string): void {
    const pool = this.idToPool.get(id)
    if (!pool) return
    if (!pool.inUse.delete(id)) return
    this.idToPool.delete(id)
    if (this.reuseDelayMs <= 0) {
      pool.available.push(id)
      return
    }
    const t = setTimeout(() => {
      if (pool.pending.delete(id)) pool.available.push(id)
    }, this.reuseDelayMs)
    // Don't let a pending timer keep the Node event loop alive on shutdown.
    t.unref?.()
    pool.pending.set(id, t)
  }

  private mint(pool: SeedPool): string {
    if (pool.seed === RANDOM_POOL_KEY) return Bun.randomUUIDv7()
    pool.counter += 1
    return deriveUuid(pool.seed, pool.counter)
  }

  stats(): { available: number; inUse: number; pending: number; pools: number } {
    let a = 0
    let i = 0
    let p = 0
    for (const pool of this.pools.values()) {
      a += pool.available.length
      i += pool.inUse.size
      p += pool.pending.size
    }
    return { available: a, inUse: i, pending: p, pools: this.pools.size }
  }

  /** Test-only: override the quarantine window. 0 = immediate reuse. */
  _setReuseDelay(ms: number): void {
    this.reuseDelayMs = ms
  }

  /** Test-only: drain the pending queue into `available` without waiting. */
  _flushPending(): void {
    for (const pool of this.pools.values()) {
      for (const [id, t] of pool.pending) {
        clearTimeout(t)
        pool.available.push(id)
      }
      pool.pending.clear()
    }
  }

  _reset(): void {
    for (const pool of this.pools.values()) {
      for (const t of pool.pending.values()) clearTimeout(t)
    }
    this.pools.clear()
    this.idToPool.clear()
    this.reuseDelayMs = DEFAULT_REUSE_DELAY_MS
  }
}

export const ephemeralSessionIdPool = new EphemeralSessionIdPool()
export type { EphemeralSessionIdPool }
