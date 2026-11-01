import { mkdirSync } from "node:fs"
import { join } from "node:path"
import type { AccountProfile } from "../domain/types.js"

/** Child environments for `gws`: inherited minus every ambient Google credential. */

const FORBIDDEN_ENV = [
  "GOOGLE_WORKSPACE_CLI_TOKEN",
  "GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE",
  "GOOGLE_WORKSPACE_CLI_CLIENT_ID",
  "GOOGLE_WORKSPACE_CLI_CLIENT_SECRET",
  "GOOGLE_WORKSPACE_CLI_CONFIG_DIR",
  "GOOGLE_WORKSPACE_CLI_KEYRING_BACKEND",
  "GOOGLE_WORKSPACE_CLI_SANITIZE_MODE",
  "GOOGLE_WORKSPACE_CLI_SANITIZE_TEMPLATE",
  "GOOGLE_WORKSPACE_PROJECT_ID",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_CLOUD_PROJECT",
  "GCLOUD_PROJECT",
  "CLOUDSDK_CONFIG",
]

/** The runtime supplies a private mkdtemp directory, removed when it closes. */
function ownedHome(workDir: string): Record<string, string> {
  const home = join(workDir, "home")
  mkdirSync(home, { recursive: true, mode: 0o700 })
  return {
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, "config"),
    LOCALAPPDATA: join(home, "data"),
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_DATA_HOME: join(home, ".local", "share"),
  }
}

/**
 * The environment for one account's gws call. `accountDir` is the
 * plugin-owned per-account directory: gws keeps its Discovery cache there,
 * and in credentials_file mode its encrypted token cache.
 */
export function buildChildEnv(profile: AccountProfile, accountDir: string, workDir: string, accessToken?: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value
  }
  for (const key of FORBIDDEN_ENV) delete env[key]
  Object.assign(env, ownedHome(workDir))

  env["GOOGLE_WORKSPACE_CLI_CONFIG_DIR"] = accountDir
  // A token bypasses gws's credential store. A credentials file does not:
  // gws caches the exchanged token encrypted, and "file" keeps that key in
  // accountDir rather than the OS keychain, which would prompt on a headless host.
  if (profile.mode === "credentials_file") env["GOOGLE_WORKSPACE_CLI_KEYRING_BACKEND"] = "file"
  env["TMPDIR"] = workDir
  env["TMP"] = workDir
  env["TEMP"] = workDir

  // The access token comes from the OpenCode integration credential store and
  // exists only in this child environment. It is never placed in argv, audit
  // records, previews, or error messages.
  if (accessToken) env["GOOGLE_WORKSPACE_CLI_TOKEN"] = accessToken

  if (profile.mode === "credentials_file" && profile.credentialsFileEnv) {
    const value = process.env[profile.credentialsFileEnv]
    if (!value) throw new Error(`AUTH_REQUIRED: ${profile.credentialsFileEnv} is not set. Next step: Set it to the path of the credentials file and restart OpenCode.`)
    env["GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE"] = value
  }
  if (profile.mode === "access_token" && profile.tokenEnv) {
    const value = process.env[profile.tokenEnv]
    if (!value) throw new Error(`AUTH_REQUIRED: ${profile.tokenEnv} is not set. Next step: Set it to a current access token and restart OpenCode.`)
    env["GOOGLE_WORKSPACE_CLI_TOKEN"] = value
  }
  return env
}

/**
 * Account-free probes. Schema lookups fetch public Discovery documents into
 * `discoveryDir` (the persistent plugin cache); the version probe needs none.
 */
export function localEnv(workDir: string, discoveryDir = join(workDir, "discovery")): Record<string, string> {
  return {
    ...ownedHome(workDir),
    PATH: "",
    TMPDIR: workDir,
    GOOGLE_WORKSPACE_CLI_CONFIG_DIR: discoveryDir,
  }
}
