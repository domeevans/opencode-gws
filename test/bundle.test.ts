import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { moduleSpecifiers } from "./module-specifiers.js"

/**
 * The built entries (scripts/bundle.mjs, run by `npm run build`): exactly
 * dist/index.js and dist/tui.js, each one self-contained file with our code
 * and zod inside, and only what the host provides left as imports. No
 * relative import, import() or require, so a stale sibling module that a
 * running OpenCode still holds after an in-place update can never be loaded
 * alongside a new entry.
 */

const DIST = fileURLToPath(new URL("../dist/", import.meta.url))
const BUNDLE = existsSync(DIST) ? readdirSync(DIST).sort() : []
const read = (name: string) => readFileSync(join(DIST, name), "utf8")
const HOST_PROVIDED = /^(?:node:|@opencode\/plugin(?:\/|$)|@opentui\/|solid-js(?:\/|$))/

describe("entry bundles", () => {
  it("are exactly dist/index.js and dist/tui.js, with no chunk", () => {
    expect(BUNDLE, "run npm run build first").toEqual(["index.js", "tui.js"])
  })

  it("have no relative import, import() or require", () => {
    for (const name of BUNDLE) expect(moduleSpecifiers(read(name), name).filter((specifier) => !HOST_PROVIDED.test(specifier)), name).toEqual([])
  })

  it("import only @opencode/plugin and Node built-ins on the server, and the host's TUI modules in the TUI", () => {
    const server = new Set(moduleSpecifiers(read("index.js"), "index.js").filter((specifier) => !specifier.startsWith("node:")))
    expect([...server].sort()).toEqual(["@opencode/plugin", "@opencode/plugin/promise/tool", "@opencode/plugin/rpc"])
    expect([...new Set(moduleSpecifiers(read("tui.js"), "tui.js"))].sort()).toEqual(["@opencode/plugin/rpc", "@opentui/core", "@opentui/solid", "solid-js"])
  })

  /** The packages esbuild inlined into one bundle, from the `// node_modules/<package>/` path comments it writes. */
  const inlined = (name: string) => [...new Set([...read(name).matchAll(/^\/\/ node_modules\/((?:@[^/]+\/)?[^/]+)\//gm)].map((match) => match[1]!))].sort()

  it("bundles zod into the server part only, and nothing into the TUI part", () => {
    expect(inlined("index.js")).toEqual(["zod"])
    expect(inlined("tui.js")).toEqual([])
    expect(read("tui.js")).not.toMatch(/zod|\$Zod/i)
  })

  it("has a NOTICE that names exactly the packages the bundles inline", () => {
    const notice = readFileSync(new URL("../NOTICE", import.meta.url), "utf8")
    const named = notice.split("\n").filter((line) => /^@?[a-z0-9][a-z0-9._/-]*$/.test(line) && line !== "zod/v4").sort()
    expect(named).toEqual([...new Set(BUNDLE.flatMap(inlined))].sort())
  })

  it("bundles only the English zod locale", () => {
    const locales = [...read("index.js").matchAll(/node_modules\/zod\/v4\/locales\/[^/\s]+/g)].map((match) => match[0])
    expect([...new Set(locales)]).toEqual(["node_modules/zod/v4/locales/en.js"])
  })

  it("lets bundled modules find package files as if they sat at their source paths", () => {
    const index = read("index.js")
    expect(index).toContain('new URL("./domain/manifest.js", import.meta.url)')
    expect(index).toContain('new URL("./host/skills.js", import.meta.url)')
  })

  it("ships no declarations", () => {
    expect(readdirSync(DIST).filter((name) => name.endsWith(".d.ts"))).toEqual([])
  })

  it("carries the package.json version, set at build time", () => {
    const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }
    expect(read("index.js")).toContain(`PLUGIN_VERSION = ${JSON.stringify(version)}`)
    expect(read("index.js")).not.toContain("__PLUGIN_VERSION__")
  })
})
