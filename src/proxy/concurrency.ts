/**
 * Simple FIFO concurrency gate used to serialize SDK subprocess spawning.
 *
 * Each proxy request spawns a ~11MB SDK subprocess; spawning many at once can
 * OOM the host or crash the Node process, so requests are admitted through a
 * bounded queue.
 *
 * Setting `max <= 0` disables the queue entirely: `acquire()` always resolves
 * synchronously and `release()` becomes a no-op past the counter. The counter
 * is still maintained so callers can log it.
 */

export interface ConcurrencyGate {
  acquire(): Promise<void>
  release(): void
  readonly active: number
  readonly max: number
  readonly unlimited: boolean
  readonly queued: number
}

export function createConcurrencyGate(max: number): ConcurrencyGate {
  const unlimited = max <= 0
  let active = 0
  const waiters: Array<{ resolve: () => void }> = []

  return {
    acquire(): Promise<void> {
      if (unlimited || active < max) {
        active++
        return Promise.resolve()
      }
      return new Promise<void>((resolve) => {
        waiters.push({ resolve })
      })
    },

    release(): void {
      active--
      if (unlimited) return
      const next = waiters.shift()
      if (next) {
        active++
        next.resolve()
      }
    },

    get active() { return active },
    get max() { return max },
    get unlimited() { return unlimited },
    get queued() { return waiters.length },
  }
}
