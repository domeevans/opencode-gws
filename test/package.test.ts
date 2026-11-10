import { globSync, readFileSync } from "node:fs"
import { matchesGlob } from "node:path"
import { describe, expect, it } from "vitest"
import { GWS_TARGETS } from "../src/domain/backend.js"

/**
 * The published shape: a small JavaScript-only plugin with no runtime or host dependencies. The gws binary is not a
 * package: the plugin downloads its own pinned copy from its GitHub Release on first use (native/provenance.json and
 * manifest/native.json).
 */

const read = (path: string) => JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"))
const pkg = read("package.json")
const lock = read("package-lock.json")
const LIFECYCLE = ["preinstall", "install", "postinstall", "prepublish", "preprepare", "prepare", "postprepare", "prepack", "postpack"]

describe("main package", () => {
  it("has no publishConfig; the release workflow sets the publish flags", () => {
    expect(pkg.publishConfig).toBeUndefined()
  })

  it("is the first GitHub release, v0.0.0, under the tag's version (D19)", () => {
    expect(pkg.version).toBe("0.0.0")
  })

  it("declares no runtime, bundled or host peer dependencies and no engines or overrides", () => {
    for (const field of ["dependencies", "optionalDependencies", "peerDependencies", "peerDependenciesMeta", "bundleDependencies", "bundledDependencies", "engines", "overrides"]) {
      expect(pkg[field], field).toBeUndefined()
    }
  })

  it("names no per-platform gws package: the binary is the plugin's own pinned release asset", () => {
    expect(Object.keys(GWS_TARGETS)).toHaveLength(4)
    expect(JSON.stringify(pkg)).not.toMatch(/opencode-gws-bin/)
  })

  it("states the tested host line and has no lifecycle scripts", () => {
    expect(pkg.opencode).toMatchObject({
      host: ">=2.2.3 <2.3.0",
      vendor: { id: "google-workspace", name: "Google Workspace", domain: "workspace.google.com" },
      icons: [
        { src: "assets/icon.svg", mimeType: "image/svg+xml", sizes: ["any"] },
        { src: "assets/icon-128.png", mimeType: "image/png", sizes: ["128x128"] },
        { src: "assets/icon-256.png", mimeType: "image/png", sizes: ["256x256"] },
      ],
    })
    expect(LIFECYCLE.filter((name) => pkg.scripts[name] !== undefined)).toEqual([])
  })

  it("exports only the server part and the TUI part, with no declarations", () => {
    expect(pkg.exports).toEqual({
      ".": "./dist/index.js",
      "./tui": "./dist/tui.js",
      "./icon.svg": "./assets/icon.svg",
      "./icon-128.png": "./assets/icon-128.png",
      "./icon-256.png": "./assets/icon-256.png",
    })
  })

  it("whitelists the published files, including the release manifest and the upstream licence", () => {
    expect(pkg.files).toEqual([
      "dist",
      "assets/icon.svg",
      "assets/icon-128.png",
      "assets/icon-256.png",
      "skills",
      "manifest/generated.json",
      "manifest/native.json",
      "licenses/gws",
      "views/gmail-thread.html",
      "views/jelly-view.js",
      "README.md",
      "LICENSE",
      "NOTICE",
      "CHANGELOG.md",
    ])
  })

  it("pins every dev dependency exactly, with the OpenCode SDKs at 2.2.3", () => {
    expect(Object.entries(pkg.devDependencies).filter(([, version]) => !/^\d+\.\d+\.\d+$/.test(version as string))).toEqual([])
    for (const name of ["@opencode/plugin", "@opencode/sdk", "@opencode/client"]) expect(pkg.devDependencies[name], name).toBe("2.2.3")
  })
})

describe("lockfile", () => {
  it("matches package.json", () => {
    const root = lock.packages[""]
    expect(lock.lockfileVersion).toBe(3)
    expect([root.name, root.version]).toEqual([pkg.name, pkg.version])
    expect(root.optionalDependencies).toBeUndefined()
    expect(root.devDependencies).toEqual(pkg.devDependencies)
    expect(root.dependencies).toBeUndefined()
  })

  it("records no gws package: nothing optional is installed for the binary", () => {
    expect(Object.keys(lock.packages).filter((name) => name.includes("opencode-gws-bin"))).toEqual([])
  })
})

describe("upstream licence", () => {
  it("ships the Apache-2.0 licence and the notice for the gws executable it downloads", () => {
    expect(readFileSync(new URL("../licenses/gws/LICENSE", import.meta.url), "utf8")).toMatch(/^\s*Apache License\s+Version 2\.0, January 2004/)
    const notice = readFileSync(new URL("../licenses/gws/NOTICE", import.meta.url), "utf8")
    expect(notice).toContain("GitHub Release")
    expect(notice).toContain("https://github.com/googleworkspace/cli/releases/tag/v0.22.5")
    expect(notice).toContain("Apache License, Version 2.0")
  })
})

describe("declarations", () => {
  it("ships no type declarations: files names no directory that holds a .d.ts (S6)", () => {
    const declarations = globSync("**/*.d.{ts,mts,cts}", { cwd: new URL("../", import.meta.url), exclude: (name) => name === "node_modules" || name.startsWith(".") })
    for (const declaration of declarations) {
      expect(pkg.files.some((entry: string) => declaration === entry || declaration.startsWith(`${entry}/`) || matchesGlob(declaration, entry))).toBe(false)
    }
  })
})
