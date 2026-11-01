import { describe, expect, it } from "vitest"
import { ASK_RULES, hasAskRules, insertAskRules, permissionsBlock, unguardedAgents, type Rule } from "../src/host/agents.js"

const base = (): Rule => ({ action: "*", resource: "*", effect: "allow" })

describe("ask rules", () => {
  it("inserts the six asks immediately after the base allow, and a replay changes nothing", () => {
    const rules = [base()]
    insertAskRules(rules)
    expect(rules).toEqual([base(), ...ASK_RULES])
    const again = rules.map((rule) => ({ ...rule }))
    insertAskRules(rules)
    expect(rules).toEqual(again)
  })

  it("leaves an agent without a base allow alone, so its default deny stays a deny", () => {
    const deny = { action: "gws.*", resource: "*", effect: "deny" as const }
    const denied = [deny]
    insertAskRules(denied)
    expect(denied).toEqual([deny])
    const empty: Rule[] = []
    insertAskRules(empty)
    expect(empty).toEqual([])
  })

  it("counts the asks as present anywhere after the base allow, but not before it", () => {
    const other = { action: "other.write", resource: "*", effect: "ask" as const }
    expect(hasAskRules([base(), other, ...ASK_RULES])).toBe(true)
    expect(hasAskRules([...ASK_RULES, base()])).toBe(false)
    expect(hasAskRules([...ASK_RULES])).toBe(false)
    expect(hasAskRules([base(), ...ASK_RULES.slice(1)])).toBe(false)
  })

  it("names an agent whose winning rule would allow a commit without asking", () => {
    const guarded = { id: "build", permissions: [base(), ...ASK_RULES] }
    const missed = { id: "notes", permissions: [base()] }
    const opted = { id: "writer", permissions: [base(), ...ASK_RULES.map((rule) => ({ ...rule, effect: "allow" as const }))] }
    const locked = { id: "plan", permissions: [base(), { action: "gws.*", resource: "*", effect: "deny" as const }] }
    // Another plugin inserted its own block at the same index, after ours.
    const shared = { id: "general", permissions: [base(), { action: "other.write", resource: "*", effect: "ask" as const }, ...ASK_RULES] }
    const bare = { id: "readonly", permissions: [] }
    expect(unguardedAgents([guarded, missed, opted, locked, shared, bare])).toEqual(["notes"])
    const block = permissionsBlock(["notes"])
    expect(block).toContain('"notes": {')
    expect(block).toContain('"resource":"*"')
    expect(block).toContain('"agents"')
  })
})
