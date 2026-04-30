/**
 * buildHookBundle: tool-type filtering when web_search is mixed with custom
 * passthrough tools.
 *
 * - Non-blocking passthrough: web_search is filtered out, useBuiltinWebSearch
 *   stays false (existing behaviour, preserves the maxTurns=1 contract).
 * - Blocking passthrough: web_search is filtered out of effectiveTools but
 *   useBuiltinWebSearch flips to true so the SDK's built-in tool is unblocked
 *   and available alongside the custom passthrough MCP tools.
 */

import { describe, it, expect, mock } from "bun:test"

// Stub the SDK's MCP factory before importing the module under test — the
// real factory tries to register tool handlers with a live MCP instance,
// which we don't need for filter-logic assertions.
mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  createSdkMcpServer: () => ({
    type: "sdk",
    name: "passthrough",
    instance: { tool: () => {} },
  }),
}))

const { buildHookBundle } = await import("../proxy/pipeline/hooks")
const { openCodeAdapter } = await import("../proxy/adapters/opencode")

function buildBody(tools: any[]): any {
  return { tools }
}

describe("buildHookBundle web_search filtering", () => {
  it("passthrough + mixed (custom + web_search), non-blocking → drops web_search, useBuiltinWebSearch=false", () => {
    const tools = [
      { name: "my_tool", type: "custom", description: "x", input_schema: { type: "object", properties: {} } },
      { type: "web_search_20250305" },
    ]
    const out = buildHookBundle({
      body: buildBody(tools),
      adapter: openCodeAdapter,
      sdkAgents: {},
      passthrough: true,
      blockingMode: false,
    })
    expect(out.useBuiltinWebSearch).toBe(false)
    expect(out.passthrough).toBe(true)
    expect(out.effectiveTools.length).toBe(1)
    expect(out.effectiveTools[0]?.name).toBe("my_tool")
  })

  it("passthrough + mixed (custom + web_search), blocking → keeps custom, flips useBuiltinWebSearch=true", () => {
    const tools = [
      { name: "my_tool", type: "custom", description: "x", input_schema: { type: "object", properties: {} } },
      { type: "web_search_20250305" },
    ]
    const out = buildHookBundle({
      body: buildBody(tools),
      adapter: openCodeAdapter,
      sdkAgents: {},
      passthrough: true,
      blockingMode: true,
    })
    expect(out.useBuiltinWebSearch).toBe(true)
    // Passthrough stays on so custom tools are still served via MCP.
    expect(out.passthrough).toBe(true)
    // web_search is dropped from passthrough tools (it runs as a built-in).
    expect(out.effectiveTools.length).toBe(1)
    expect(out.effectiveTools[0]?.name).toBe("my_tool")
  })

  it("passthrough + lone web_search → existing single-tool path, useBuiltinWebSearch=true and passthrough=false", () => {
    const tools = [{ type: "web_search_20250305" }]
    const out = buildHookBundle({
      body: buildBody(tools),
      adapter: openCodeAdapter,
      sdkAgents: {},
      passthrough: true,
      blockingMode: true,
    })
    expect(out.useBuiltinWebSearch).toBe(true)
    expect(out.passthrough).toBe(false)
    expect(out.effectiveTools.length).toBe(0)
  })

  it("passthrough + mixed without web_search (custom + computer_use), blocking → drops computer_use, no built-in flip", () => {
    const tools = [
      { name: "my_tool", type: "custom", description: "x", input_schema: { type: "object", properties: {} } },
      { type: "computer_20241022" },
    ]
    const out = buildHookBundle({
      body: buildBody(tools),
      adapter: openCodeAdapter,
      sdkAgents: {},
      passthrough: true,
      blockingMode: true,
    })
    expect(out.useBuiltinWebSearch).toBe(false)
    expect(out.passthrough).toBe(true)
    expect(out.effectiveTools.length).toBe(1)
    expect(out.effectiveTools[0]?.name).toBe("my_tool")
  })
})
