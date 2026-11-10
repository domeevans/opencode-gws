import { describe, expect, it } from "vitest"
import { CHANGING_ACTIONS } from "../src/domain/access.js"
import { loadConfig } from "../src/domain/config.js"
import { defaultRules } from "../src/host/agents.js"
import { type Declaration, type DeclaredTool, declarationProblems, docProblems, effectFromRules, readPackage } from "./support/jelly-kit.js"

/**
 * The `jelly` section of package.json, which Jelly reads without loading the plugin. Jelly's agents have no base
 * "allow everything" rule, so this plugin's own rules never reach them; Jelly writes each declared effect as that
 * tool's default instead. Every tool is allowed by default, commits included, so the declaration follows
 * `defaultRules("all")`. The shared kit checks the declaration against Jelly's plugin authors' standard. gws names
 * its permissions after risk actions (`gws.write`), not tools, because one commit tool covers a whole category.
 */

const ROOT = new URL("../", import.meta.url)
const jelly = readPackage(ROOT).jelly as Declaration & { tools: DeclaredTool[] }
const READS = ["gws.catalog", "gws.events_list", "gws.plan", "gws.read", "gws.schema", "gws.status"]
const RULES = defaultRules("all")

describe("the jelly declaration", () => {
  it("declares the flat access option", () => {
    const settings = (jelly.contributes as { settings: { key: string; type: string; default: unknown }[] }).settings
    expect(settings.map(({ key, type }) => ({ key, type }))).toEqual([{ key: "access", type: "string" }])
    expect(loadConfig({ access: "read-only" }).access).toBe("read-only")
    expect(settings[0]?.default).toBe(loadConfig({}).access)
  })
  it("follows the plugin authors' standard, with the effects the plugin's own default rules give", () => {
    expect(
      declarationProblems(ROOT, {
        effectOf: effectFromRules(RULES),
        registered: [...READS, ...CHANGING_ACTIONS],
        actionPermissions: true,
      }),
    ).toEqual([])
  })

  it("marks exactly the reads read-only", () => {
    expect(jelly.tools.filter((tool) => tool.readOnly).map((tool) => tool.permission).sort()).toEqual(READS)
  })
})

describe("docs/jelly.md", () => {
  it("follows the plugin authors' standard", () => {
    expect(docProblems(ROOT)).toEqual([])
  })
})
