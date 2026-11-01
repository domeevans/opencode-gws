import { chmodSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { isAbsolute, join } from "node:path"

/**
 * Plugin-owned directories. They hold no credential: OpenCode's credential
 * store keeps every token. Nothing here is shared with a `gws auth login`
 * or any project directory.
 */

export interface PluginPaths {
  /** Discovery caches: `accounts/<account>` per account and `discovery` for schema lookups. */
  cacheDir: string
  /** Durable state: the audit log. */
  stateDir: string
}

/**
 * `$XDG_CACHE_HOME/opencode-gws` and `$XDG_STATE_HOME/opencode-gws` when set
 * (absolute values only); otherwise the platform's cache and state homes.
 */
export function pluginPaths(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, home = homedir()): PluginPaths {
  const xdg = (name: string) => {
    const value = env[name]
    return value && isAbsolute(value) ? value : undefined
  }
  const mac = platform === "darwin"
  const cache = xdg("XDG_CACHE_HOME") ?? (mac ? join(home, "Library", "Caches") : join(home, ".cache"))
  const state = xdg("XDG_STATE_HOME") ?? (mac ? join(home, "Library", "Application Support") : join(home, ".local", "state"))
  return { cacheDir: join(cache, "opencode-gws"), stateDir: join(state, "opencode-gws") }
}

/** Create a plugin-owned directory, readable only by its owner, and return it. */
export function ownedDir(path: string): string {
  mkdirSync(path, { recursive: true, mode: 0o700 })
  // mkdir's mode is masked by the umask and ignored for an existing directory.
  chmodSync(path, 0o700)
  return path
}
