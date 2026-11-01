import { execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { loadConfig } from "../src/domain/config.js"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

function trackedFiles(pattern: string): string[] {
  return execFileSync("git", ["ls-files", pattern], { cwd: ROOT, encoding: "utf8" }).split("\n").filter(Boolean)
}

describe("repository hygiene", () => {
  it("ships an example config whose plugin options load", () => {
    const raw = readFileSync(join(ROOT, "examples", "opencode.jsonc"), "utf8")
    const json = raw
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("//"))
      .join("\n")
    const example = JSON.parse(json) as { plugins: Array<{ options?: unknown }> }
    expect(example.plugins.length).toBeGreaterThan(0)
    for (const plugin of example.plugins) expect(() => loadConfig(plugin.options)).not.toThrow()
    expect(raw).not.toMatch(/\/Users\/(?!me\b)[\w.-]+/)
  })

  it("keeps generated docs in sync with the source", () => {
    expect(() =>
      execFileSync(process.execPath, [join(ROOT, "scripts", "generate-docs.mjs"), "--check"], { stdio: "pipe" }),
    ).not.toThrow()
  })

  it("has no broken relative Markdown links", () => {
    const broken: string[] = []
    for (const file of trackedFiles("*.md")) {
      const text = readFileSync(join(ROOT, file), "utf8")
      for (const match of text.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
        const target = match[1] ?? ""
        if (/^(?:[a-z]+:|#)/i.test(target)) continue
        const path = target.split("#")[0] ?? ""
        if (!existsSync(join(ROOT, dirname(file), path))) broken.push(`${file} -> ${target}`)
      }
    }
    expect(broken).toEqual([])
  })
})
