import { mkdtempSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { ownedDir, pluginPaths } from "../src/process/paths.js"

// README's Uninstall names these folders, so they must not move.
describe("plugin paths", () => {
  it("uses Library/Caches and Library/Application Support on macOS", () => {
    expect(pluginPaths({}, "darwin", "/Users/u")).toEqual({ cacheDir: "/Users/u/Library/Caches/opencode-gws", stateDir: "/Users/u/Library/Application Support/opencode-gws" })
  })

  it("uses ~/.cache and ~/.local/state on Linux", () => {
    expect(pluginPaths({}, "linux", "/home/u")).toEqual({ cacheDir: "/home/u/.cache/opencode-gws", stateDir: "/home/u/.local/state/opencode-gws" })
  })

  it("follows an absolute XDG_CACHE_HOME and XDG_STATE_HOME on either platform, and ignores a relative one", () => {
    const env = { XDG_CACHE_HOME: "/x/cache", XDG_STATE_HOME: "/x/state" }
    for (const platform of ["darwin", "linux"] as const) {
      expect(pluginPaths(env, platform, "/home/u")).toEqual({ cacheDir: "/x/cache/opencode-gws", stateDir: "/x/state/opencode-gws" })
    }
    expect(pluginPaths({ XDG_CACHE_HOME: "cache", XDG_STATE_HOME: "" }, "linux", "/home/u")).toEqual({ cacheDir: "/home/u/.cache/opencode-gws", stateDir: "/home/u/.local/state/opencode-gws" })
  })

  it("creates an owned directory readable only by its owner, also when it already exists", () => {
    const root = mkdtempSync(join(tmpdir(), "gws-paths-"))
    try {
      const dir = ownedDir(join(root, "a", "b"))
      expect(statSync(dir).mode & 0o777).toBe(0o700)
      const existing = ownedDir(root)
      expect(statSync(existing).mode & 0o777).toBe(0o700)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
