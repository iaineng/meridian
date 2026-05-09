/**
 * Model mapping and Claude executable resolution.
 */

import { exec as execCallback } from "child_process"
import { existsSync } from "fs"
import { promisify } from "util"

const exec = promisify(execCallback)

/**
 * Pass through the client model and append [1m] only for opus-4-6 / opus-4-7.
 * Those are the only models whose 1M context is included with Max; every other
 * model (including Sonnet 4.x) would require Extra Usage billing and is left
 * at its base tier regardless of any context-1m beta the client announces.
 */
export function resolveModel(model: string): string {
  if (model.includes("opus-4-6") || model.includes("opus-4-7")) return model + "[1m]"
  return model
}

/**
 * Strip the [1m] suffix from a model, returning the base variant.
 * Used by the executor to fall back when the 1M window is rate-limited
 * or Extra Usage is not enabled on the account.
 */
export function stripExtendedContext(model: string): string {
  return model.endsWith("[1m]") ? model.slice(0, -4) : model
}

/** Check whether a model is using extended (1M) context. */
export function hasExtendedContext(model: string): boolean {
  return model.endsWith("[1m]")
}

// --- Claude Executable Resolution ---

let cachedClaudePath: string | null = null
let cachedClaudePathPromise: Promise<string> | null = null

/**
 * Resolve the Claude executable path asynchronously (non-blocking).
 *
 * Uses a two-tier cache:
 * 1. cachedClaudePath — resolved path, returned immediately on subsequent calls
 * 2. cachedClaudePathPromise — deduplicates concurrent calls during resolution
 *
 * The promise is cleared in `finally` to allow retry on failure while
 * cachedClaudePath prevents re-resolution on success.
 *
 * Only resolves the system-installed standalone `claude` binary — the SDK's
 * bundled `cli.js` is intentionally not used (issue #203: cli.js +
 * `--permission-mode bypassPermissions` under node exits with code 1).
 */
export async function resolveClaudeExecutableAsync(): Promise<string> {
  if (cachedClaudePath) return cachedClaudePath
  if (cachedClaudePathPromise) return cachedClaudePathPromise

  cachedClaudePathPromise = (async () => {
    // System-installed claude binary (standalone — no runtime dependency).
    // Use `where` on Windows (cmd.exe has no `which`); `which` elsewhere.
    // On Windows `where` can return multiple matches (claude.cmd + claude.exe);
    // prefer .exe because the .cmd wrapper can mis-forward signals / stdio
    // when the SDK spawns it as a subprocess.
    try {
      const lookupCmd = process.platform === "win32" ? "where claude" : "which claude"
      const { stdout } = await exec(lookupCmd)
      const lines = stdout.split(/\r?\n/).map(l => l.trim()).filter(Boolean)
      const claudePath = process.platform === "win32"
        ? (lines.find(l => l.toLowerCase().endsWith(".exe")) ?? lines[0])
        : lines[0]
      if (claudePath && existsSync(claudePath)) {
        cachedClaudePath = claudePath
        return claudePath
      }
    } catch {}

    const installHint = process.platform === "win32"
      ? "irm https://claude.ai/install.ps1 | iex"
      : "curl -fsSL https://claude.ai/install.sh | bash"
    throw new Error(
      `Could not find Claude Code executable on PATH. Install the standalone \`claude\` binary (https://docs.claude.com/en/docs/claude-code/setup): ${installHint}`,
    )
  })()

  try {
    return await cachedClaudePathPromise
  } finally {
    cachedClaudePathPromise = null
  }
}

/** Reset cached path — for testing only */
export function resetCachedClaudePath(): void {
  cachedClaudePath = null
  cachedClaudePathPromise = null
}

/**
 * Check if an error is a "Controller is already closed" error.
 * This happens when the client disconnects mid-stream.
 */
export function isClosedControllerError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  return error.message.includes("Controller is already closed")
}
