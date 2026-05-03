/**
 * SDK built-in tool blocking lists.
 *
 * Meridian runs in passthrough mode: every tool the client sends is
 * forwarded back through a dynamic MCP server for the client to execute.
 * The lists below tell the SDK which of its built-ins to block so the
 * model never tries to call them — either because the client provides a
 * better equivalent, or because they are Claude Code-only mechanisms with
 * no generic counterpart.
 */

/**
 * SDK built-in file/tool implementations. Blocked so the model uses the
 * client's MCP-forwarded equivalents (which match the client's tool
 * naming and parameter shape).
 */
export const BLOCKED_BUILTIN_TOOLS = [
  "Read", "Write", "Edit", "MultiEdit",
  "Bash", "Glob", "Grep", "NotebookEdit",
  "WebFetch", "WebSearch", "TodoWrite",
  "RemoteTrigger", "Monitor", "ScheduleWakeup",
  "PushNotification",
]

/**
 * Claude Code SDK tools that have no generic equivalent. Blocked because
 * a Claude Code-only mechanism would be a no-op for any other client.
 */
export const CLAUDE_CODE_ONLY_TOOLS = [
  "ToolSearch",        // Claude Code deferred tool loading (internal mechanism)
  "CronCreate",        // Claude Code cron jobs
  "CronDelete",
  "CronList",
  "EnterPlanMode",     // Claude Code mode switching
  "ExitPlanMode",
  "EnterWorktree",     // Claude Code git worktree management
  "ExitWorktree",
  "NotebookEdit",      // Jupyter notebook editing
  "TodoWrite",
  "AskUserQuestion",
  "Skill",
  "Agent",
  "TaskOutput",
  "TaskStop",
  "WebSearch",
]
