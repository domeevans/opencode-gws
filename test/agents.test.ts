import { describe, expect, it } from "vitest"
import { CHANGING_ACTIONS, NAMESPACE_ACTION, READ_ACTIONS, type Access } from "../src/domain/access.js"
import { defaultRules, hasDefaultRules, insertDefaultRules, permissionsBlock, unguardedAgents, type Rule } from "../src/host/agents.js"

/**
 * The default rules: the block every agent gets after its base allow. At the
 * default `access: "all"` every rule allows, and so does the plugin's
 * namespace, so a tool a later release adds runs at once; `ask-changes` and
 * `read-only` are how a user restricts the commits.
 */

const base = (): Rule => ({ action: "*", resource: "*", effect: "allow" })
const effectOf = (access: Access) => (access === "all" ? "allow" : access === "ask-changes" ? "ask" : "deny") as Rule["effect"]

describe("the default rules", () => {
  it("are the namespace, then every read, then the six commits, with the value's effect", () => {
    for (const access of ["all", "ask-changes", "read-only"] as const) {
      const block = defaultRules(access)
      expect(block).toEqual([
        { action: NAMESPACE_ACTION, resource: "*", effect: effectOf(access) },
        ...READ_ACTIONS.map((action) => ({ action, resource: "*", effect: "allow" as const })),
        ...CHANGING_ACTIONS.map((action) => ({ action, resource: "*", effect: effectOf(access) })),
      ])
    }
    // The default is `all`: every tool the plugin registers, and the namespace, allowed.
    expect(defaultRules().every((rule) => rule.effect === "allow")).toBe(true)
    expect(defaultRules()).toEqual(defaultRules("all"))
  })

  it("inserts the block immediately after the base allow, and a replay changes nothing", () => {
    const rules = [base()]
    insertDefaultRules(rules)
    expect(rules).toEqual([base(), ...defaultRules("all")])
    const again = rules.map((rule) => ({ ...rule }))
    insertDefaultRules(rules)
    expect(rules).toEqual(again)
  })

  it("replaces a block for another value, so a changed option is not undone by the old block", () => {
    const rules = [base()]
    insertDefaultRules(rules, "ask-changes")
    insertDefaultRules(rules, "read-only")
    expect(rules).toEqual([base(), ...defaultRules("read-only")])
  })

  it("leaves an agent without a base allow alone, so its default deny stays a deny", () => {
    const deny = { action: "gws.*", resource: "*", effect: "deny" as const }
    const denied = [deny]
    insertDefaultRules(denied)
    expect(denied).toEqual([deny])
    const empty: Rule[] = []
    insertDefaultRules(empty)
    expect(empty).toEqual([])
  })

  it("counts the block as present whole, in order, anywhere after the base allow", () => {
    const rules = defaultRules("ask-changes")
    const other = { action: "other.write", resource: "*", effect: "ask" as const }
    expect(hasDefaultRules([base(), other, ...rules], "ask-changes")).toBe(true)
    expect(hasDefaultRules([...rules, base()], "ask-changes")).toBe(false)
    expect(hasDefaultRules([...rules], "ask-changes")).toBe(false)
    expect(hasDefaultRules([base(), ...rules.slice(1)], "ask-changes")).toBe(false)
    // The block for one value is not the block for another.
    expect(hasDefaultRules([base(), ...rules.slice(1), rules[0]!], "ask-changes")).toBe(false)
  })

  it("names an agent whose winning rule would allow a commit; at `all` nothing is held back", () => {
    const rules = defaultRules("ask-changes")
    const guarded = { id: "build", permissions: [base(), ...rules] }
    const missed = { id: "notes", permissions: [base()] }
    const opted = { id: "writer", permissions: [base(), { action: "gws.write", resource: "*", effect: "allow" as const }] }
    const locked = { id: "plan", permissions: [base(), { action: "gws.*", resource: "*", effect: "deny" as const }] }
    // Another plugin inserted its own block at the same index, after ours.
    const shared = { id: "general", permissions: [base(), { action: "other.write", resource: "*", effect: "ask" as const }, ...rules] }
    const bare = { id: "readonly", permissions: [] }
    const listed = [guarded, missed, opted, locked, shared, bare]
    expect(unguardedAgents(listed, "ask-changes")).toEqual(["notes", "writer"])
    expect(unguardedAgents(listed, "read-only")).toEqual(["notes", "writer"])
    expect(unguardedAgents(listed)).toEqual([])
    expect(unguardedAgents(listed, "all")).toEqual([])
    const block = permissionsBlock(["notes"], "ask-changes")
    expect(block).toContain('"notes": {')
    expect(block).toContain(`"${NAMESPACE_ACTION}"`)
    expect(block).toContain('"resource":"*"')
    expect(block).toContain('"effect":"ask"')
    expect(block).toContain('"agents"')
  })
})
