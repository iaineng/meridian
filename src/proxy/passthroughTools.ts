/**
 * Dynamic MCP tool registration for passthrough mode.
 *
 * In passthrough mode, OpenCode's tools need to be real callable tools
 * (not just text descriptions in the prompt). We create an MCP server
 * that registers each tool from OpenCode's request with the exact
 * name and schema, so Claude generates proper tool_use blocks.
 *
 * Tool handlers are no-ops — the PreToolUse hook blocks execution.
 * We just need the definitions so Claude can call them.
 */

import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk"
import { z } from "zod"
import type {
  BlockingSessionState,
  CallToolResult,
  PendingTool,
  ToolUseBinding,
  BindingSlot,
  Deferred,
} from "./session/blockingPool"
import { defer } from "./session/blockingPool"
import { claudeLog } from "../logger"

export const PASSTHROUGH_MCP_NAME = "tools"
export const PASSTHROUGH_MCP_PREFIX = `mcp__${PASSTHROUGH_MCP_NAME}__`

/**
 * Convert a JSON Schema object to a Zod schema (simplified).
 * Handles the common types OpenCode sends. Falls back to z.any() for complex types.
 */
function jsonSchemaToZod(schema: any): z.ZodTypeAny {
  if (!schema || typeof schema !== "object") return z.any()

  if (schema.type === "string") {
    let s = z.string()
    if (schema.description) s = s.describe(schema.description)
    if (schema.enum) return z.enum(schema.enum as [string, ...string[]])
    return s
  }
  if (schema.type === "number" || schema.type === "integer") {
    let n = z.number()
    if (schema.description) n = n.describe(schema.description)
    return n
  }
  if (schema.type === "boolean") return z.boolean()
  if (schema.type === "array") {
    const items = schema.items ? jsonSchemaToZod(schema.items) : z.any()
    return z.array(items)
  }
  if (schema.type === "object" && schema.properties) {
    const shape: Record<string, z.ZodTypeAny> = {}
    const required = new Set(schema.required || [])
    for (const [key, propSchema] of Object.entries(schema.properties)) {
      const zodProp = jsonSchemaToZod(propSchema as any)
      shape[key] = required.has(key) ? zodProp : zodProp.optional()
    }
    return z.object(shape)
  }

  return z.any()
}

/**
 * Create an MCP server with tool definitions matching OpenCode's request.
 */
export function createPassthroughMcpServer(
  tools: Array<{ name: string; description?: string; input_schema?: any }>
) {
  const server = createSdkMcpServer({ name: PASSTHROUGH_MCP_NAME })
  const toolNames: string[] = []

  for (const tool of tools) {
    try {
      // Convert OpenCode's JSON Schema to Zod for MCP registration
      const zodSchema = tool.input_schema?.properties
        ? jsonSchemaToZod(tool.input_schema)
        : z.object({})

      // The raw shape for the tool() call needs to be a record of Zod types
      const shape: Record<string, z.ZodTypeAny> =
        zodSchema instanceof z.ZodObject
          ? (zodSchema as any).shape
          : { input: z.any() }

      server.instance.tool(
        tool.name,
        tool.description || tool.name,
        shape,
        async () => ({ content: [{ type: "text" as const, text: "passthrough" }] })
      )
      toolNames.push(`${PASSTHROUGH_MCP_PREFIX}${tool.name}`)
    } catch {
      // If schema conversion fails, register with permissive schema
      server.instance.tool(
        tool.name,
        tool.description || tool.name,
        { input: z.string().optional() },
        async () => ({ content: [{ type: "text" as const, text: "passthrough" }] })
      )
      toolNames.push(`${PASSTHROUGH_MCP_PREFIX}${tool.name}`)
    }
  }

  return { server, toolNames }
}

/**
 * Strip the MCP prefix from a tool name to get the OpenCode tool name.
 * e.g., "mcp__oc__todowrite" → "todowrite"
 */
export function stripMcpPrefix(toolName: string): string {
  if (toolName.startsWith(PASSTHROUGH_MCP_PREFIX)) {
    return toolName.slice(PASSTHROUGH_MCP_PREFIX.length)
  }
  return toolName
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
 * Safe to call from either edge: `translateBlockingMessage` calls it when
 * the `message_delta` arrives; the MCP handler calls it after registering
 * its `PendingTool`. Whichever edge is last wins.
 */
export function maybeCloseRound(state: BlockingSessionState): void {
  if (state.status === "terminated") return
  const gate = state.pendingRoundClose
  if (!gate) return
  for (const id of gate.expectedIds) {
    if (!state.pendingTools.has(id)) return
  }
  state.pendingRoundClose = null
  state.status = "awaiting_results"
  const sink = state.activeSink
  const evt = { kind: "close_round" as const, stopReason: "tool_use" as const }
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
 * This uses the SDK's `tool()` helper + `createSdkMcpServer({ tools: [...] })`
 * predeclared form (rather than `.instance.tool()`), which is the recommended
 * path for tools carrying annotations.
 */
export function createBlockingPassthroughMcpServer(
  tools: Array<{ name: string; description?: string; input_schema?: any }>,
  state: BlockingSessionState,
) {
  // Lazy-require `tool` so test suites that mock `@anthropic-ai/claude-agent-sdk`
  // do not need to stub it — the mock replaces the module object at eval time
  // and static imports of un-stubbed names fail at link time.
  const sdk = require("@anthropic-ai/claude-agent-sdk") as { tool: (...args: any[]) => any }
  const makeTool = sdk.tool
  const toolNames: string[] = []
  const defs: any[] = []

  for (const t of tools) {
    const mcpToolName = t.name
    const clientToolName = t.name
    let shape: Record<string, z.ZodTypeAny>
    try {
      const zodSchema = t.input_schema?.properties
        ? jsonSchemaToZod(t.input_schema)
        : z.object({})
      shape = zodSchema instanceof z.ZodObject
        ? (zodSchema as any).shape
        : { input: z.any() }
    } catch {
      shape = { input: z.string().optional() }
    }

    const handler = async (_args: unknown, _extra: unknown): Promise<CallToolResult> => {
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
    }

    defs.push(makeTool(
      mcpToolName,
      t.description || mcpToolName,
      shape,
      handler,
      { annotations: { readOnlyHint: true } },
    ))
    toolNames.push(`${PASSTHROUGH_MCP_PREFIX}${mcpToolName}`)
  }

  const server = createSdkMcpServer({
    name: PASSTHROUGH_MCP_NAME,
    tools: defs,
  })
  return { server, toolNames }
}
