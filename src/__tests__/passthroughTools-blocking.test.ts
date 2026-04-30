/**
 * Unit tests for createBlockingPassthroughMcpServer.
 *
 * Verifies:
 *  - every tool definition carries `annotations: { readOnlyHint: true }`
 *  - `registerToolUseBinding` + handler rendezvous (both producer-first and
 *    handler-first orderings)
 *  - handler returns a Promise that only resolves when the matching
 *    PendingTool's resolver is called
 */

import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test"

// Capture the `tool()` calls. The blocking server uses the SDK's `tool()`
// helper which is require()'d at call-time, so the mock must be installed
// before the function is invoked.
let toolCalls: Array<{ name: string; description: string; shape: unknown; handler: Function; extras: any }> = []
mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  createSdkMcpServer: (opts: any) => ({ type: "sdk", name: opts.name, instance: {}, tools: opts.tools ?? [] }),
  tool: (name: string, description: string, shape: any, handler: Function, extras?: any) => {
    toolCalls.push({ name, description, shape, handler, extras })
    return { name, description, shape, handler, extras }
  },
  // blockingStream imports `query` statically; stub it so module linking
  // succeeds (translateBlockingMessage never calls it).
  query: () => ({ [Symbol.asyncIterator]: () => ({ next: async () => ({ value: undefined, done: true }) }) }),
}))

// Import lazily so the mock is in place.
const {
  createBlockingPassthroughMcpServer,
  registerToolUseBinding,
  maybeCloseRound,
  PASSTHROUGH_MCP_PREFIX,
  normalizePassthroughMcpToolName,
  toPassthroughMcpFullToolName,
  resolvePassthroughClientToolName,
} = await import("../proxy/passthroughTools")
const { blockingPool } = await import("../proxy/session/blockingPool")
const { translateBlockingMessage } = await import("../proxy/pipeline/blockingStream")

describe("createBlockingPassthroughMcpServer", () => {
  beforeEach(async () => {
    toolCalls = []
    await blockingPool._reset()
  })
  afterEach(async () => {
    await blockingPool._reset()
  })

  function makeState() {
    const state = blockingPool.acquire(
      { kind: "header", value: "s-test" },
      {
        key: { kind: "header", value: "s-test" },
        ephemeralSessionId: "00000000-0000-0000-0000-000000000000",
        workingDirectory: "/tmp",
        priorMessageHashes: ["h0"],
        cleanup: async () => {},
      },
    )
    return state
  }

  it("normalises arbitrary client tool names to kebab-case MCP names", () => {
    expect(normalizePassthroughMcpToolName("Read")).toBe("read")
    expect(normalizePassthroughMcpToolName("DoSomething")).toBe("do-something")
    expect(normalizePassthroughMcpToolName("mcp__plugin_context7_context7__query-docs")).toBe(
      "plugin-context7-context7-query-docs",
    )
    expect(toPassthroughMcpFullToolName("mcp__plugin_context7_context7__query-docs")).toBe(
      "mcp__tools__plugin-context7-context7-query-docs",
    )
  })

  it("maps normalised MCP names back to original client names", () => {
    const state = makeState()
    const result = createBlockingPassthroughMcpServer([{ name: "DoSomething" }], state)
    expect(resolvePassthroughClientToolName("mcp__tools__do-something", result)).toBe("DoSomething")
    expect(resolvePassthroughClientToolName("do-something", result)).toBe("DoSomething")
  })

  it("registers every tool with annotations.readOnlyHint=true", () => {
    const state = makeState()
    const tools = [
      { name: "Read", description: "read file", input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
      { name: "Write", description: "write file", input_schema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } } } },
    ]
    createBlockingPassthroughMcpServer(tools, state)
    expect(toolCalls.length).toBe(2)
    for (const c of toolCalls) {
      expect(c.extras?.annotations?.readOnlyHint).toBe(true)
    }
  })

  it("producer-first: registerToolUseBinding then handler invocation", async () => {
    const state = makeState()
    createBlockingPassthroughMcpServer([{ name: "Read" }], state)
    const handler = toolCalls[0]!.handler

    // Producer registers a binding first.
    registerToolUseBinding(state, "read", { toolUseId: "tu_A", input: { path: "/etc/hosts" } })

    // Handler is then called; wait a tick so it suspends on the outer Promise.
    const resultPromise = handler({}, {})
    await new Promise(r => setTimeout(r, 5))

    // PendingTool should have been registered with the same id.
    const pending = state.pendingTools.get("tu_A")
    expect(pending).toBeDefined()
    expect(pending!.clientToolName).toBe("Read")

    // Resolve the outer Promise via the pending tool.
    pending!.resolve({ content: [{ type: "text", text: "hosts file" }] })
    const res = await resultPromise
    expect((res as any).content[0].text).toBe("hosts file")
  })

  it("handler-first: handler invocation then registerToolUseBinding", async () => {
    const state = makeState()
    createBlockingPassthroughMcpServer([{ name: "Read" }], state)
    const handler = toolCalls[0]!.handler

    // Handler starts first; it will block on consumeBinding.
    const resultPromise = handler({}, {})

    // Yield so consumeBinding queues a waiter.
    await new Promise(r => setTimeout(r, 5))
    expect(state.pendingTools.size).toBe(0)

    // Producer now arrives with the id.
    registerToolUseBinding(state, "read", { toolUseId: "tu_B", input: {} })
    await new Promise(r => setTimeout(r, 5))

    // PendingTool should now exist.
    const pending = state.pendingTools.get("tu_B")
    expect(pending).toBeDefined()

    pending!.resolve({ content: [{ type: "text", text: "ok" }] })
    const res = await resultPromise
    expect((res as any).content[0].text).toBe("ok")
  })

  it("terminated session: handler returns an error result immediately", async () => {
    const state = makeState()
    createBlockingPassthroughMcpServer([{ name: "Read" }], state)
    const handler = toolCalls[0]!.handler
    state.status = "terminated"
    const res = await handler({}, {})
    expect((res as any).isError).toBe(true)
  })

  it("toolNames are returned with the mcp__tools__ prefix and kebab-case names", () => {
    const state = makeState()
    const result = createBlockingPassthroughMcpServer([{ name: "Read" }, { name: "DoSomething" }], state)
    expect(result.toolNames).toEqual([
      `${PASSTHROUGH_MCP_PREFIX}read`,
      `${PASSTHROUGH_MCP_PREFIX}do-something`,
    ])
    expect(toolCalls.map((c) => c.name)).toEqual(["read", "do-something"])
  })

  // Regression: translateBlockingMessage must strip the PASSTHROUGH_MCP_PREFIX
  // from block.name before registering a binding. The handler's consumeBinding
  // looks up by the un-prefixed OpenCode tool name; if the producer registers
  // under the prefixed SDK name, consumeBinding hangs forever, which strands
  // the round closer (maybeCloseRound never sees pendingTools filled) and
  // leaves the HTTP stream hung after the tool_use's content_block_stop.
  it("translateBlockingMessage: tool_use start registers binding under un-prefixed name", () => {
    const state = makeState()
    const encoder = new TextEncoder()
    translateBlockingMessage(
      {
        type: "stream_event",
        event: {
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", id: "tu_1", name: `${PASSTHROUGH_MCP_PREFIX}read`, input: {} },
        },
      },
      state,
      encoder,
    )
    expect(state.bindingsByToolName.has("read")).toBe(true)
    expect(state.bindingsByToolName.has(`${PASSTHROUGH_MCP_PREFIX}read`)).toBe(false)
  })

  it("translateBlockingMessage + handler: prefixed stream event resolves handler", async () => {
    const state = makeState()
    createBlockingPassthroughMcpServer([{ name: "Read" }], state)
    const handler = toolCalls[0]!.handler
    const encoder = new TextEncoder()

    // Producer path: SDK emits tool_use with the full MCP-prefixed name.
    translateBlockingMessage(
      {
        type: "stream_event",
        event: {
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", id: "tu_X", name: `${PASSTHROUGH_MCP_PREFIX}read`, input: {} },
        },
      },
      state,
      encoder,
    )

    // Handler is then invoked by the SDK — must rendezvous with the binding
    // above and register a PendingTool under the SAME tool_use_id.
    const resultPromise = handler({}, {})
    await new Promise(r => setTimeout(r, 5))

    const pending = state.pendingTools.get("tu_X")
    expect(pending).toBeDefined()
    pending!.resolve({ content: [{ type: "text", text: "ok" }] })
    const res = await resultPromise
    expect((res as any).content[0].text).toBe("ok")
  })

  // Two-gate close semantics: close_round fires iff BOTH the API emitted
  // message_delta(stop_reason:"tool_use") AND every expected handler entered.
  describe("maybeCloseRound (two-gate close)", () => {
    it("no-op when pendingRoundClose is unset (API hasn't signalled tool_use yet)", () => {
      const state = makeState()
      state.pendingTools.set("tu_1", {
        mcpToolName: "read", clientToolName: "Read", toolUseId: "tu_1",
        input: {}, resolve: () => {}, reject: () => {}, startedAt: Date.now(),
      })
      const seen: any[] = []
      state.activeSink = (evt) => seen.push(evt)
      maybeCloseRound(state)
      expect(seen).toEqual([])
      expect(state.status).toBe("streaming")
    })

    it("waits when message_delta seen but pendingTools not yet covered", () => {
      const state = makeState()
      state.pendingRoundClose = { expectedIds: new Set(["tu_1", "tu_2"]) }
      state.pendingTools.set("tu_1", {
        mcpToolName: "read", clientToolName: "Read", toolUseId: "tu_1",
        input: {}, resolve: () => {}, reject: () => {}, startedAt: Date.now(),
      })
      // tu_2 handler hasn't entered yet.
      const seen: any[] = []
      state.activeSink = (evt) => seen.push(evt)
      maybeCloseRound(state)
      expect(seen).toEqual([])
      expect(state.pendingRoundClose).not.toBeNull()
    })

    it("fires close_round when both gates met and clears pendingRoundClose", () => {
      const state = makeState()
      state.pendingRoundClose = { expectedIds: new Set(["tu_1", "tu_2"]) }
      state.pendingTools.set("tu_1", {
        mcpToolName: "read", clientToolName: "Read", toolUseId: "tu_1",
        input: {}, resolve: () => {}, reject: () => {}, startedAt: Date.now(),
      })
      state.pendingTools.set("tu_2", {
        mcpToolName: "edit", clientToolName: "Edit", toolUseId: "tu_2",
        input: {}, resolve: () => {}, reject: () => {}, startedAt: Date.now(),
      })
      const seen: any[] = []
      state.activeSink = (evt) => seen.push(evt)
      maybeCloseRound(state)
      expect(seen).toEqual([{ kind: "close_round", stopReason: "tool_use" }])
      expect(state.pendingRoundClose).toBeNull()
      expect(state.status).toBe("awaiting_results")
    })

    it("falls back to eventBuffer when no sink is attached", () => {
      const state = makeState()
      state.pendingRoundClose = { expectedIds: new Set(["tu_1"]) }
      state.pendingTools.set("tu_1", {
        mcpToolName: "read", clientToolName: "Read", toolUseId: "tu_1",
        input: {}, resolve: () => {}, reject: () => {}, startedAt: Date.now(),
      })
      state.activeSink = null
      maybeCloseRound(state)
      expect(state.eventBuffer).toEqual([{ kind: "close_round", stopReason: "tool_use" }])
    })

    it("no-op when session is terminated", () => {
      const state = makeState()
      state.pendingRoundClose = { expectedIds: new Set(["tu_1"]) }
      state.pendingTools.set("tu_1", {
        mcpToolName: "read", clientToolName: "Read", toolUseId: "tu_1",
        input: {}, resolve: () => {}, reject: () => {}, startedAt: Date.now(),
      })
      state.status = "terminated"
      const seen: any[] = []
      state.activeSink = (evt) => seen.push(evt)
      maybeCloseRound(state)
      expect(seen).toEqual([])
    })
  })

  // End-to-end: simulate the stream-event + handler-entry timeline and check
  // close_round fires exactly once, at the right moment.
  it("E2E: message_delta arrives BEFORE all handlers — close fires on last handler", async () => {
    const state = makeState()
    createBlockingPassthroughMcpServer([{ name: "Read" }, { name: "Edit" }], state)
    const readHandler = toolCalls[0]!.handler
    const editHandler = toolCalls[1]!.handler
    const encoder = new TextEncoder()
    const seen: any[] = []
    state.activeSink = (evt) => seen.push(evt)

    // Stream: two tool_use blocks.
    translateBlockingMessage({
      type: "stream_event",
      event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tu_A", name: `${PASSTHROUGH_MCP_PREFIX}read`, input: {} } },
    }, state, encoder)
    translateBlockingMessage({
      type: "stream_event",
      event: { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "tu_B", name: `${PASSTHROUGH_MCP_PREFIX}edit`, input: {} } },
    }, state, encoder)

    // API signals end-of-turn with stop_reason tool_use — arms the gate.
    translateBlockingMessage({
      type: "stream_event",
      event: { type: "message_delta", delta: { stop_reason: "tool_use" } },
    }, state, encoder)
    // Neither handler has entered yet → gate armed but not satisfied.
    expect(seen.filter(e => e.kind === "close_round")).toEqual([])
    expect(state.pendingRoundClose).not.toBeNull()

    // Handler A enters: partial coverage → still no close.
    const resA = readHandler({}, {})
    await new Promise(r => setTimeout(r, 5))
    expect(seen.filter(e => e.kind === "close_round")).toEqual([])

    // Handler B enters: full coverage → close_round fires exactly once.
    const resB = editHandler({}, {})
    await new Promise(r => setTimeout(r, 5))
    expect(seen.filter(e => e.kind === "close_round")).toEqual([
      { kind: "close_round", stopReason: "tool_use" },
    ])
    expect(state.pendingRoundClose).toBeNull()

    // Cleanup: resolve pending handlers so promises don't leak.
    state.pendingTools.get("tu_A")!.resolve({ content: [{ type: "text", text: "a" }] })
    state.pendingTools.get("tu_B")!.resolve({ content: [{ type: "text", text: "b" }] })
    await resA
    await resB
  })

  it("E2E: all handlers enter BEFORE message_delta — caller closes round after pushing frames", async () => {
    const state = makeState()
    createBlockingPassthroughMcpServer([{ name: "Read" }], state)
    const readHandler = toolCalls[0]!.handler
    const encoder = new TextEncoder()
    const seen: any[] = []
    state.activeSink = (evt) => seen.push(evt)

    translateBlockingMessage({
      type: "stream_event",
      event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tu_A", name: `${PASSTHROUGH_MCP_PREFIX}read`, input: {} } },
    }, state, encoder)

    // Handler enters first (unusual but allowed): gate not yet armed → no close.
    const resA = readHandler({}, {})
    await new Promise(r => setTimeout(r, 5))
    expect(state.pendingTools.has("tu_A")).toBe(true)
    expect(seen.filter(e => e.kind === "close_round")).toEqual([])

    // API signals stop_reason tool_use → `translateBlockingMessage` ONLY arms
    // the gate; it must NOT push close_round synchronously because its
    // returned message_delta frame hasn't been pushed to the sink yet.
    const frames = translateBlockingMessage({
      type: "stream_event",
      event: { type: "message_delta", delta: { stop_reason: "tool_use" } },
    }, state, encoder)
    expect(seen.filter(e => e.kind === "close_round")).toEqual([])
    expect(state.pendingRoundClose).not.toBeNull()

    // Consumer-loop invariant: push the translated frames to the sink first,
    // THEN call maybeCloseRound. This preserves SSE ordering for the client.
    for (const f of frames) state.activeSink!({ kind: "sse", frame: f })
    maybeCloseRound(state)

    // Now close_round fires, and the message_delta SSE frame was delivered
    // BEFORE it (so the client sees message_delta → message_stop in this
    // same HTTP round, not leaked into the next one).
    const kinds = seen.map(e => {
      if (e.kind === "sse") {
        const text = new TextDecoder().decode(e.frame)
        const m = /^event: (\S+)/m.exec(text)
        return `sse:${m?.[1]}`
      }
      return e.kind
    })
    expect(kinds).toEqual(["sse:message_delta", "close_round"])

    state.pendingTools.get("tu_A")!.resolve({ content: [{ type: "text", text: "a" }] })
    await resA
  })

  it("E2E: stop_reason:end_turn does not fire close_round (SDK iterator will end)", () => {
    const state = makeState()
    const encoder = new TextEncoder()
    const seen: any[] = []
    state.activeSink = (evt) => seen.push(evt)

    translateBlockingMessage({
      type: "stream_event",
      event: { type: "message_delta", delta: { stop_reason: "end_turn" } },
    }, state, encoder)
    expect(seen.filter(e => e.kind === "close_round")).toEqual([])
    expect(state.pendingRoundClose).toBeNull()
  })
})
