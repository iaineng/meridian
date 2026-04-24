/**
 * blockingMode affects two things in buildQueryOptions:
 *   - maxTurns is set to 10_000 (instead of the usual 1 when passthrough)
 *   - options.env injects CLAUDE_CODE_STREAM_CLOSE_TIMEOUT=1800000
 */

import { describe, it, expect } from "bun:test"
import { buildQueryOptions } from "../proxy/query"
import type { AgentAdapter } from "../proxy/adapter"

const stubAdapter: AgentAdapter = {
  name: "stub",
  getSessionId: () => undefined,
  extractWorkingDirectory: () => "/tmp",
  normalizeContent: (c: any) => typeof c === "string" ? c : JSON.stringify(c),
  getBlockedBuiltinTools: () => [],
  getAgentIncompatibleTools: () => [],
  getMcpServerName: () => "opencode",
  getAllowedMcpTools: () => [],
}

function baseCtx(overrides: Partial<Parameters<typeof buildQueryOptions>[0]> = {}) {
  return {
    prompt: "hi" as string | AsyncIterable<any>,
    model: "claude-sonnet-4-5",
    workingDirectory: "/tmp",
    systemContext: "",
    claudeExecutable: "/usr/local/bin/node",
    passthrough: true,
    stream: true,
    sdkAgents: {},
    cleanEnv: {},
    isUndo: false,
    adapter: stubAdapter,
    ...overrides,
  } as Parameters<typeof buildQueryOptions>[0]
}

describe("buildQueryOptions blockingMode", () => {
  it("passthrough non-blocking → maxTurns=1 (unchanged)", () => {
    const { options } = buildQueryOptions(baseCtx({ blockingMode: false }))
    expect(options.maxTurns).toBe(1)
  })

  it("passthrough + blockingMode → maxTurns=10000", () => {
    const { options } = buildQueryOptions(baseCtx({ blockingMode: true }))
    expect(options.maxTurns).toBe(10_000)
  })

  it("non-passthrough + blockingMode → maxTurns=200 (blocking flag ignored)", () => {
    const { options } = buildQueryOptions(baseCtx({ passthrough: false, blockingMode: true }))
    expect(options.maxTurns).toBe(200)
  })

  it("blockingMode injects CLAUDE_CODE_STREAM_CLOSE_TIMEOUT=1800000", () => {
    const { options } = buildQueryOptions(baseCtx({ blockingMode: true }))
    expect(options.env?.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT).toBe("1800000")
  })

  it("non-blocking does NOT set CLAUDE_CODE_STREAM_CLOSE_TIMEOUT", () => {
    const { options } = buildQueryOptions(baseCtx({ blockingMode: false }))
    expect(options.env?.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT).toBeUndefined()
  })
})
