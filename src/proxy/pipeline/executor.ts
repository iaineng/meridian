/**
 * Streaming / non-streaming dispatch entrypoints.
 *
 * Both paths delegate to the blocking-MCP pipeline — meridian only ships
 * that one execution mode.
 */

import type { SharedRequestContext } from "./context"
import type { HandlerContext } from "../handlers/types"
import type { HookBundle } from "./hooks"
import type { PromptBundle } from "./prompt"

export interface ExecutorEnv {
  claudeExecutable: string
  requestStartAt: number
}

export async function runNonStream(
  shared: SharedRequestContext,
  handler: HandlerContext,
  promptBundle: PromptBundle,
  hooks: HookBundle,
  env: ExecutorEnv,
): Promise<Response> {
  const { runBlockingNonStream } = require("./blockingStream") as typeof import("./blockingStream")
  return runBlockingNonStream(shared, handler, promptBundle, hooks, env)
}

export function runStream(
  shared: SharedRequestContext,
  handler: HandlerContext,
  promptBundle: PromptBundle,
  hooks: HookBundle,
  env: ExecutorEnv,
): Response {
  const { runBlockingStream } = require("./blockingStream") as typeof import("./blockingStream")
  return runBlockingStream(shared, handler, promptBundle, hooks, env)
}
