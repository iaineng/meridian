/**
 * Resolves the 4 OAuth-related env vars that the Claude Agent SDK subprocess
 * expects when acting as a local agent (Claude Max auth path):
 *
 *   - CLAUDE_CODE_OAUTH_TOKEN       — access token; source priority:
 *       1. <configDir>/setup-token (single-line file, trimmed)
 *       2. platform credential store (macOS Keychain / Linux file)
 *   - CLAUDE_CODE_ACCOUNT_UUID      — oauthAccount.accountUuid from .claude.json
 *   - CLAUDE_CODE_USER_EMAIL        — oauthAccount.emailAddress from .claude.json
 *   - CLAUDE_CODE_ORGANIZATION_UUID — oauthAccount.organizationUuid from .claude.json
 *
 * CLAUDE_CODE_ENTRYPOINT is intentionally NOT managed here — the SDK picks its
 * own default, and the parent process's value (if any) flows through.
 *
 * Leaf module — no imports from server.ts, session/, pipeline/, or handlers/.
 *
 * Cache: keyed by configDir, TTL 30s.
 *
 * Best-effort: any read/parse failure yields `undefined` for the affected key
 * (the env var is simply omitted). The module never throws — a misconfigured
 * host must not break the SDK call path.
 */

import { execFile as execFileCb } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { homedir, platform, userInfo } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { claudeLog } from "../logger"

const execFile = promisify(execFileCb)

const KEYCHAIN_SERVICE = "Claude Code-credentials"
const CREDENTIALS_FILE = `${homedir()}/.claude/.credentials.json`

interface OAuthCredentials {
  accessToken: string
}

interface CredentialsFile {
  claudeAiOauth: OAuthCredentials
  [key: string]: unknown
}

/** Read-only credential store interface — injectable for testing. */
export interface CredentialStore {
  read(): Promise<CredentialsFile | null>
}

function parseKeychainValue(raw: string): CredentialsFile | null {
  const trimmed = raw.trim()
  try {
    return JSON.parse(trimmed) as CredentialsFile
  } catch {}
  try {
    const decoded = Buffer.from(trimmed, "hex").toString("utf-8")
    return JSON.parse(decoded) as CredentialsFile
  } catch {}
  return null
}

const macosStore: CredentialStore = {
  async read() {
    try {
      const { stdout } = await execFile(
        "/usr/bin/security",
        ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", userInfo().username, "-w"],
        { timeout: 5000 }
      )
      const parsed = parseKeychainValue(stdout)
      if (!parsed) throw new Error("Could not parse keychain value as JSON or hex-encoded JSON")
      return parsed
    } catch (err) {
      claudeLog("oauth_env.keychain_read_failed", { error: String(err) })
      return null
    }
  },
}

const fileStore: CredentialStore = {
  async read() {
    try {
      if (!existsSync(CREDENTIALS_FILE)) return null
      return JSON.parse(readFileSync(CREDENTIALS_FILE, "utf-8")) as CredentialsFile
    } catch (err) {
      claudeLog("oauth_env.file_read_failed", { error: String(err) })
      return null
    }
  },
}

/**
 * Returns the appropriate credential store for the current platform.
 */
export function createPlatformCredentialStore(): CredentialStore {
  return platform() === "darwin" ? macosStore : fileStore
}

export const CLAUDE_OAUTH_ENV_KEYS = [
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_ACCOUNT_UUID",
  "CLAUDE_CODE_USER_EMAIL",
  "CLAUDE_CODE_ORGANIZATION_UUID",
] as const

export interface ClaudeOauthEnv {
  CLAUDE_CODE_OAUTH_TOKEN?: string
  CLAUDE_CODE_ACCOUNT_UUID?: string
  CLAUDE_CODE_USER_EMAIL?: string
  CLAUDE_CODE_ORGANIZATION_UUID?: string
}

export interface ClaudeOauthEnvSources {
  /** Base directory to probe. Defaults to `homedir()`. */
  configDir?: string
  /** Credential store override for tests. Defaults to the platform store. */
  credentialStore?: CredentialStore
  /** Clock override for tests. Defaults to Date.now. */
  now?: () => number
}

const CACHE_TTL_MS = 30_000

interface CacheEntry {
  env: ClaudeOauthEnv
  readAt: number
}

const cache = new Map<string, CacheEntry>()

function readSetupToken(configDir: string): string | undefined {
  const path = join(configDir, "setup-token")
  if (!existsSync(path)) return undefined
  try {
    const v = readFileSync(path, "utf-8").trim()
    return v || undefined
  } catch (err) {
    claudeLog("oauth_env.setup_token_read_failed", { error: String(err) })
    return undefined
  }
}

async function readTokenFromStore(store: CredentialStore): Promise<string | undefined> {
  try {
    const creds = await store.read()
    const token = creds?.claudeAiOauth?.accessToken
    return typeof token === "string" && token.length > 0 ? token : undefined
  } catch (err) {
    claudeLog("oauth_env.credentials_read_failed", { error: String(err) })
    return undefined
  }
}

interface ParsedOauthAccount {
  accountUuid?: string
  emailAddress?: string
  organizationUuid?: string
}

function readOauthAccount(configDir: string): ParsedOauthAccount {
  // Probe both `<configDir>/.claude.json` (home layout) and
  // `<configDir>/.claude/.claude.json` (docker entrypoint symlink target).
  const candidates = [
    join(configDir, ".claude.json"),
    join(configDir, ".claude", ".claude.json"),
  ]
  for (const path of candidates) {
    if (!existsSync(path)) continue
    try {
      const raw = JSON.parse(readFileSync(path, "utf-8")) as { oauthAccount?: unknown }
      const acc = raw?.oauthAccount
      if (!acc || typeof acc !== "object") return {}
      const a = acc as Record<string, unknown>
      return {
        accountUuid: typeof a.accountUuid === "string" ? a.accountUuid : undefined,
        emailAddress: typeof a.emailAddress === "string" ? a.emailAddress : undefined,
        organizationUuid: typeof a.organizationUuid === "string" ? a.organizationUuid : undefined,
      }
    } catch (err) {
      claudeLog("oauth_env.claude_json_parse_failed", { path, error: String(err) })
    }
  }
  return {}
}

export async function resolveClaudeOauthEnv(
  sources?: ClaudeOauthEnvSources,
): Promise<ClaudeOauthEnv> {
  const configDir = sources?.configDir ?? homedir()
  const now = (sources?.now ?? Date.now)()

  const hit = cache.get(configDir)
  if (hit && now - hit.readAt < CACHE_TTL_MS) return hit.env

  const store = sources?.credentialStore ?? createPlatformCredentialStore()

  const token =
    readSetupToken(configDir) ?? (await readTokenFromStore(store))
  const account = readOauthAccount(configDir)

  const env: ClaudeOauthEnv = {}
  if (token) env.CLAUDE_CODE_OAUTH_TOKEN = token
  if (account.accountUuid) env.CLAUDE_CODE_ACCOUNT_UUID = account.accountUuid
  if (account.emailAddress) env.CLAUDE_CODE_USER_EMAIL = account.emailAddress
  if (account.organizationUuid) env.CLAUDE_CODE_ORGANIZATION_UUID = account.organizationUuid

  cache.set(configDir, { env, readAt: now })
  return env
}
