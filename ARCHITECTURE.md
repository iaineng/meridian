# Architecture

A transparent proxy that bridges OpenCode (Anthropic API format) to Claude Max (Agent SDK). This document defines the module structure, dependency rules, and design decisions.

## Request Flow

```
Agent (OpenCode) ──► HTTP POST /v1/messages ──► Proxy Server
                                                    │
                                        ┌───────────┴───────────┐
                                        │   Session Resolution   │
                                        │  (header or fingerprint)│
                                        └───────────┬───────────┘
                                                    │
                                        ┌───────────┴───────────┐
                                        │   Lineage Verification  │
                                        │ (continuation/compaction│
                                        │  /undo/diverged)        │
                                        └───────────┬───────────┘
                                                    │
                                        ┌───────────┴───────────┐
                                        │   Claude Agent SDK      │
                                        │   query() with MCP      │
                                        └───────────┬───────────┘
                                                    │
                                        ┌───────────┴───────────┐
                                        │   Response Streaming    │
                                        │  (SSE, tool_use filter) │
                                        └───────────┬───────────┘
                                                    │
Agent (OpenCode) ◄── SSE Response ◄─────────────────┘
```

## Module Map

```
src/
├── proxy/
│   ├── server.ts              ← HTTP layer: routes, SSE streaming, concurrency, request orchestration
│   ├── adapter.ts             ← AgentAdapter interface (extensibility point for multi-agent support)
│   ├── adapters/
│   │   └── opencode.ts        ← OpenCode adapter (session headers, CWD extraction, tool config)
│   ├── handlers/              ← Session-lifecycle dispatch (classic cache vs ephemeral one-shot)
│   │   ├── types.ts           ← HandlerContext: per-request session-lifecycle bundle
│   │   ├── classic.ts         ← Classic path: LRU cache lookup, lineage, stale-retry, persist
│   │   └── ephemeral.ts       ← Ephemeral path: pooled UUID, per-request JSONL, idempotent cleanup
│   ├── pipeline/              ← Request processing pipeline (shared between classic and ephemeral)
│   │   ├── context.ts         ← SharedRequestContext: profile/model/thinking/env resolution
│   │   ├── prompt.ts          ← PromptBundle builder (structured / multimodal / flat-text)
│   │   ├── hooks.ts           ← SDK hook bundle: passthrough MCP, file-change, web-search capture
│   │   ├── executor.ts        ← SDK query with retry loop; runNonStream + runStream
│   │   └── telemetry.ts       ← Per-request success/error metric emission
│   ├── query.ts               ← SDK query options builder (shared between stream/non-stream paths)
│   ├── concurrency.ts         ← FIFO session gate (`createConcurrencyGate`); `max<=0` disables the queue
│   ├── errors.ts              ← Error classification (SDK errors → HTTP responses)
│   ├── models.ts              ← Model mapping, Claude executable resolution
│   ├── tools.ts               ← Tool blocking lists, MCP server name, allowed tools
│   ├── messages.ts            ← Content normalization, message parsing
│   ├── types.ts               ← ProxyConfig, ProxyInstance, ProxyServer types
│   ├── session/
│   │   ├── index.ts           ← Barrel export
│   │   ├── lineage.ts         ← Pure functions: hashing, lineage verification
│   │   ├── fingerprint.ts     ← Conversation fingerprinting, client CWD extraction
│   │   ├── cache.ts           ← LRU session caches, lookup/store operations
│   │   ├── transcript.ts      ← JSONL transcript prewarm, delete/backup
│   │   └── ephemeralPool.ts   ← Pooled ephemeral session UUIDs
│   ├── sessionStore.ts        ← Shared file store (cross-proxy session resume)
│   ├── profiles.ts            ← Multi-profile support: resolve, list, switch auth contexts (leaf)
│   ├── profileCli.ts          ← CLI commands for profile management (leaf, I/O)
│   ├── agentDefs.ts           ← Subagent definition extraction from tool descriptions
│   ├── agentMatch.ts          ← Fuzzy agent name matching
│   └── passthroughTools.ts    ← Tool forwarding mode (agent handles execution)
├── fileChanges.ts             ← PostToolUse hook: tracks write/edit ops, formats summary
├── mcpTools.ts                ← MCP tool definitions (read, write, edit, bash, glob, grep)
├── logger.ts                  ← Logging with AsyncLocalStorage context
├── utils/
│   └── lruMap.ts              ← Generic LRU map with eviction callbacks
├── telemetry/
│   ├── index.ts               ← Barrel export
│   ├── store.ts               ← Request metrics storage
│   ├── routes.ts              ← Telemetry API endpoints
│   ├── logStore.ts            ← Diagnostic log ring buffer
│   ├── dashboard.ts           ← HTML dashboard
│   ├── profileBar.ts          ← Shared profile switcher bar (injected into HTML pages)
│   ├── profilePage.ts         ← Profile management page HTML
│   └── types.ts               ← Telemetry types
└── plugin/
    └── claude-max-headers.ts  ← OpenCode plugin for session header injection
```

## Dependency Rules

Dependencies flow **downward**. A module may only import from modules at the same level or below.

```
server.ts (HTTP layer)
    │
    ├── adapter.ts (interface)
    ├── adapters/opencode.ts ──► messages.ts, session/fingerprint.ts, tools.ts
    ├── handlers/
    │   ├── types.ts         ──► session/lineage.ts
    │   ├── classic.ts       ──► pipeline/context.ts, pipeline/prompt.ts, session/
    │   └── ephemeral.ts     ──► pipeline/context.ts, session/transcript.ts, session/ephemeralPool.ts
    ├── pipeline/
    │   ├── context.ts       ──► adapter.ts, profiles.ts, models.ts, betas.ts, obfuscate.ts
    │   ├── prompt.ts        ──► messages.ts, obfuscate.ts, passthroughTools.ts
    │   ├── hooks.ts         ──► adapter.ts, passthroughTools.ts, fileChanges.ts
    │   ├── executor.ts      ──► query.ts, errors.ts, models.ts, tokenRefresh.ts,
    │   │                        pipeline/{context,prompt,hooks,telemetry}, handlers/types
    │   └── telemetry.ts     ──► telemetry/ (types only)
    ├── query.ts ──► adapter.ts, mcpTools.ts, passthroughTools.ts
    ├── errors.ts
    ├── models.ts
    ├── tools.ts
    ├── messages.ts
    ├── session/cache.ts ──► session/lineage.ts ──► messages.ts
    │                    ──► session/fingerprint.ts
    │                    ──► sessionStore.ts
    ├── session/transcript.ts     ──► session/lineage.ts, messages.ts
    ├── session/ephemeralPool.ts
    ├── profiles.ts
    ├── profileCli.ts
    ├── agentDefs.ts
    ├── agentMatch.ts
    ├── fileChanges.ts
    ├── passthroughTools.ts
    ├── mcpTools.ts
    └── telemetry/
```

### Rules

1. **`session/lineage.ts` is pure.** No side effects, no I/O, no caches. Only crypto hashing and comparison logic. Must stay testable without mocks.

2. **`session/cache.ts` owns all mutable session state.** No other module should create or manage LRU caches for sessions.

3. **`errors.ts`, `models.ts`, `tools.ts`, `messages.ts`, `profiles.ts`, `profileCli.ts` are leaf modules.** They must not import from `server.ts`, `session/`, or `adapter.ts`.

4. **`server.ts` is the only module that imports from Hono** or touches HTTP concerns. It orchestrates — it does not compute. Per-request work lives in `handlers/` and `pipeline/`.

5. **No circular dependencies.** If you need to share types, put them in `types.ts` or the relevant leaf module.

6. **`adapter.ts` is an interface only.** No implementation logic. Adapter implementations go in `adapters/`.

7. **`query.ts` builds SDK options through the adapter interface**, never importing tool constants directly.

8. **`pipeline/` modules are path-agnostic.** They take a `SharedRequestContext` + `HandlerContext` and must not branch on `isEphemeral`. Ephemeral vs classic differences are expressed by `ExecutorCallbacks` (supplied by the handler) and the handler-produced `HandlerContext`.

9. **`handlers/` are the only modules that call `lookupSession` / `storeSession` / `evictSession` or touch the ephemeral session pool.** Pipeline code never calls them directly.

## Agent Adapter Pattern

Agent-specific behavior is isolated behind the `AgentAdapter` interface (`adapter.ts`). The proxy calls adapter methods instead of hardcoding agent logic.

### Current Adapters

- **`adapters/opencode.ts`** — OpenCode agent (session headers, `<env>` block parsing, tool mappings)

### Adding a New Agent

1. Create `adapters/myagent.ts` implementing `AgentAdapter`
2. Wire it into `server.ts` (currently hardcoded to `openCodeAdapter`; future work will auto-detect)
3. No changes needed to `query.ts`, `session/`, or other infrastructure

### What the Adapter Controls

| Method | What It Does |
|--------|-------------|
| `getSessionId(c)` | Extract session ID from request headers |
| `extractWorkingDirectory(body)` | Parse working directory from request body |
| `normalizeContent(content)` | Normalize message content for hashing |
| `getBlockedBuiltinTools()` | SDK tools replaced by agent's MCP equivalents |
| `getAgentIncompatibleTools()` | SDK tools with no agent equivalent |
| `getMcpServerName()` | MCP server name for tool registration |
| `getAllowedMcpTools()` | MCP tools allowed through the proxy |

### Remaining OpenCode-Specific Code (Not Yet in Adapter)

| Logic | Location | Status |
|-------|----------|--------|
| `buildAgentDefinitions` | `agentDefs.ts` | Parses OpenCode Task tool format. To be adapter method. |
| Passthrough mode | `passthroughTools.ts` | Agent-agnostic but OpenCode-motivated. Keep as-is. |
| `ALLOWED_MCP_TOOLS` usage in `server.ts` | Line ~176 | Used for `buildAgentDefinitions`. Move when adapter handles agent defs. |

## Blocking-MCP Mode (Interleaved-Thinking Preservation)

Triggered when **all** of these hold:

- `MERIDIAN_EPHEMERAL_JSONL=1`
- `MERIDIAN_BLOCKING_MCP=1`
- `shared.initialPassthrough === true` (adapter override or `MERIDIAN_PASSTHROUGH=1`)

`body.tools.length > 0` is **not** a precondition. When the env switch is
on, every passthrough+ephemeral request takes the blocking path — including:

- Plain-text-only chats (no tools, no outputFormat). The pool just lives
  one HTTP round; no tool_use round-close fires, so the consumer's natural
  SDK end drives teardown.
- `outputFormat`-only requests. `maxTurns=10_000` gives the SDK plenty of
  headroom to exhaust its internal StructuredOutput retry budget, and
  `translateBlockingMessage` converts the SDK's terminal
  `tool_use{name:"StructuredOutput"}` block to a `text` block client-side.
  Raw `text` content blocks the model emits alongside StructuredOutput are
  suppressed (`outputFormatTextSkipIndices`) so the client receives only the
  schema-conformant payload — no mixed prose + JSON shapes.
- Built-in-only tool sets (lone `web_search`, …). The blocking pipeline
  owns the WebSearch synthesis (see "Built-in WebSearch" below) and can
  leverage the 10_000-turn budget for chained searches.
- Mixed (custom MCP tools + built-in `web_search`) and outputFormat alongside
  any of the above.

`shared.outputFormat` is **not** a precondition: blocking mode raises
`maxTurns` to 10_000, so `StructuredOutput` co-exists with passthrough tools
without burning the turn budget.

Any missing precondition → silent fallback to plain ephemeral passthrough
(synthetic filler / continue).

`shared.stream` is **not** a precondition: a single conversation may freely alternate `stream:true` and `stream:false` across rounds. Streaming HTTPs return Anthropic SSE; non-streaming HTTPs return a single Anthropic JSON Message reconstructed from the same internal `BufferedEvent` stream. See "Non-stream variant" below.

### Why

The default ephemeral+passthrough flow finishes each SDK query with `maxTurns: 1`, so every round of tool calls is a fresh SDK invocation. That defeats `anthropic-beta: interleaved-thinking-*`: the SDK cannot replay the model's signed `thinking` blocks at resume time, so the model drops the chain. It also forces synthetic filler / continue-prompt placeholders on every JSONL rewrite, polluting prompt cache and token counts.

Blocking-MCP keeps **one** SDK query alive across all HTTP rounds by making the passthrough MCP handlers real Promise-blocked suspenders: the SDK calls the handler, we stash the resolver, stream the tool_use out to the client, close the HTTP with `stop_reason: "tool_use"`, and wait for the next HTTP to bring the matching `tool_result` — then resolve the suspended handler and the SDK continues with its signed thinking intact.

### State Machine

```
                 initial HTTP
                 (buildBlockingHandler acquires pool state,
                  spawnConsumer starts SDK iterator)
                 │
                 ▼
    ┌──────► streaming ──────────────────────────┐  (SDK producing content)
    │         │                                   │
    │         │ two-gate round close:             │
    │         │   (a) API message_delta           │  close_round fired
    │         │       (stop_reason:"tool_use")    │  when both gates met
    │         │   (b) every expected tool_use_id  │
    │         │       has a PendingTool           │
    │         ▼                                   ▼
    │      awaiting_results ◄────────── HTTP closes with
    │         │                          stop_reason:"tool_use"
    │         │                                   │
    │         │                                   ▼
    │         │                           next HTTP arrives
    │         │                           (buildBlockingHandler.continuation)
    │         │                                   │
    │         │                                   ▼
    │         │                           resolve pending tools,
    │         │                           emit fresh message_start,
    │         └──────────────────────◄──── attach new sink
    │
    └── sdk emits message_delta(end_turn) ──► terminated
                                              (blockingPool.release:
                                               cleanup JSONL, free pool id)
```

### Data Flow

```
SDK async iterator (lives in spawnConsumer)
        │
        │   for await (msg of iterator) {
        │     frames = translateBlockingMessage(msg, state)
        │     for (f of frames) pushEvent(state, {kind:"sse", frame:f})
        │   }
        ▼
BlockingSessionState.eventBuffer  ◄── 0 or 1 ──► state.activeSink (current HTTP's deliver())
        │                                             │
        │  (flushed on attach)                        ▼
        └──────────────────────────────►  HTTP ReadableStream controller
```

### Wire Protocol (per HTTP round)

Every HTTP response is a complete Anthropic SSE sequence:

```
event: message_start       ← meridian-generated, fresh msg_<id> each HTTP
event: content_block_start ← forwarded from SDK, index remapped
event: content_block_delta ← ditto
event: content_block_stop  ← ditto
...
event: message_delta       ← meridian-generated at close_round OR SDK end
       {stop_reason:"tool_use"|"end_turn"|"max_tokens"}
event: message_stop        ← ditto
```

SDK's own `message_start` / `message_delta` / `message_stop` events are **suppressed** — blocking mode owns the framing. `X-Claude-Session-ID` carries `stringifyBlockingKey(key)` so clients can include it as an explicit session id on the next HTTP (optional — lineage-hash matching is the fallback).

### Non-stream variant

When the client requests with `stream:false`, the same SDK iterator and `BlockingSessionState` are used; only the sink is different. `runBlockingNonStream` (in `pipeline/blockingStream.ts`) attaches a sink that reverse-parses the same `BufferedEvent` SSE frames into a single Anthropic-format JSON Message via `createBlockingJsonAggregator` (in `pipeline/blockingNonStreamAggregator.ts`). Round-close semantics are identical:

- `close_round` → HTTP returns JSON with `stop_reason:"tool_use"`; session stays alive.
- `end` (`end_turn` / `max_tokens`) → HTTP returns JSON with the matching `stop_reason`; pool releases.
- `error` → HTTP 200 + `{type:"error", error:{type, message}}` envelope (mirrors the streaming path's `event: error` SSE frame); pool releases.

Because the aggregator consumes the exact frames the streaming path forwards, the assistant blocks delivered to the client are byte-equivalent across modes. `lastEmittedAssistantBlocks`, `priorMessageHashes`, and the drift check in `buildBlockingHandler` are therefore mode-agnostic — a conversation may freely alternate `stream:true` and `stream:false` across rounds.

### Built-in WebSearch handling

The SDK's built-in `WebSearch` is a CLIENT tool (it executes locally inside
the SDK process and the model sees `tool_use { name: "WebSearch" }` blocks).
Anthropic's hosted API exposes the same capability as a server tool —
`server_tool_use` + `web_search_tool_result` content blocks. Clients that
target the API directly expect the server-side shape.

`hooks.ts` registers a `PostToolUse` matcher on `WebSearch` whenever
`useBuiltinWebSearch` is true (which fires both for the lone `web_search`
tool — passthrough flips to false — and for the `custom + web_search` mix —
passthrough stays on but blocking mode keeps the matcher live). The hook
captures each result into `pendingWebSearchResults`. `runBlockingStream` /
`runBlockingNonStream` bind that array onto `state.pendingWebSearchResults`
on the initial HTTP via `bindWebSearchStateToHooks`.

`translateBlockingMessage` then does the heavy lifting:

1. **Suppresses the model's `tool_use { name: "WebSearch" }` block** (and its
   trailing `content_block_delta` / `content_block_stop` frames, tracked
   through `state.webSearchSkipIndices`). The client never sees the
   client-tool form.
2. **Coalesces duplicate `message_start` frames within a round.** Built-in
   WebSearch causes the SDK to open a fresh API turn after each local call;
   `state.messageStartEmittedThisRound` ensures only the first turn's
   `message_start` reaches the client. Reset to `false` on round close
   (`maybeCloseRound`) so the next blocking round starts clean.
3. **Drains `pendingWebSearchResults` into synthetic
   `server_tool_use` + `web_search_tool_result` content blocks** at each
   message_start boundary (covering both subsequent SDK turns within one
   round and the next round's first turn). A trailing drain in
   `spawnConsumer`'s finally also flushes captures stranded by the SDK
   ending right after a WebSearch.
4. **Remaps SDK block indices onto a monotonic per-round counter
   (`state.nextClientBlockIndex`).** SDK indices reset to 0 every turn but
   the client sees one merged Anthropic Message per round, so the
   translator allocates a fresh non-negative index for every emitted
   `content_block_start` (real and synthetic) and `state.sdkToClientIndex`
   re-routes the matching `content_block_delta` / `content_block_stop`
   frames. The counter resets on `maybeCloseRound`.
5. **Suppresses orphan `message_delta(stop_reason="tool_use")` frames** —
   when a turn ends with `stop_reason=tool_use` but every tool_use was a
   suppressed WebSearch (`expectedIds.size === 0` *and*
   `state.useBuiltinWebSearch` *and* `state.webSearchSkipIndices.size > 0`),
   the frame is dropped. Without this the client would see an "act on
   tool_use" signal with no corresponding tool_use block; the SDK opens a
   fresh internal turn whose final `message_delta` carries the real
   terminal `stop_reason`.

This mirrors the executor's non-blocking behaviour but the timing is shifted:
the executor drains synthetic frames at duplicate-message_start in its
streaming forwarder; the blocking translator does the same inside the
session-level event stream that feeds both `runBlockingStream` (SSE) and
`runBlockingNonStream` (JSON aggregator) — keeping the byte-equivalence
invariant across stream/non-stream modes intact.

### Failure Handling

| Scenario | Handling |
|----------|----------|
| Preconditions not met (no tools, no passthrough, …) | Dispatch goes through the plain ephemeral handler (no blocking). |
| Continuation hits pool but the stored `priorMessageHashes` is not a prefix of the incoming prior (tampering / undo / different branch) | `buildBlockingHandler` falls through to the fresh blocking initial path. |
| Continuation hash matches but `body.tools` fingerprint differs from the live sibling's stored `toolsFingerprint` | Live sibling released; promoted to a fresh blocking initial. The SDK iterator's in-process MCP server has the OLD tool definitions baked in (no re-enumeration across resumes within one `query()`), so feeding tool_results into stale handlers would let the model continue thinking against an outdated schema. Logged as `blocking.continuation.tools_changed` + `blocking.continuation.promoted{from:"tools_changed"}`. |
| Continuation hash matches but the trailing tool_use/tool_result shape mismatches the live pending set | Live sibling is preserved because the request may be a fork; incoming branch is promoted to a fresh blocking initial via JSONL rebuild. Logged as `blocking.continuation.mismatch` + `blocking.continuation.promoted{from:"tool_mismatch"}`. |
| Continuation hash matches but pool has no entry (server restart, timeout) | Fall through to the fresh blocking initial path. |
| SDK query errors mid-flight | `error` SSE event + `message_delta(end_turn)` + `message_stop`; session released. |
| 30-min idle (janitor) | All pending tools rejected, JSONL cleaned up, pool entry dropped. |
| Client disconnect mid-HTTP | `detachSink`; state keeps running, consumer pushes into buffer; next reconnect / continuation attaches. |

### Known Limits (v1)

- No `stale_session_error` retry (resume semantics do not apply inside a live query).
- Per-session timeout only; no per-tool deadline (see DEFERRED.md).
- Sub-agent (Task) nested `parent_tool_use_id` streams are not validated — see DEFERRED.md.

### Critical Files

- `src/proxy/session/blockingPool.ts` — registry, janitor, session state shape.
- `src/proxy/handlers/blocking.ts` — initial vs continuation dispatch and mismatch promotion.
- `src/proxy/pipeline/blockingStream.ts` — consumer task, sink attach/detach, per-HTTP meridian framing for both `runBlockingStream` (SSE) and `runBlockingNonStream` (aggregated JSON), plus the shared `applyContinuation` helper.
- `src/proxy/pipeline/blockingNonStreamAggregator.ts` — reverse-parses SSE frames into a single Anthropic JSON Message for the non-stream sink.
- `src/proxy/passthroughTools.ts` — `createBlockingPassthroughMcpServer` with `annotations: { readOnlyHint: true }` and FIFO `tool_use_id` rendezvous.
- `src/proxy/query.ts` — `blockingMode` → `maxTurns: 10_000` + `CLAUDE_CODE_STREAM_CLOSE_TIMEOUT=1800000`.

## Query-Direct Lone-User Path

Active under `MERIDIAN_EPHEMERAL_JSONL=1` (and the blocking variant) when the request matches the lone-user shape and carries no out-of-position cache_control. Bypasses `prepareFreshSession` entirely: no JSONL on disk, no `resume` to the SDK, no synthetic filler. The user message(s) are fed straight to `query()` as an `AsyncIterable<SDKUserMessage>`.

### Trigger Conditions

`classifyQueryDirect` (in `src/proxy/session/queryDirect.ts`) returns `eligible: true` when **all** of:

- `messages.length >= 1` and the trailing message is a user turn.
- `!hasTrailingToolUse` — the message before the trailing user is not an assistant carrying unresolved `tool_use` blocks (that's the tool_result-tail shape, owned by the existing JSONL path).
- The trailing user has no anchoring assistant before it. Two shapes qualify:
  - `[u1]` — strict lone-user
  - `[u1, u2, ...]` — consecutive user turns (existing path would trigger filler here)
- Any client-supplied `cache_control` breakpoint sits on the trailing user message (or there are none). When the client placed a breakpoint on a non-trailing message, the query-direct path cannot honor its position via the AsyncIterable prompt — fall back to the JSONL path where `applyJsonlHistoryBreakpoints` preserves position.

Multimodal blocks (`image`/`document`/`file`) are explicitly supported on this path. The SDK's AsyncIterable prompt accepts native Anthropic block shapes, and `normalizeUserContentForSdk` passes them through unchanged (only `text` and `tool_result` blocks have their leaf strings touched). This avoids the flatten-to-XML-then-attach workaround that `buildPromptBundle`'s path 2 needs for history-bearing requests.

### Byte-Equivalence Invariant

The win is cache hits across HTTP boundaries: when R1 (lone-user) takes the query-direct path and R2 (the same conversation extended) is forced through `prepareFreshSession`, R2's rebuilt JSONL u1 row must be byte-equivalent (modulo `cache_control` markers) to the user message R1 sent over the AsyncIterable. Otherwise Anthropic's prompt cache misses on every R2.

Both paths share the same content-shaping primitives in `src/proxy/session/transcript.ts`:

- `stripCacheControlDeep` — recursively strip client cache_control.
- `normalizeUserContentForSdk` — wrap strings as `[{type:"text", text: crEncode(s)}]` (matches the SDK's n6A normalization for "last" position so the bytes don't shape-shift across requests).

`buildQueryDirectMessages` (R1) calls `normalizeUserContentForSdkPath` (= strip + normalize) on every message and **does not** add any `cache_control`. `buildJsonlLines` (R2) calls the same primitives during row construction; `applyJsonlHistoryBreakpoints` then stamps `JSONL_HISTORY_CACHE_CONTROL` on the last user row in the JSONL slice (R2's u1) so meridian's history anchor is in place when SDK sees the rebuilt history.

#### Why R1 sets no cache_control

The SDK's `addCacheBreakpoints` pass (cli.js `services/api/claude.ts:3063`) unconditionally rewrites the trailing message's last block via `userMessageToMessageParam(msg, addCache=true, ...)` (`claude.ts:609-620`), substituting whatever caller-supplied `cache_control` was there with the result of `getCacheControl({querySource})`. Setting cc on R1's trailing message would therefore be wasted work — and would also break byte equivalence with R2's u1 row (which keeps meridian's `applyJsonlHistoryBreakpoints` value because R2's u1 is no longer the last message).

#### Cache-hit conditions

- R1 final API body: `[u1 + sdk_cc]` where `sdk_cc = getCacheControl({querySource})`.
- R2 final API body: `[u1 + meridian_cc(JSONL_HISTORY_CACHE_CONTROL), a1, u2 + sdk_cc]` — non-marker positions retain whatever cc the JSONL carried; only u2 (marker) gets SDK overwrite.

R2's read at u1 hits R1's write iff `meridian_cc === sdk_cc` byte-for-byte. `getCacheControl` returns `{type:"ephemeral", ttl:"1h"}` exactly when `should1hCacheTTL(querySource)` is true (`claude.ts:393-432`) — the user is ant/Claude.ai-subscriber and the querySource matches the GrowthBook 1h allowlist. For Claude Max users on the SDK's tracked querySources this is the typical case and meridian's `JSONL_HISTORY_CACHE_CONTROL = {type:"ephemeral", ttl:"1h"}` matches. Outside that, R2 cache hit is not achievable; the filler-free transcript win still applies.

For strict `[u1]` the non-cc prefix bytes match across R1 and R2. For `[u1, u2]` the prefix diverges in R2 (an assistant turn `a1` lands between `u1` and `u2`), so cache hits at the u1 boundary are not achievable even when the cc values match — but the filler-free transcript still applies.

The byte-alignment unit test (`queryDirect-bytes-unit.test.ts`) strips `cache_control` from both sides before comparing so the assertion catches drift in the content-shaping primitives without being noisy about the asymmetric cc placement.

### Pipeline Wiring

- `HandlerContext` carries `isQueryDirect: boolean` and `directPromptMessages: QueryDirectMessage[]` (in `src/proxy/handlers/types.ts`). Mutually exclusive with `freshSessionId` / `useJsonlFresh`.
- `buildPromptBundle` (in `src/proxy/pipeline/prompt.ts`) gains a Path 0 that short-circuits the JSONL/multimodal/text branches and returns an AsyncIterable yielding the pre-built records.
- `runSdkQueryWithRetry` (in `src/proxy/pipeline/executor.ts`) and `startSdkIterator` (in `src/proxy/pipeline/blockingStream.ts`) drop `resumeSessionId` to `undefined` when `handler.isQueryDirect === true` so the SDK starts a fresh session instead of crashing on a non-existent resume id.
- ephemeral and blocking handlers (`src/proxy/handlers/ephemeral.ts`, `src/proxy/handlers/blocking.ts`) classify the request first; eligible requests skip the prepareFreshSession block entirely. The cleanup closure releases the pool id without touching disk (no JSONL was written).

In blocking-MCP mode the query-direct path is fully compatible with the multi-round SDK iterator — `applyContinuation` injects subsequent tool_results into the live generator, never touching JSONL. The SDK subprocess may write its own transcript at a self-generated UUID; meridian leaves that file alone (UUID collisions are negligible, and DEFERRED.md tracks an optional async-cleanup follow-up).

### Critical Files

- `src/proxy/session/queryDirect.ts` — `classifyQueryDirect`, `cacheBreakpointOnTrailingOnly`, `buildQueryDirectMessages`. Pure leaf module.
- `src/proxy/session/transcript.ts` — exported byte-shaping primitives (`stripCacheControlDeep`, `normalizeUserContentForSdk`, `normalizeUserContentForSdkPath`, `setCacheControlAt`, `JSONL_HISTORY_CACHE_CONTROL`, `classifyContinuation`).
- `src/__tests__/queryDirect-bytes-unit.test.ts` — load-bearing byte-alignment regression guard.

## Session Management

Sessions map an agent's conversation ID to a Claude SDK session ID. Two caches work in tandem:

- **Session cache**: keyed by agent header (`x-opencode-session`)
- **Fingerprint cache**: keyed by hash of first user message + working directory (fallback when no header)

Both are LRU with coordinated eviction — evicting from one removes the corresponding entry in the other.

### Lineage Verification

Every request verifies that incoming messages are a valid continuation of the cached session:

| Classification | Condition | Action |
|---------------|-----------|--------|
| **Continuation** | Prefix hash matches stored | Resume normally |
| **Compaction** | Suffix preserved, beginning changed | Resume (agent summarized old messages) |
| **Undo** | Prefix preserved, suffix changed | Fork at rollback point |
| **Diverged** | No meaningful overlap | Start fresh session |

## Testing Strategy

Three tiers, each catching different classes of bugs:

| Tier | Files | SDK | Speed | Runs In |
|------|-------|-----|-------|---------|
| **Unit** | `src/__tests__/*-unit.test.ts` | None | Fast | CI (`bun test`) |
| **Integration** | `src/__tests__/proxy-*.test.ts` | Mocked | Fast | CI (`bun test`) |
| **E2E** | `E2E.md` | Real (Claude Max) | Slow | Manual, pre-release |

- **Unit tests**: Pure functions, no mocks, no I/O.
- **Integration tests**: HTTP layer with mocked SDK. Deterministic.
- **E2E tests**: Real proxy + real SDK + real Claude Max. See [`E2E.md`](./E2E.md) for runnable procedures covering session continuation, undo, compaction, cross-proxy resume, tool loops, streaming, and telemetry.

All tests import from source modules, not build output.
Tests that need `clearSessionCache` or `createProxyServer` import from `../proxy/server`.

### Test Baseline

Every change must pass all existing unit and integration tests:

```bash
npm test    # runs: bun test
```

E2E tests (`E2E.md`) should be run before releases or after major refactors.

## Adding New Code

### New pure logic (no I/O, no state)
→ Create a new leaf module in `src/proxy/`. Add unit tests.

### New stateful logic (caches, stores)
→ Add to the appropriate existing module (`session/cache.ts`, `sessionStore.ts`). Don't create new caches elsewhere.

### New HTTP endpoints
→ Add to `server.ts`. Keep route handlers thin — delegate to extracted modules.

### New per-request processing step
→ Add a module under `pipeline/` that consumes `SharedRequestContext` + `HandlerContext` and returns a typed bundle. Do not branch on `isEphemeral` — route path-specific behavior through `ExecutorCallbacks` or the handler.

### New session-lifecycle mode
→ Add a module under `handlers/` that returns a `HandlerContext`. Wire it into `server.ts` alongside `buildClassicHandler` / `buildEphemeralHandler`. Only handler modules may call `lookupSession` / `storeSession` / `evictSession` or touch the ephemeral pool.

### New agent support
→ Implement `AgentAdapter` in `src/proxy/adapters/`. See `adapters/opencode.ts` for reference. Do not hardcode agent-specific logic in leaf modules.
