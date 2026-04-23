/**
 * End-to-end test that the 5 OAuth env vars land in options.env of the SDK
 * query() call when the proxy handles a request. Uses an in-memory SDK mock
 * to capture the options, and a tmp directory fixture for fs inputs
 * (setup-token + .claude.json) so the test is hermetic.
 */

import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

let capturedOptions: any = null

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: (params: any) => {
    capturedOptions = params.options
    return (async function* () {
      yield {
        type: "assistant",
        message: {
          id: "msg_test",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "ok" }],
          model: "claude-sonnet-4-5",
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        },
        session_id: "sess-oauth-env-test",
      }
    })()
  },
  createSdkMcpServer: () => ({ type: "sdk", name: "test", instance: {} }),
}))

mock.module("../logger", () => ({
  claudeLog: () => {},
  withClaudeLogContext: (_ctx: any, fn: any) => fn(),
}))

mock.module("../mcpTools", () => ({
  createOpencodeMcpServer: () => ({ type: "sdk", name: "opencode", instance: {} }),
}))

const { createProxyServer, clearSessionCache } = await import("../proxy/server")
const { invalidateClaudeOauthEnvCache } = await import("../proxy/claudeOauthEnv")

function postApp(profileConfigDir: string | undefined, body: any) {
  const config: any = { port: 0, host: "127.0.0.1" }
  if (profileConfigDir) {
    config.profiles = [{ id: "max", type: "claude-max", claudeConfigDir: profileConfigDir }]
    config.defaultProfile = "max"
  }
  const { app } = createProxyServer(config)
  return app.fetch(new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }))
}

function postApiProfile(apiKey: string, body: any) {
  const { app } = createProxyServer({
    port: 0,
    host: "127.0.0.1",
    profiles: [{ id: "api", type: "api", apiKey }],
    defaultProfile: "api",
  })
  return app.fetch(new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }))
}

const REQUEST = {
  model: "claude-sonnet-4-5",
  max_tokens: 256,
  stream: false,
  messages: [{ role: "user", content: "hello" }],
}

const FIXTURE_ACCOUNT = {
  accountUuid: "ae6a1874-bb61-491c-9b60-62bdc3f6bd5b",
  emailAddress: "active-gonad-happy@duck.com",
  organizationUuid: "7e07c0bd-d750-49f0-9c51-702c03865b3d",
}

function seedConfigDir(dir: string, opts: { token?: string; account?: object } = {}): void {
  if (opts.token !== undefined) {
    writeFileSync(join(dir, "setup-token"), opts.token, "utf-8")
  }
  if (opts.account !== undefined) {
    writeFileSync(join(dir, ".claude.json"), JSON.stringify({ oauthAccount: opts.account }), "utf-8")
  }
}

describe("OAuth env var injection", () => {
  let tmp: string
  let savedHome: string | undefined
  let savedUserprofile: string | undefined

  beforeEach(() => {
    capturedOptions = null
    clearSessionCache()
    invalidateClaudeOauthEnvCache()
    tmp = mkdtempSync(join(tmpdir(), "meridian-oauth-inj-"))
    savedHome = process.env.HOME
    savedUserprofile = process.env.USERPROFILE
    // Point homedir() at an empty tmp dir so the default (no-profile) path
    // never leaks the runner's real ~/.claude.json.
    process.env.HOME = tmp
    process.env.USERPROFILE = tmp
  })

  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME
    else process.env.HOME = savedHome
    if (savedUserprofile === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = savedUserprofile
    try { rmSync(tmp, { recursive: true, force: true }) } catch {}
  })

  it("injects all 5 OAuth env vars for a claude-max profile with full fixtures", async () => {
    const profileDir = mkdtempSync(join(tmpdir(), "meridian-oauth-inj-profile-"))
    try {
      seedConfigDir(profileDir, {
        token: "sk-ant-oat01-profile-token\n",
        account: FIXTURE_ACCOUNT,
      })

      await postApp(profileDir, REQUEST)
      expect(capturedOptions).toBeDefined()
      const env = capturedOptions.env
      expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("sk-ant-oat01-profile-token")
      expect(env.CLAUDE_CODE_ENTRYPOINT).toBe("local-agent")
      expect(env.CLAUDE_CODE_ACCOUNT_UUID).toBe(FIXTURE_ACCOUNT.accountUuid)
      expect(env.CLAUDE_CODE_USER_EMAIL).toBe(FIXTURE_ACCOUNT.emailAddress)
      expect(env.CLAUDE_CODE_ORGANIZATION_UUID).toBe(FIXTURE_ACCOUNT.organizationUuid)
    } finally {
      rmSync(profileDir, { recursive: true, force: true })
    }
  })

  it("skips OAuth env vars entirely for api profiles", async () => {
    // Seed the homedir fixture too, to prove that api profile ignores it.
    seedConfigDir(tmp, { token: "from-home", account: FIXTURE_ACCOUNT })

    await postApiProfile("sk-ant-api-test", REQUEST)
    expect(capturedOptions).toBeDefined()
    const env = capturedOptions.env
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
    expect(env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined()
    expect(env.CLAUDE_CODE_ACCOUNT_UUID).toBeUndefined()
    expect(env.CLAUDE_CODE_USER_EMAIL).toBeUndefined()
    expect(env.CLAUDE_CODE_ORGANIZATION_UUID).toBeUndefined()
  })

  it("reads from profile's CLAUDE_CONFIG_DIR — not homedir — when both are present", async () => {
    const profileDir = mkdtempSync(join(tmpdir(), "meridian-oauth-inj-profile2-"))
    try {
      // Home has one set of values, profile dir has a different set.
      seedConfigDir(tmp, {
        token: "home-token",
        account: { ...FIXTURE_ACCOUNT, accountUuid: "home-uuid" },
      })
      seedConfigDir(profileDir, {
        token: "profile-token",
        account: { ...FIXTURE_ACCOUNT, accountUuid: "profile-uuid" },
      })

      await postApp(profileDir, REQUEST)
      expect(capturedOptions).toBeDefined()
      const env = capturedOptions.env
      expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("profile-token")
      expect(env.CLAUDE_CODE_ACCOUNT_UUID).toBe("profile-uuid")
    } finally {
      rmSync(profileDir, { recursive: true, force: true })
    }
  })

  it("always sets CLAUDE_CODE_ENTRYPOINT even when other sources are absent", async () => {
    // Default (no profile) path + empty tmp HOME → only ENTRYPOINT present.
    await postApp(undefined, REQUEST)
    expect(capturedOptions).toBeDefined()
    const env = capturedOptions.env
    expect(env.CLAUDE_CODE_ENTRYPOINT).toBe("local-agent")
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
    expect(env.CLAUDE_CODE_ACCOUNT_UUID).toBeUndefined()
  })
})
