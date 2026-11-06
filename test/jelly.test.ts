import { describe, expect, it } from "vitest"
import { ASK_RULES } from "../src/host/agents.js"
import { type Declaration, type DeclaredTool, declarationProblems, docProblems, effectFromRules, readPackage } from "./support/jelly-kit.js"

/**
 * The `jelly` section of package.json, which Jelly reads without loading the plugin. Jelly's agents have no base
 * "allow everything" rule, so this plugin's own ask rules never reach them; Jelly writes each declared "ask" as that
 * tool's default instead. The shared kit checks the declaration against Jelly's plugin authors' standard. gws names
 * its permissions after risk actions (`gws.write`), not tools, because one commit tool covers a whole category.
 */

const ROOT = new URL("../", import.meta.url)
const jelly = readPackage(ROOT).jelly as Declaration & { tools: DeclaredTool[] }
const READS = ["gws.catalog", "gws.plan", "gws.read", "gws.schema", "gws.status"]

describe("the jelly declaration", () => {
  it("follows the plugin authors' standard, with the effects the plugin's own ask rules give", () => {
    expect(
      declarationProblems(ROOT, {
        effectOf: effectFromRules(ASK_RULES),
        registered: [...READS, ...ASK_RULES.map((rule) => rule.action)],
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
