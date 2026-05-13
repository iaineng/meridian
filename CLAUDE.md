# CLAUDE.md

Project guidelines for AI agents working in this codebase.

## What This Is

A proxy that exposes any Anthropic API client to Claude Max via the Claude Agent SDK. The proxy is agent-agnostic — it accepts the standard `POST /v1/messages` shape with optional `x-meridian-*` headers. See `ARCHITECTURE.md` for the full module map and dependency rules.

## Commands

```bash
npm test          # Run all tests (bun test)
npm run build     # Build with tsup
npm start         # Start the proxy server
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

- `MERIDIAN_EPHEMERAL_JSONL_BACKUP=1` — Rename the JSONL to `.<timestamp>.bak` instead of deleting on cleanup.
- `MERIDIAN_BLOCKING_DRIFT_NAME_ONLY=1` — Relax both the blocking-continuation drift check AND the prefix-hash lookup to ignore `tool_use` inputs (and ids), enforcing only count + per-position name equality. Escape hatch for clients that semantically rewrite tool inputs between rounds. Off by default.
- `MERIDIAN_DISABLE_BLOCKING_CONTINUE=1` — Disable the in-memory blocking continuation path. Each HTTP round behaves as a one-shot: the handler skips pool lookup for tool_result-tail requests and always rebuilds the full JSONL transcript via `prepareFreshSession`, spawning a fresh SDK iterator. As soon as `close_round` fires the live sibling is released (SDK subprocess aborted, suspended MCP handlers rejected, JSONL deleted) — the proxy never waits for the client to deliver tool_results into the same iterator. Trades interleaved-thinking signature preservation and prompt-cache continuity for a simpler stateless flow. Off by default.

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

**Do NOT run `npm version`, `git push --tags`, or `npm publish` manually.**

Releases are handled automatically by [Release Please](https://github.com/googleapis/release-please):

1. Merge PRs to `main` (use [Conventional Commits](https://www.conventionalcommits.org/) — `feat:`, `fix:`, etc.)
2. Release Please auto-creates/updates a release PR that batches all changes since the last release
3. Review and merge the release PR when you're ready to ship
4. Merging the release PR automatically:
   - Bumps `package.json` and `CHANGELOG.md`
   - Creates a git tag and GitHub Release
   - Runs tests, builds, and publishes to npm with provenance

Multiple PRs get batched into a single release. Never publish manually.

### Release config files

- **`.release-please-manifest.json`** — tracks the current released version. Release Please updates this automatically when a release PR is merged. **Do not edit manually** unless resetting the version anchor.
- **`release-please-config.json`** — defines the release type (`node`), component name, and changelog section mapping.
- **`.github/workflows/release-please.yml`** — the workflow that runs on every push to `main`. It creates/updates the release PR and publishes to npm when merged.

There is **no manual release workflow**. The old `release.yml` (workflow_dispatch) was removed because it conflicted with branch protection and duplicated Release Please's job.
