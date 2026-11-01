import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll } from "vitest"
import { loadConfig } from "../../src/domain/config.js"
import { commandIndex } from "../../src/domain/manifest.js"
import { ACCESS_SCOPES, IDENTITY_SCOPES } from "../../src/domain/scopes.js"
import type { AccessLevel, OAuthClient, PluginConfig } from "../../src/domain/types.js"
import type { PluginPaths } from "../../src/process/paths.js"
import type { RuntimeOptions } from "../../src/runtime/accounts.js"
import { Runtime } from "../../src/runtime/index.js"

/**
 * Plugin-options, account and runtime builders. Tests build config only
 * through these, so a change to the account or option shape touches this
 * file and the tests that exercise that shape, nothing else.
 */

const REPO = fileURLToPath(new URL("../../", import.meta.url))

/** The fake gws fixture. Absolute, so it is a valid `binary.path`. */
export const FAKE_GWS = fileURLToPath(new URL("../fixtures/fake-gws.mjs", import.meta.url))

/** The account alias every builder uses unless told otherwise. */
export const ACCOUNT = "personal"

/** A Desktop app client in Google's format. Not a real client. */
export const TEST_CLIENT: OAuthClient = { clientId: "1234567890-testclient.apps.googleusercontent.com", clientSecret: "test-client-secret" }

interface AccountOptions {
  /** Enabled services; default `["gmail"]`. */
  services?: string[]
  access?: AccessLevel | Record<string, AccessLevel>
  scopes?: string[]
  oauthClient?: OAuthClient
}

/** One interactive account, spelled as plugin options spell it. */
export function account(options: AccountOptions = {}): Record<string, unknown> {
  const { services, ...rest } = options
  return { mode: "interactive", enabledServices: services ?? ["gmail"], ...rest }
}

/** Plugin options: the fake gws and one `personal` account, plus any top-level overrides. */
export function pluginOptions(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { binary: { path: FAKE_GWS }, accounts: { [ACCOUNT]: account() }, ...overrides }
}

/** The loaded config for `pluginOptions(overrides)`. */
export function testConfig(overrides: Record<string, unknown> = {}): PluginConfig {
  return loadConfig(pluginOptions(overrides))
}

const scratch: string[] = []
afterAll(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** Fresh plugin-owned directories under a temporary root, removed after the file's tests. */
function testPaths(): PluginPaths {
  const root = mkdtempSync(join(tmpdir(), "opencode-gws-paths-"))
  scratch.push(root)
  return { cacheDir: join(root, "cache"), stateDir: join(root, "state") }
}

/** The plugin-owned gws directory of an account, where the fake gws logs its invocations. */
export function accountDir(paths: PluginPaths, alias = ACCOUNT): string {
  return join(paths.cacheDir, "accounts", alias)
}

/** Every scope the manifest and the access table know: a sign-in that granted everything. */
export const ALL_SCOPES: readonly string[] = [
  ...new Set([
    ...[...commandIndex().methods.values()].flatMap((method) => method.scopes),
    ...Object.values(ACCESS_SCOPES).flatMap((sets) => [...sets.read, ...sets.write]),
    ...IDENTITY_SCOPES,
  ]),
]

export const STORED_TOKEN = "ya29.stored-access-token-never-shown"
export const STORED_REFRESH = "1//stored-refresh-token-never-shown"

/** A stored Google sign-in, as the host's `connection.resolve` returns it. */
export function storedSignIn(access: AccessLevel, grantedScopes: readonly string[], clientSource = "pasted") {
  return {
    type: "oauth" as const,
    methodID: "google",
    access: STORED_TOKEN,
    refresh: STORED_REFRESH,
    expires: Date.now() + 3_600_000,
    metadata: { clientId: TEST_CLIENT.clientId, clientSecret: TEST_CLIENT.clientSecret, clientSource, access, requestedScopes: [...grantedScopes], grantedScopes: [...grantedScopes] },
  }
}

/** A token provider that signs every account in with the same fake token and grant. */
export function fakeTokens(token = "ya29.fake-test-token", grantedScopes: readonly string[] = ALL_SCOPES): NonNullable<RuntimeOptions["tokenProvider"]> {
  return async () => ({ access: token, grantedScopes })
}

let launcher: string | undefined

/**
 * A shell launcher for the fake gws. Account-free probes run with an empty
 * PATH, so it pins this Node binary. It lives under the repository, because
 * binary trust rejects world-writable ancestors such as /tmp.
 */
function fakeGwsLauncher(): string {
  if (launcher) return launcher
  const dir = mkdtempSync(join(REPO, ".fake-gws-"))
  scratch.push(dir)
  const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`
  launcher = join(dir, "gws")
  writeFileSync(launcher, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(FAKE_GWS)} "$@"\n`, { mode: 0o700 })
  return launcher
}

/**
 * A runtime over `pluginOptions(overrides)`, with audit off, fresh plugin
 * directories (so each account's directory, where the fake gws logs its
 * invocations, starts empty), and the fake token provider unless
 * overridden. Without `binary` it runs the fake gws. The caller closes the
 * runtime.
 */
export async function testRuntime(overrides: Record<string, unknown> = {}, options: Partial<RuntimeOptions> = {}): Promise<Runtime> {
  const defaults: Record<string, unknown> = { audit: { enabled: false } }
  if (!("binary" in overrides)) defaults["binary"] = { path: fakeGwsLauncher() }
  const config = loadConfig({ ...pluginOptions(), ...defaults, ...overrides })
  return Runtime.create(config, { pluginVersion: "test", paths: testPaths(), tokenProvider: fakeTokens(), ...options })
}
