/**
 * Regression test for the multi-round continuation hash match.
 *
 * On the INITIAL request the conversation is just `[user0]`. By the time the
 * client comes back with tool_results, the request looks like
 * `[user0, assistantA(tool_use), user1(tool_result)]`. A naive `hash(prior)`
 * equality check between rounds would fail, because the stored hash was taken
 * over `[user0]` while the incoming prior is `[user0, assistantA]`.
 *
 * We use per-message hashes + `measurePrefixOverlap` so the continuation is
 * accepted as long as the previously-seen prefix is intact. After accepting,
 * we refresh the stored hashes to the new prior, so the NEXT round validates
 * against the extended prefix.
 */

import { describe, it, expect } from "bun:test"
import { computeMessageHashes, measurePrefixOverlap } from "../proxy/session/lineage"

describe("blocking continuation lineage verification", () => {
  it("prefix overlap accepts a 1-round → 2-round growth", () => {
    // Round 0 (initial): only one user message. Stored hashes at acquire.
    const initialMessages = [
      { role: "user", content: "read README" },
    ]
    const stored = computeMessageHashes(initialMessages)
    expect(stored.length).toBe(1)

    // Round 1 (continuation): [user0, assistantA(tool_use), user1(tool_result)]
    const round1 = [
      { role: "user", content: "read README" },
      { role: "assistant", content: [{ type: "tool_use", id: "tu_1", name: "Read", input: { path: "README" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_1", content: "readme text" }] },
    ]
    const prior1 = computeMessageHashes(round1.slice(0, -1))
    const overlap1 = measurePrefixOverlap(stored, prior1)
    expect(overlap1).toBe(stored.length)

    // After accepting, we refresh the stored baseline to prior1 (simulating
    // blockingStream.ts on continuation).
    const refreshed = prior1

    // Round 2 (next continuation): [user0, assistantA, user1, assistantB, user2]
    const round2 = [
      ...round1,
      { role: "assistant", content: [{ type: "tool_use", id: "tu_2", name: "Edit", input: { path: "README" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_2", content: "ok" }] },
    ]
    const prior2 = computeMessageHashes(round2.slice(0, -1))
    const overlap2 = measurePrefixOverlap(refreshed, prior2)
    expect(overlap2).toBe(refreshed.length)
  })

  it("modified-history (client tampered with user0) fails overlap", () => {
    const initialMessages = [{ role: "user", content: "original" }]
    const stored = computeMessageHashes(initialMessages)

    const tampered = [
      { role: "user", content: "edited" },
      { role: "assistant", content: [{ type: "tool_use", id: "tu_1", name: "Read", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_1", content: "r" }] },
    ]
    const prior = computeMessageHashes(tampered.slice(0, -1))
    const overlap = measurePrefixOverlap(stored, prior)
    expect(overlap).toBe(0)
  })
})
