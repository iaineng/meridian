/**
 * Unit tests for claudeOauthEnv.
 *
 * Uses tmp config directories (mkdtempSync) so tests never touch the real
 * ~/.claude.json, and an in-memory CredentialStore so no Keychain / fs
 * interaction is required for the credentials fallback path.
 */

import { describe, it, expect, beforeEach } from "bun:test"
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  resolveClaudeOauthEnv,
  invalidateClaudeOauthEnvCache,
} from "../proxy/claudeOauthEnv"
import type { CredentialStore } from "../proxy/tokenRefresh"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mkTmpConfigDir(): string {
  return mkdtempSync(join(tmpdir(), "meridian-oauth-env-"))
}

function rmConfigDir(dir: string): void {
  try { rmSync(dir, { recursive: true, force: true }) } catch {}
}

function writeClaudeJson(dir: string, body: unknown, subdir?: string): string {
  const baseDir = subdir ? join(dir, subdir) : dir
  if (subdir && !existsSync(baseDir)) mkdirSync(baseDir, { recursive: true })
  const path = join(baseDir, ".claude.json")
  writeFileSync(path, JSON.stringify(body), "utf-8")
  return path
}

function makeStore(creds: { accessToken?: string } | null): {
  store: CredentialStore
  readCount: () => number
} {
  let reads = 0
  const store: CredentialStore = {
    async read() {
      reads++
      if (!creds) return null
      return { claudeAiOauth: { ...creds, refreshToken: "rt", expiresAt: 0 } } as any
    },
    async write() { return true },
  }
  return { store, readCount: () => reads }
}

const FULL_OAUTH_ACCOUNT = {
  accountUuid: "ae6a1874-bb61-491c-9b60-62bdc3f6bd5b",
  emailAddress: "active-gonad-happy@duck.com",
  organizationUuid: "7e07c0bd-d750-49f0-9c51-702c03865b3d",
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("resolveClaudeOauthEnv", () => {
  let dir: string

  beforeEach(() => {
    invalidateClaudeOauthEnvCache()
    if (dir) rmConfigDir(dir)
    dir = mkTmpConfigDir()
  })

  it("always sets CLAUDE_CODE_ENTRYPOINT to local-agent", async () => {
    const { store } = makeStore(null)
    const env = await resolveClaudeOauthEnv({ configDir: dir, credentialStore: store })
    expect(env.CLAUDE_CODE_ENTRYPOINT).toBe("local-agent")
  })

  it("reads CLAUDE_CODE_OAUTH_TOKEN from setup-token (trimmed) when present", async () => {
    writeFileSync(join(dir, "setup-token"), "sk-ant-oat01-from-file\n", "utf-8")
    const { store, readCount } = makeStore({ accessToken: "from-store" })

    const env = await resolveClaudeOauthEnv({ configDir: dir, credentialStore: store })

    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("sk-ant-oat01-from-file")
    expect(readCount()).toBe(0)
  })

  it("falls back to credential store when setup-token is missing", async () => {
    const { store } = makeStore({ accessToken: "sk-ant-oat01-from-store" })

    const env = await resolveClaudeOauthEnv({ configDir: dir, credentialStore: store })

    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("sk-ant-oat01-from-store")
  })

  it("falls through to credential store when setup-token is empty/whitespace", async () => {
    writeFileSync(join(dir, "setup-token"), "   \n  ", "utf-8")
    const { store } = makeStore({ accessToken: "from-store" })

    const env = await resolveClaudeOauthEnv({ configDir: dir, credentialStore: store })

    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("from-store")
  })

  it("omits CLAUDE_CODE_OAUTH_TOKEN when neither source has one", async () => {
    const { store } = makeStore(null)

    const env = await resolveClaudeOauthEnv({ configDir: dir, credentialStore: store })

    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
    expect(env.CLAUDE_CODE_ENTRYPOINT).toBe("local-agent")
  })

  it("omits CLAUDE_CODE_OAUTH_TOKEN when store returns empty accessToken", async () => {
    const { store } = makeStore({ accessToken: "" })

    const env = await resolveClaudeOauthEnv({ configDir: dir, credentialStore: store })

    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
  })

  it("reads all three identity fields from <configDir>/.claude.json", async () => {
    writeClaudeJson(dir, { oauthAccount: FULL_OAUTH_ACCOUNT })
    const { store } = makeStore(null)

    const env = await resolveClaudeOauthEnv({ configDir: dir, credentialStore: store })

    expect(env.CLAUDE_CODE_ACCOUNT_UUID).toBe(FULL_OAUTH_ACCOUNT.accountUuid)
    expect(env.CLAUDE_CODE_USER_EMAIL).toBe(FULL_OAUTH_ACCOUNT.emailAddress)
    expect(env.CLAUDE_CODE_ORGANIZATION_UUID).toBe(FULL_OAUTH_ACCOUNT.organizationUuid)
  })

  it("falls back to <configDir>/.claude/.claude.json when top-level file is missing", async () => {
    writeClaudeJson(dir, { oauthAccount: FULL_OAUTH_ACCOUNT }, ".claude")
    const { store } = makeStore(null)

    const env = await resolveClaudeOauthEnv({ configDir: dir, credentialStore: store })

    expect(env.CLAUDE_CODE_ACCOUNT_UUID).toBe(FULL_OAUTH_ACCOUNT.accountUuid)
    expect(env.CLAUDE_CODE_USER_EMAIL).toBe(FULL_OAUTH_ACCOUNT.emailAddress)
    expect(env.CLAUDE_CODE_ORGANIZATION_UUID).toBe(FULL_OAUTH_ACCOUNT.organizationUuid)
  })

  it("prefers the top-level .claude.json over the nested one when both exist", async () => {
    writeClaudeJson(dir, { oauthAccount: FULL_OAUTH_ACCOUNT })
    writeClaudeJson(dir, { oauthAccount: { ...FULL_OAUTH_ACCOUNT, accountUuid: "nested" } }, ".claude")
    const { store } = makeStore(null)

    const env = await resolveClaudeOauthEnv({ configDir: dir, credentialStore: store })

    expect(env.CLAUDE_CODE_ACCOUNT_UUID).toBe(FULL_OAUTH_ACCOUNT.accountUuid)
  })

  it("omits identity fields when .claude.json lacks oauthAccount", async () => {
    writeClaudeJson(dir, { unrelated: true })
    const { store } = makeStore(null)

    const env = await resolveClaudeOauthEnv({ configDir: dir, credentialStore: store })

    expect(env.CLAUDE_CODE_ACCOUNT_UUID).toBeUndefined()
    expect(env.CLAUDE_CODE_USER_EMAIL).toBeUndefined()
    expect(env.CLAUDE_CODE_ORGANIZATION_UUID).toBeUndefined()
  })

  it("omits only the missing sub-field", async () => {
    writeClaudeJson(dir, {
      oauthAccount: { accountUuid: FULL_OAUTH_ACCOUNT.accountUuid },
    })
    const { store } = makeStore(null)

    const env = await resolveClaudeOauthEnv({ configDir: dir, credentialStore: store })

    expect(env.CLAUDE_CODE_ACCOUNT_UUID).toBe(FULL_OAUTH_ACCOUNT.accountUuid)
    expect(env.CLAUDE_CODE_USER_EMAIL).toBeUndefined()
    expect(env.CLAUDE_CODE_ORGANIZATION_UUID).toBeUndefined()
  })

  it("ignores non-string sub-field values", async () => {
    writeClaudeJson(dir, {
      oauthAccount: {
        accountUuid: FULL_OAUTH_ACCOUNT.accountUuid,
        emailAddress: 42,
        organizationUuid: null,
      },
    })
    const { store } = makeStore(null)

    const env = await resolveClaudeOauthEnv({ configDir: dir, credentialStore: store })

    expect(env.CLAUDE_CODE_ACCOUNT_UUID).toBe(FULL_OAUTH_ACCOUNT.accountUuid)
    expect(env.CLAUDE_CODE_USER_EMAIL).toBeUndefined()
    expect(env.CLAUDE_CODE_ORGANIZATION_UUID).toBeUndefined()
  })

  it("does not throw on malformed .claude.json", async () => {
    writeFileSync(join(dir, ".claude.json"), "{not valid json", "utf-8")
    const { store } = makeStore(null)

    const env = await resolveClaudeOauthEnv({ configDir: dir, credentialStore: store })

    expect(env.CLAUDE_CODE_ENTRYPOINT).toBe("local-agent")
    expect(env.CLAUDE_CODE_ACCOUNT_UUID).toBeUndefined()
  })

  it("caches within TTL — credential store read only once", async () => {
    const { store, readCount } = makeStore({ accessToken: "t" })
    const now = () => 1_000_000

    await resolveClaudeOauthEnv({ configDir: dir, credentialStore: store, now })
    await resolveClaudeOauthEnv({ configDir: dir, credentialStore: store, now })

    expect(readCount()).toBe(1)
  })

  it("re-reads after invalidateClaudeOauthEnvCache", async () => {
    const { store, readCount } = makeStore({ accessToken: "t" })
    const now = () => 1_000_000

    await resolveClaudeOauthEnv({ configDir: dir, credentialStore: store, now })
    invalidateClaudeOauthEnvCache()
    await resolveClaudeOauthEnv({ configDir: dir, credentialStore: store, now })

    expect(readCount()).toBe(2)
  })

  it("re-reads after TTL expires", async () => {
    const { store, readCount } = makeStore({ accessToken: "t" })
    let t = 1_000_000
    const now = () => t

    await resolveClaudeOauthEnv({ configDir: dir, credentialStore: store, now })
    t += 30_001
    await resolveClaudeOauthEnv({ configDir: dir, credentialStore: store, now })

    expect(readCount()).toBe(2)
  })

  it("caches per-configDir independently", async () => {
    const otherDir = mkTmpConfigDir()
    try {
      const { store: s1, readCount: r1 } = makeStore({ accessToken: "a" })
      const { store: s2, readCount: r2 } = makeStore({ accessToken: "b" })
      const now = () => 1_000_000

      const env1 = await resolveClaudeOauthEnv({ configDir: dir, credentialStore: s1, now })
      const env2 = await resolveClaudeOauthEnv({ configDir: otherDir, credentialStore: s2, now })

      expect(env1.CLAUDE_CODE_OAUTH_TOKEN).toBe("a")
      expect(env2.CLAUDE_CODE_OAUTH_TOKEN).toBe("b")
      expect(r1()).toBe(1)
      expect(r2()).toBe(1)
    } finally {
      rmConfigDir(otherDir)
    }
  })
})
