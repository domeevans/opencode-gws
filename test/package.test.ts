import { globSync, readFileSync } from "node:fs"
import { matchesGlob } from "node:path"
import { describe, expect, it } from "vitest"
import { GWS_TARGETS, gwsPackage } from "../src/domain/backend.js"

/**
 * The published shape: a small JavaScript-only main package with no
 * runtime or host dependencies, and the gws binary in per-platform optional
 * packages at the same version.
 */

const read = (path: string) => JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"))
const pkg = read("package.json")
const lock = read("package-lock.json")
const template = read("packages/gws-bin/package.template.json")
const LIFECYCLE = ["preinstall", "install", "postinstall", "prepublish", "preprepare", "prepare", "postprepare", "prepack", "postpack"]

describe("main package", () => {
  it("has no publishConfig; the release workflow sets the publish flags", () => {
    expect(pkg.publishConfig).toBeUndefined()
  })

  it("declares no runtime, bundled or host peer dependencies and no engines or overrides", () => {
    for (const field of ["dependencies", "peerDependencies", "peerDependenciesMeta", "bundleDependencies", "bundledDependencies", "engines", "overrides"]) {
      expect(pkg[field], field).toBeUndefined()
    }
  })

  it("lists the four gws packages as optional dependencies at exactly its own version", () => {
    expect(pkg.optionalDependencies).toEqual(Object.fromEntries(Object.keys(GWS_TARGETS).sort().map((target) => [gwsPackage(target), pkg.version])))
  })

  it("states the tested host line and has no lifecycle scripts", () => {
    expect(pkg.opencode).toEqual({ host: ">=2.2.3 <2.3.0" })
    expect(LIFECYCLE.filter((name) => pkg.scripts[name] !== undefined)).toEqual([])
  })

  it("exports only the server part and the TUI part, with no declarations", () => {
    expect(pkg.exports).toEqual({ ".": "./dist/index.js", "./tui": "./dist/tui.js" })
  })

  it("whitelists the published files", () => {
    expect(pkg.files).toEqual(["dist", "assets/icon.svg", "skills", "manifest/generated.json", "views/gmail-thread.html", "views/jelly-view.js", "README.md", "LICENSE", "NOTICE", "CHANGELOG.md"])
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
    expect(root.optionalDependencies).toEqual(pkg.optionalDependencies)
    expect(root.devDependencies).toEqual(pkg.devDependencies)
    expect(root.dependencies).toBeUndefined()
  })

  it("records each gws package with its platform, so npm ci installs only the matching one", () => {
    for (const [target, entry] of Object.entries(GWS_TARGETS)) {
      expect(lock.packages[`node_modules/${gwsPackage(target)}`], target).toEqual({
        version: pkg.version,
        os: [entry.os],
        cpu: [entry.cpu],
        ...(entry.libc ? { libc: [entry.libc] } : {}),
        optional: true,
      })
    }
  })
})

describe("gws package template", () => {
  it("carries only the binary, its license, notice and provenance, with no scripts, bin links or dependencies", () => {
    expect(template).toMatchObject({
      license: "Apache-2.0",
      homepage: "https://github.com/joe-broadhead/opencode-gws#readme",
      bugs: { url: "https://github.com/joe-broadhead/opencode-gws/issues" },
      files: ["bin/gws", "LICENSE", "NOTICE", "provenance.json"],
    })
    expect(template.publishConfig).toBeUndefined()
    for (const field of ["name", "version", "private", "scripts", "bin", "main", "dependencies", "optionalDependencies", "os", "cpu", "libc"]) {
      expect(template[field], field).toBeUndefined()
    }
    expect(readFileSync(new URL("../packages/gws-bin/LICENSE", import.meta.url), "utf8")).toMatch(/^\s*Apache License\s+Version 2\.0, January 2004/)
  })

  it("ships no type declarations: files names no directory that holds a .d.ts (S6)", () => {
    const declarations = globSync("**/*.d.{ts,mts,cts}", { cwd: new URL("../", import.meta.url), exclude: (name) => name === "node_modules" || name.startsWith(".") })
    expect(declarations).toContain("views/jelly-view.d.ts")
    for (const declaration of declarations) {
      expect(pkg.files.some((entry: string) => declaration === entry || declaration.startsWith(`${entry}/`) || matchesGlob(declaration, entry))).toBe(false)
    }
  })
})
