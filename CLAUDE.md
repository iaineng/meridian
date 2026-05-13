# CLAUDE.md

Project guidelines for AI agents working in this codebase.

## What This Is

A proxy that exposes any Anthropic API client to Claude Max via the Claude Agent SDK. The proxy is agent-agnostic — it accepts the standard `POST /v1/messages` shape with optional `x-meridian-*` headers. See `ARCHITECTURE.md` for the full module map and dependency rules.

## Commands

This is a **pure-Bun project.** Bun is the only supported runtime — no Node.js installation required (or used) anywhere in the build, runtime, or VM deploy path.

```bash
bun run test     # Typecheck (tsc --noEmit)
bun run build    # Build with bun build (--target=bun) + tsc
bun start        # Start the proxy server (via claude-proxy-supervisor.sh)
```

## Code Rules

### Module Boundaries

- **Do not add code to `server.ts` that belongs in a leaf module.** If it's pure logic (no HTTP, no Hono), extract it.
- **`session/lineage.ts` must stay pure.** No side effects, no I/O, no imports from cache or server.
- **Leaf modules (`errors.ts`, `models.ts`, `tools.ts`, `messages.ts`) must not import from `server.ts` or `session/`.** Dependencies flow downward only.
- **No circular dependencies.**

### Testing

- Every extracted module must have unit tests
- Pure functions get direct unit tests (no mocks)
- Integration tests go through the HTTP layer with mocked SDK
- **All tests must pass before any change is considered complete**
- New test files go in `src/__tests__/`
- **E2E tests** are documented in [`E2E.md`](./E2E.md) — run manually before releases or after major refactors (requires Claude Max subscription)

### Style

- No `as any`, `@ts-ignore`, or `@ts-expect-error`
- No empty catch blocks
- Match existing patterns — check neighboring code before writing
- Keep `server.ts` as thin as possible — it should orchestrate, not compute

## Environment Flags (selected)

The blocking-MCP + passthrough + ephemeral-JSONL path is now the **only** path — those env switches no longer exist. The remaining knobs:

- `MERIDIAN_BLOCKING_DRIFT_NAME_ONLY=1` — Relax both the blocking-continuation drift check AND the prefix-hash lookup to ignore `tool_use` inputs (and ids), enforcing only count + per-position name equality. Escape hatch for clients that semantically rewrite tool inputs between rounds. Off by default.
- `MERIDIAN_DISABLE_BLOCKING_CONTINUE=1` — Disable the in-memory blocking continuation path. Each HTTP round behaves as a one-shot: the handler skips pool lookup for tool_result-tail requests and always rebuilds the full JSONL transcript via `prepareFreshSession`, spawning a fresh SDK iterator. As soon as `close_round` fires the live sibling is released (SDK subprocess aborted, suspended MCP handlers rejected, ephemeral UUID returned to the pool for reuse) — the proxy never waits for the client to deliver tool_results into the same iterator. Trades interleaved-thinking signature preservation and prompt-cache continuity for a simpler stateless flow. Off by default.

### Ephemeral session UUID lifecycle

- `session/ephemeralPool.ts` holds **per-profile** pools, keyed by seed: `email > setup-token > profile.id` (see `getProfileSeed` in `claudeOauthEnv.ts`). With a seed present the pool mints UUIDs deterministically via `sha256(seed || counter)`, so the JSONL paths (`<configDir>/projects/<cwd>/<uuid>.jsonl`) are stable across restarts. Without a seed it falls back to `randomUUID()`.
- Cleanup **does not delete** the JSONL. `blockingPool.release` only flips an AbortSignal and rejects pending handlers; the Claude subprocess exits asynchronously and may still hold the transcript file open. The cleanup closure therefore only calls `ephemeralSessionIdPool.release(id)`, which puts the id into a 5s quarantine. After the quarantine the id becomes acquirable again, and the next request's `writeSessionTranscript` overwrites the stale bytes via `fs.writeFile` — atomic, no race with the dying subprocess.

## Architecture Quick Reference

```
server.ts          → HTTP routes, SSE streaming, concurrency (orchestration only)
query.ts           → buildQueryOptions (shared SDK call builder, blocking-only)
errors.ts          → classifyError (pure)
models.ts          → mapModelToClaudeModel, resolveClaudeExecutableAsync
tools.ts           → BLOCKED_BUILTIN_TOOLS, CLAUDE_CODE_ONLY_TOOLS
messages.ts        → normalizeContent, getLastUserMessage (pure)
session/
  lineage.ts       → Hashing, lineage verification (PURE — no I/O)
  fingerprint.ts   → getConversationFingerprint
  blockingPool.ts  → Blocking session registry (one per logical conversation)
```

## Stable API Contract

External plugins depend on these interfaces. **Do not change without project owner approval.**

| Interface | Location | Used by |
|-----------|----------|---------|
| `startProxyServer(config)` → `ProxyInstance` | `server.ts` | Hosts that spawn proxy instances |
| `ProxyInstance.close()` | `types.ts` | Hosts for graceful shutdown |
| `ProxyConfig` type | `types.ts` | Embed configuration |
| `x-meridian-profile` header | `server.ts`, `profiles.ts` | Per-request profile selection (only header consulted) |
| `GET /health` response shape | `server.ts` | Health checks |
| `POST /v1/messages` request/response format | `server.ts` | Anthropic API contract |
| `GET /profiles/list` response shape | `server.ts` | Profile management UI and CLI |
| `POST /profiles/active` request/response | `server.ts` | Profile switching from CLI and UI |

If you need to modify any of these, open an issue first — breaking changes affect downstream plugin authors.

## Git

- Commit format: `type: brief description`
- Types: feat, fix, refactor, perf, test, docs, chore
- No AI attribution lines

## Releasing

The previous `.github/workflows/*` (Release Please, CI, Docker) were
removed during the pure-Bun migration and will be rewritten. Until the
new pipeline lands there is **no automated release path** — do not
attempt to publish manually without explicit project-owner sign-off.

`.release-please-manifest.json` and `release-please-config.json` remain
on disk so the next release workflow can pick up the version anchor.

When the new pipeline is added, expect it to:

- Run `bun install`, `bun run typecheck`, `bun run build`.
- Use `bun publish` (the project no longer ships a `node`/`npm` toolchain).
- Be triggered by Conventional Commits on `main`.
