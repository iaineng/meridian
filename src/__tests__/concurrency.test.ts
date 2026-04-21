import { describe, expect, it } from "bun:test"
import { createConcurrencyGate } from "../proxy/concurrency"

describe("createConcurrencyGate", () => {
  it("admits up to `max` concurrent acquires then queues further ones", async () => {
    const gate = createConcurrencyGate(2)
    const a = gate.acquire()
    const b = gate.acquire()
    const c = gate.acquire()

    await a
    await b
    expect(gate.active).toBe(2)
    expect(gate.queued).toBe(1)

    let cResolved = false
    c.then(() => { cResolved = true })

    // Microtask flush — `c` must still be pending.
    await Promise.resolve()
    expect(cResolved).toBe(false)

    gate.release()
    await c
    expect(cResolved).toBe(true)
    expect(gate.active).toBe(2) // a released, c promoted
    expect(gate.queued).toBe(0)

    gate.release()
    gate.release()
    expect(gate.active).toBe(0)
  })

  it("preserves FIFO order across multiple waiters", async () => {
    const gate = createConcurrencyGate(1)
    const order: number[] = []
    await gate.acquire() // holder

    const p1 = gate.acquire().then(() => order.push(1))
    const p2 = gate.acquire().then(() => order.push(2))
    const p3 = gate.acquire().then(() => order.push(3))

    expect(gate.queued).toBe(3)

    gate.release() // → promote p1
    await p1
    gate.release() // → promote p2
    await p2
    gate.release() // → promote p3
    await p3
    gate.release()

    expect(order).toEqual([1, 2, 3])
    expect(gate.active).toBe(0)
  })

  it("unlimited mode (max=0) never queues and `release` is a pure decrement", async () => {
    const gate = createConcurrencyGate(0)
    expect(gate.unlimited).toBe(true)

    const promises = Array.from({ length: 100 }, () => gate.acquire())
    await Promise.all(promises)

    expect(gate.active).toBe(100)
    expect(gate.queued).toBe(0)

    for (let i = 0; i < 100; i++) gate.release()
    expect(gate.active).toBe(0)
    expect(gate.queued).toBe(0)
  })

  it("unlimited mode reports the configured max (<=0) as-is", () => {
    const a = createConcurrencyGate(0)
    const b = createConcurrencyGate(-5)
    expect(a.unlimited).toBe(true)
    expect(b.unlimited).toBe(true)
    expect(a.max).toBe(0)
    expect(b.max).toBe(-5)
  })

  it("bounded mode exposes `max` and `unlimited=false`", () => {
    const gate = createConcurrencyGate(10)
    expect(gate.max).toBe(10)
    expect(gate.unlimited).toBe(false)
  })
})
