/**
 * Dynamic MCP tool registration for passthrough mode.
 *
 * The client's tools need to be real callable tools (not just text
 * descriptions in the prompt). We create an MCP server that registers
 * each tool from the request with a normalised kebab-case MCP name and
 * the original schema, so Claude generates proper tool_use blocks while
 * the client still receives its original tool names.
 *
 * In blocking mode the handler suspends on a Promise until the next HTTP
 * round delivers a matching tool_result.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js"
import {
  PASSTHROUGH_MCP_NAME,
  PASSTHROUGH_MCP_PREFIX,
  normalizePassthroughMcpToolName,
  resolvePassthroughClientToolName,
  stripPassthroughMcpPrefix,
  toPassthroughMcpFullToolName,
} from "./passthroughToolNames"
import type {
  BlockingSessionState,
  CallToolResult,
  PendingTool,
  ToolUseBinding,
  BindingSlot,
} from "./session/blockingPool"
import { defer } from "./session/blockingPool"
import { claudeLog } from "../logger"

export {
  PASSTHROUGH_MCP_NAME,
  PASSTHROUGH_MCP_PREFIX,
  normalizePassthroughMcpToolName,
  resolvePassthroughClientToolName,
  toPassthroughMcpFullToolName,
}

type ClientTool = { name: string; description?: string; input_schema?: any }
type PassthroughHandler = (
  mcpToolName: string,
  clientToolName: string,
  args: unknown,
) => Promise<CallToolResult>

function cloneJson<T>(value: T): T {
  return value == null ? value : JSON.parse(JSON.stringify(value))
}

function normalizeMcpInputSchema(schema: any): Tool["inputSchema"] {
  if (!schema || typeof schema !== "object" || schema.type !== "object") {
    return { type: "object", properties: {} }
  }
  return cloneJson(schema)
}

function createRawPassthroughMcpServer(
  tools: ClientTool[],
  handleToolCall: PassthroughHandler,
  options?: { annotations?: Tool["annotations"] },
) {
  const instance = new McpServer(
    { name: PASSTHROUGH_MCP_NAME, version: "1.0.0" },
    { capabilities: { tools: { listChanged: true } } },
  )
  const server = { type: "sdk" as const, name: PASSTHROUGH_MCP_NAME, instance }
  const toolNames: string[] = []
  const clientNameByMcpToolName = new Map<string, string>()
  const clientNameByFullToolName = new Map<string, string>()
  const listedTools: Tool[] = []

  for (const tool of tools) {
    const mcpToolName = normalizePassthroughMcpToolName(tool.name)
    const fullToolName = toPassthroughMcpFullToolName(tool.name)
    clientNameByMcpToolName.set(mcpToolName, tool.name)
    clientNameByFullToolName.set(fullToolName, tool.name)
    toolNames.push(fullToolName)
    listedTools.push({
      name: mcpToolName,
      ...(tool.description ? { description: tool.description } : {}),
      inputSchema: normalizeMcpInputSchema(tool.input_schema),
      execution: { taskSupport: "forbidden" },
      ...(options?.annotations ? { annotations: options.annotations } : {}),
    })
  }

  instance.server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: cloneJson(listedTools),
  }))
  instance.server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const toolName = request.params.name
    const clientToolName = clientNameByMcpToolName.get(toolName)
    if (!clientToolName) {
      return { content: [{ type: "text", text: `Tool ${toolName} not found` }], isError: true }
    }
    return await handleToolCall(toolName, clientToolName, request.params.arguments ?? {})
  })

  return { server, toolNames, clientNameByMcpToolName, clientNameByFullToolName }
}

/**
 * Create an MCP server with tool definitions matching the client's request.
 */
export function createPassthroughMcpServer(tools: ClientTool[]) {
  return createRawPassthroughMcpServer(
    tools,
    async () => ({ content: [{ type: "text", text: "passthrough" }] }),
  )
}

/**
 * Strip the MCP prefix from a tool name to get the client tool name.
 * e.g., "mcp__oc__todowrite" → "todowrite"
 */
export function stripMcpPrefix(toolName: string): string {
  return stripPassthroughMcpPrefix(toolName)
}

/**
 * Two-gate round closer for blocking sessions. Fires a `close_round` event
 * exactly once per turn, when both of the following hold:
 *   1. The API has emitted `message_delta(stop_reason:"tool_use")` for the
 *      current turn (captured into `state.pendingRoundClose.expectedIds` by
 *      `translateBlockingMessage`).
 *   2. Every expected `tool_use_id` is present in `state.pendingTools` —
 *      i.e. every handler has entered and registered its resolver.
 *
 * Safe to call from either edge: the consumer calls it after translating a
 * `message_delta`, and the MCP handler calls it after registering its
 * `PendingTool`. Whichever edge is last wins.
 */
export function maybeCloseRound(state: BlockingSessionState): void {
  if (state.status === "terminated") return
  const gate = state.pendingRoundClose
  if (!gate) return
  for (const id of gate.expectedIds) {
    if (!state.pendingTools.has(id)) return
  }
  const frames = gate.frames
  state.pendingRoundClose = null
  state.status = "awaiting_results"
  // The current round is over — the next time the SDK iterator emits a
  // `message_start` (after the client returns tool_results in the next
  // HTTP), it should be treated as the FIRST message_start of the new
  // round and forwarded to the client.  The merged-message index counter
  // and per-turn SDK→client map also reset here so the next round's first
  // content block starts at index 0 and the per-turn 0-based SDK indices
  // remap cleanly into a fresh sequence.
  state.messageStartEmittedThisRound = false
  state.nextClientBlockIndex = 0
  state.sdkToClientIndex.clear()
  state.webSearchSkipIndices.clear()
  state.structuredOutputIndices.clear()
  state.outputFormatTextSkipIndices.clear()
  state.outputFormatLastDelta = undefined
  state.outputFormatTerminalForwarded = false
  const sink = state.activeSink
  const evt = { kind: "close_round" as const, stopReason: "tool_use" as const, frames }
  if (sink) sink(evt)
  else state.eventBuffer.push(evt)
}

function getOrInitSlot(state: BlockingSessionState, toolName: string): BindingSlot {
  let slot = state.bindingsByToolName.get(toolName)
  if (!slot) {
    slot = { bindings: [], waiters: [] }
    state.bindingsByToolName.set(toolName, slot)
  }
  return slot
}

function consumeBinding(state: BlockingSessionState, toolName: string): Promise<ToolUseBinding> {
  const slot = getOrInitSlot(state, toolName)
  const head = slot.bindings.shift()
  if (head) return head.promise
  const waiter = defer<ToolUseBinding>()
  slot.waiters.push(waiter)
  return waiter.promise
}

/**
 * Producer side: called by the consumer task when it observes a tool_use
 * `content_block_start` event. Pairs with the next handler entry for the
 * same tool name.
 */
export function registerToolUseBinding(
  state: BlockingSessionState,
  toolName: string,
  binding: ToolUseBinding,
): void {
  const slot = getOrInitSlot(state, toolName)
  const waiter = slot.waiters.shift()
  if (waiter) {
    waiter.resolve(binding)
    return
  }
  const d = defer<ToolUseBinding>()
  d.resolve(binding)
  slot.bindings.push(d)
}

/**
 * Blocking-mode MCP server: every tool handler returns a suspended Promise
 * that only resolves when the client returns a matching `tool_result`. Each
 * tool definition carries `annotations: { readOnlyHint: true }` so the
 * Anthropic API treats them as safe to interleave with thinking.
 *
 * We implement the public MCP `tools/list` / `tools/call` handlers directly
 * so the client's JSON Schema is exposed verbatim, including nested
 * `description` fields that Zod-based registration may otherwise drop.
 */
export function createBlockingPassthroughMcpServer(
  tools: ClientTool[],
  state: BlockingSessionState,
) {
  const passthrough = createRawPassthroughMcpServer(
    tools,
    async (mcpToolName, clientToolName): Promise<CallToolResult> => {
      if (state.status === "terminated") {
        return { content: [{ type: "text", text: "blocking session terminated" }], isError: true }
      }
      // Pair with the matching stream_event tool_use_id.
      let binding: ToolUseBinding
      try {
        binding = await consumeBinding(state, mcpToolName)
      } catch (e) {
        return {
          content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }],
          isError: true,
        }
      }
      const { toolUseId, input } = binding

      // Create the outer suspended Promise — resolved by the next HTTP
      // request's tool_result handoff (see blockingStream.ts). After
      // registering the PendingTool, call `maybeCloseRound` to check the
      // two-gate close condition (API stop_reason + all handlers entered).
      return await new Promise<CallToolResult>((resolve, reject) => {
        const pending: PendingTool = {
          mcpToolName,
          clientToolName,
          toolUseId,
          input,
          resolve,
          reject,
          startedAt: Date.now(),
        }
        state.pendingTools.set(toolUseId, pending)
        state.currentRoundToolIds.push(toolUseId)
        claudeLog("blocking.handler.entered", {
          toolUseId,
          tool: clientToolName,
          pending: state.pendingTools.size,
        })
        maybeCloseRound(state)
      })
    },
    { annotations: { readOnlyHint: true } },
  )

  state.clientNameByMcpToolName = passthrough.clientNameByMcpToolName
  state.clientNameByFullToolName = passthrough.clientNameByFullToolName

  return passthrough
}
