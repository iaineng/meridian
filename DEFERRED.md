# Deferred Items

Items identified during architectural refactor planning that are intentionally deferred to separate PRs.

## Tooling & Config
1. **Biome linting/formatting** — Add with clean project-specific config (not copy-pasted). Separate PR.
2. **Dependency classification fix** — Move `hono`, `@hono/node-server` from devDeps to production deps.
3. **Docker directory reorganization** — Move Docker files to `docker/`. Needs migration docs.
4. **`src/index.ts` barrel export** — Single entry point for npm consumers. Needs backwards-compat analysis.

## Deprecation Paths
5. **`bin/oc.sh` deprecation** — Evaluate whether to deprecate. Needs user communication first.
6. **`claude-max-headers.ts` plugin deprecation** — Needs migration path for users who have it configured.

## Feature Enhancements
7. **`prepareMessages` / prompt builder extraction** — Centralize Anthropic messages → text prompt conversion. Fits into adapter pattern as `preparePrompt()`.
8. **`maxTurns` configurability** — Currently hardcoded to 200. Should be configurable via env var or adapter config.

## Blocking-MCP Mode (v1 limitations)

The `MERIDIAN_BLOCKING_MCP=1` path (see ARCHITECTURE.md) intentionally does not yet cover the following. All of these currently trigger a silent fallback to the plain ephemeral+passthrough path (synthetic filler / continue).

9. **`outputFormat` / StructuredOutput compatibility** — the synthetic-prompt contract (`STRUCTURED_OUTPUT_STRICT_PROMPT`, `STRUCTURED_OUTPUT_CONDITIONAL_PROMPT`) is not integrated with the blocking pipeline; blocking is disabled whenever `output_config.format` is set.
10. **Sub-agent (`Task`) nested `stream_event`s** — the SDK emits `parent_tool_use_id` for sub-agent output; `state.sdkToClientIndex` is SDK-turn-scoped and has not been validated against sub-agent interleaving. Needs an experiment before enabling.
11. **`max_tokens` across blocking rounds** — SDK `message_delta.stop_reason === "max_tokens"` is forwarded as-is and terminates the session. No recovery / continuation semantics yet.
12. **Partial `tool_result` submission (batched)** — v1 rejects any mismatch between pending tool_use ids and incoming tool_result ids with 400. If clients need to stream results back in batches, this must become a first-class mode.
13. **Per-`pendingTool` timeout** — currently the 30-min timeout is per-session. A single slow tool silently monopolises the budget; per-tool deadlines would allow the slow one to be aborted independently.
14. **Strict message-id consistency** — each HTTP issues a new `msg_<id>`. Clients that hash the `id` for dedup would need a mode that reuses the logical id across rounds.
