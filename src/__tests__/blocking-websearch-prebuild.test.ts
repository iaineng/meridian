/**
 * Regression coverage for blocking-mode MCP prebuild filtering.
 *
 * Built-in `web_search_*` tools can carry a client-facing `name` field
 * (for example `name: "web_search"`). The blocking handler prebuilds its
 * MCP server before `buildHookBundle` runs, so it must apply the same
 * filtering there or the built-in leaks into `allowedTools` as
 * `mcp__tools__web_search`.
 */

import { afterEach, beforeEach, describe, expect, mock, it } from "bun:test"

let toolCalls: Array<{ name: string }> = []

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: () => ({ [Symbol.asyncIterator]: () => ({ next: async () => ({ value: undefined, done: true }) }) }),
  createSdkMcpServer: (opts: any) => ({
    type: "sdk",
    name: opts.name,
    tools: opts.tools ?? [],
    instance: { tool: () => {} },
  }),
  tool: (name: string) => {
    toolCalls.push({ name })
    return { name }
  },
}))

mock.module("../logger", () => ({
  claudeLog: () => {},
}))

const { buildBlockingHandler } = await import("../proxy/handlers/blocking")
const { blockingPool } = await import("../proxy/session/blockingPool")
const { ephemeralSessionIdPool } = await import("../proxy/session/ephemeralPool")
const { PASSTHROUGH_MCP_PREFIX } = await import("../proxy/passthroughTools")

function makeShared(tools: any[]) {
  const messages = [{ role: "user", content: "hello" }]
  return {
    workingDirectory: "/tmp",
    allMessages: messages,
    model: "claude-sonnet-4-5",
    outputFormat: undefined,
    requestMeta: {
      requestId: "r-test",
      endpoint: "/v1/messages",
      queueEnteredAt: 0,
      queueStartedAt: 0,
    },
    agentSessionId: "s-test",
    body: { messages, tools },
    initialPassthrough: true,
  } as any
}

describe("blocking web_search prebuild filtering", () => {
  beforeEach(async () => {
    toolCalls = []
    ephemeralSessionIdPool._setReuseDelay(0)
    await blockingPool._reset()
  })

  afterEach(async () => {
    await blockingPool._reset()
    ephemeralSessionIdPool._reset()
  })

  it("does not register named web_search as a passthrough MCP tool when mixed with custom tools", async () => {
    const handler = await buildBlockingHandler(makeShared([
      { name: "my_tool", type: "custom", description: "x", input_schema: { type: "object", properties: {} } },
      { type: "web_search_20260209", name: "web_search", max_uses: 5 },
    ]))

    expect(toolCalls.map((c) => c.name)).toEqual(["my-tool"])
    expect(handler.prebuiltPassthroughMcp?.toolNames).toEqual([
      `${PASSTHROUGH_MCP_PREFIX}my-tool`,
    ])
    expect(handler.prebuiltPassthroughMcp?.toolNames).not.toContain(
      `${PASSTHROUGH_MCP_PREFIX}web-search`,
    )
  })

  it("does not prebuild an MCP server for lone named web_search", async () => {
    const handler = await buildBlockingHandler(makeShared([
      { type: "web_search_20260209", name: "web_search", max_uses: 5 },
    ]))

    expect(toolCalls).toEqual([])
    expect(handler.prebuiltPassthroughMcp).toBeUndefined()
  })
})
