import { readdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { helperAdapter } from "../src/domain/helpers.js"
import { loadManifest, resolveHelper, resolveMethod } from "../src/domain/manifest.js"
import { parseSkill, registerSkills } from "../src/host/skills.js"
import { toolSpecs } from "../src/host/tools.js"
import { testConfig } from "./support/config.js"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const SKILLS = join(ROOT, "skills")
const EXPECTED = ["opencode-gws", "opencode-gws-recipes"]
const JARGON = ["vitest", "fixture", "ctx.", "evidence", "PACK_", "verified on", "test status", "passing test", "failing test"]

const manifest = loadManifest()
const aliases = new Set(manifest.services.map((service) => service.alias))
const neverRun = new Set(["deny", "deploy", "watch"])

const skills = readdirSync(SKILLS, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => ({ dir: entry.name, text: readFileSync(join(SKILLS, entry.name, "SKILL.md"), "utf8") }))

function frontmatter(text: string): string {
  return /^---\n([\s\S]*?)\n---\n/.exec(text)?.[1] ?? ""
}

function operationIds(text: string): string[] {
  const ids = [...text.matchAll(/`([a-z][a-z0-9-]*(?:\.[A-Za-z][\w-]*)+)`/g)].map((match) => match[1] ?? "")
  for (const match of text.matchAll(/```json\n([\s\S]*?)```/g)) {
    const parsed = JSON.parse(match[1] ?? "") as { operation?: string }
    if (parsed.operation) ids.push(parsed.operation)
  }
  return ids.filter((id) => aliases.has(id.split(".")[0] ?? ""))
}

function executable(id: string): boolean {
  const parts = id.split(".")
  const method = parts.length >= 3 ? resolveMethod(parts[0]!, parts.slice(1, -1), parts.at(-1)!) : undefined
  if (method) return !neverRun.has(method.category) && method.schemaError === undefined
  const helper = resolveHelper(id)
  return helper !== undefined && helperAdapter(id) !== undefined && !neverRun.has(helper.category)
}

async function register(config = testConfig()): Promise<Array<{ id: string; autoinvoke: boolean; path: string; description: string }>> {
  const added: Array<{ id: string; autoinvoke: boolean; path: string; description: string }> = []
  await registerSkills(
    {
      skill: {
        transform: async (callback: (draft: { add: (skill: unknown) => void }) => void) => {
          callback({ add: (skill) => added.push(skill as never) })
        },
      },
    } as never,
    config,
  )
  return added
}

describe("two skills", () => {
  it("ships at most three skills, under stable ids", () => {
    expect(skills.length).toBeLessThanOrEqual(3)
    expect(skills.map((skill) => skill.dir).sort()).toEqual([...EXPECTED].sort())
    for (const { dir, text } of skills) {
      expect(dir).toMatch(/^opencode-gws(-[a-z0-9]+)*$/)
      expect(dir.length).toBeLessThanOrEqual(64)
      expect(frontmatter(text)).toMatch(new RegExp(`^name: ${dir}$`, "m"))
      expect(frontmatter(text)).toMatch(/^description: .*\b(Use|Load) (when|for|only)\b/m)
    }
  })

  it("registers both, auto-invoked, with the description from each file's frontmatter", async () => {
    const added = await register()
    expect(added.map((skill) => skill.id)).toEqual(EXPECTED)
    for (const skill of added) {
      expect(skill.autoinvoke).toBe(true)
      expect(skill.id.startsWith("gws-")).toBe(false)
      expect(skill.path).toBe(join(SKILLS, skill.id, "SKILL.md"))
      expect(frontmatter(readFileSync(skill.path, "utf8"))).toContain(`description: ${skill.description}`)
    }
  })

  it("registers none when skills.enabled is false", async () => {
    expect(await register(testConfig({ skills: { enabled: false } }))).toEqual([])
  })

  it("refuses a skill file without name and description frontmatter with SKILLS_INVALID", () => {
    expect(parseSkill("---\nname: x\ndescription: Use it.\n---\nBody", "x")).toEqual({ name: "x", description: "Use it.", content: "Body" })
    for (const raw of ["# No frontmatter", "---\nname: x\n---\nBody", "---\ndescription: Use it.\n---\nBody"]) {
      expect(() => parseSkill(raw, "skills/x/SKILL.md")).toThrow(/^SKILLS_INVALID: The skill file skills\/x\/SKILL\.md has no name and description frontmatter\./)
    }
  })
})

describe("skill content", () => {
  it("mentions only operation ids that exist and can run", () => {
    const unknown: string[] = []
    let checked = 0
    for (const { dir, text } of skills) {
      for (const id of operationIds(text)) {
        checked += 1
        if (!executable(id)) unknown.push(`${dir}: ${id}`)
      }
    }
    expect(unknown).toEqual([])
    expect(checked).toBeGreaterThan(0)
  })

  it("uses path parameters and a field mask on list and search examples", () => {
    const problems: string[] = []
    for (const { dir, text } of skills) {
      for (const match of text.matchAll(/```json\n([\s\S]*?)```/g)) {
        const example = JSON.parse(match[1] ?? "") as {
          operation?: string
          params?: Record<string, unknown>
          fields?: string
          input?: unknown
        }
        if (!example.operation) continue
        const parts = example.operation.split(".")
        const method = parts.length >= 3 ? resolveMethod(parts[0]!, parts.slice(1, -1), parts.at(-1)!) : undefined
        if (method) {
          const params = example.params ?? {}
          for (const found of (method.pathTemplate ?? "").matchAll(/\{\+?(\w+)\}/g)) {
            if (!(found[1]! in params)) problems.push(`${dir}: ${example.operation} missing ${found[1]}`)
          }
          if ((method.method === "list" || method.method === "search") && typeof example.fields !== "string") {
            problems.push(`${dir}: ${example.operation} list/search without fields`)
          }
        }
        const adapter = helperAdapter(example.operation)
        if (adapter) {
          const parsed = adapter.inputSchema.safeParse(example.input ?? {})
          if (!parsed.success) problems.push(`${dir}: ${example.operation} ${parsed.error.message}`)
        }
      }
    }
    expect(problems).toEqual([])
  })

  it("names only real tools", () => {
    const names = new Set(toolSpecs({} as never, async () => {}, async () => { throw new Error("unused") }).map((spec) => spec.name))
    expect(names.size).toBe(11)
    const bad: string[] = []
    for (const { dir, text } of skills) {
      for (const match of text.matchAll(/\bgws_(\w+)/g)) if (!names.has(match[1]!)) bad.push(`${dir}: gws_${match[1]}`)
    }
    expect(bad).toEqual([])
  })

  it("contains no test status or internal jargon, and does not tell the model to run gws", () => {
    for (const { dir, text } of skills) {
      const lower = text.toLowerCase()
      for (const word of JARGON) expect(lower, `${dir}: ${word}`).not.toContain(word.toLowerCase())
      expect(text, dir).not.toMatch(/^\s*gws\s+[a-z+]/m)
      expect(text, dir).not.toMatch(/```(?:bash|sh|shell)/)
      expect(text, dir).not.toMatch(/--params|--json|--dry-run/)
    }
  })
})
