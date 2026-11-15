import { describe, expect, it } from "vitest"
import { ACCESS_VALUES, CHANGING_ACTIONS } from "../src/domain/access.js"
import { loadConfig } from "../src/domain/config.js"
import { defaultRules } from "../src/host/agents.js"
import { type Declaration, type DeclaredTool, declarationProblems, docProblems, effectFromRules, readPackage } from "./support/jelly-kit.js"
import { ACCESS_CHOICES, type PluginSetting, settingChoices, settingsProblems, settingValueIssue } from "./support/jelly-settings.js"

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
  it("names each account with a value these options accept, so Jelly's added account loads", () => {
    const signIn = (jelly.signIns as { account?: { option: string; value?: Record<string, unknown> } }[]).find((entry) => entry.account)
    expect(signIn?.account?.option).toBe("accounts")
    const config = loadConfig({ accounts: { work: { ...signIn?.account?.value } } })
    // Every service the default account enables, with the sign-in form starting on Read-only.
    expect(config.accounts.work).toEqual({ mode: "interactive", enabledServices: loadConfig({}).accounts.default?.enabledServices, access: "read", scopes: [] })
  })

  it("declares no action and no settings section: an agent's UI hands the person's input back to its agent", () => {
    expect(jelly).not.toHaveProperty("actions")
    expect((jelly.views as { place: string }[]).map((view) => view.place)).not.toContain("settings-section")
    expect((jelly.rpc as { name: string }[]).map((method) => method.name)).toEqual(["calendar.today", "images.read"])
  })

  it("declares the flat access option, with Jelly's own words for its three values", () => {
    const settings = (jelly.contributes as { settings: PluginSetting[] }).settings
    expect(settings).toEqual([
      {
        key: "access",
        label: "Access",
        type: "string",
        description: "How much the plugin's tools may do. Generates default rules for agents with a base allow rule; plan-then-commit still applies.",
        choices: ACCESS_CHOICES,
        default: loadConfig({}).access,
      },
    ])
  })

  it("the settings follow Jelly's rules for a declared setting", () => {
    expect(settingsProblems((jelly.contributes as { settings: unknown }).settings)).toEqual([])
  })

  it("the options parser takes every declared access choice, its default included, and refuses a value outside them", () => {
    const access = (jelly.contributes as { settings: PluginSetting[] }).settings.find((setting) => setting.key === "access")!
    const values = (settingChoices(access) ?? []).map((choice) => choice.value)
    expect(values).toEqual([...ACCESS_VALUES])
    for (const value of values) expect<string>(loadConfig({ access: value }).access).toBe(value)
    expect<string>(loadConfig({}).access).toBe(access.default as string)
    expect(settingValueIssue(access, "write")).not.toBeNull()
    expect(() => loadConfig({ access: "write" })).toThrow("OPTIONS_INVALID")
  })

  it("follows the plugin authors' standard, with the effects the plugin's own default rules give", () => {
    const problems = declarationProblems(ROOT, {
      effectOf: effectFromRules(RULES),
      registered: [...READS, ...CHANGING_ACTIONS],
      actionPermissions: true,
    })
    // The shared kit's key list predates Jelly's `nativeData`, `imageHosts` and `imageRead` (hey-jelly
    // protocol/contracts/src/plugin-contract.ts, `PluginDeclarationSchema`); test/calendar.test.ts and
    // test/images.test.ts hold those fields to Jelly's rules. Any other problem fails.
    const newer = ["nativeData", "imageHosts", "imageRead"].map((key) => `jelly.${key} is not a key Jelly knows`)
    expect(problems.filter((problem) => !newer.includes(problem))).toEqual([])
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
