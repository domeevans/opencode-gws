import type { Plugin } from "@opencode/plugin"
import { ACCESS_VALUES, CHANGING_ACTIONS, NAMESPACE_ACTION, READ_ACTIONS, type Access } from "../domain/access.js"

/**
 * Approval model: the default rules, through `ctx.agent.transform`. Every
 * tool is allowed at `access: "all"`; `access` narrows the block, and a
 * user's own rules and a saved "Always" still win, because the last
 * matching rule wins.
 *
 * The block is broad first, narrow last: the `gws.*` namespace, then every
 * read (always allowed), then the six commit actions with the value's
 * effect. At `all` every rule allows; `ask-changes` asks for the commits
 * and allows the reads; `read-only` denies the commits.
 *
 * Agents defined only in the user's config are created after plugins run, so
 * they miss these rules. Status names them, and only when the value holds
 * something back, with the block for that agent's own `permissions`. Never
 * put that block in the top-level `permissions`: top-level rules apply after
 * every agent's base rules and would loosen Explore.
 */

export interface Rule {
  action: string
  resource: string
  effect: "allow" | "deny" | "ask"
}

type Block = readonly Rule[]

/** The rules the plugin inserts after each agent's base allow, for one `access` value. */
export function defaultRules(access: Access = "all"): Block {
  const effect: Rule["effect"] = access === "all" ? "allow" : access === "ask-changes" ? "ask" : "deny"
  return [
    { action: NAMESPACE_ACTION, resource: "*", effect },
    ...READ_ACTIONS.map((action) => ({ action, resource: "*", effect: "allow" as const })),
    ...CHANGING_ACTIONS.map((action) => ({ action, resource: "*", effect })),
  ]
}

/** The block every `access` value produces, for the docs and for replacing an earlier one on a rebuild. */
const BLOCKS: readonly { readonly access: Access; readonly rules: Block }[] = ACCESS_VALUES.map((access) => ({ access, rules: defaultRules(access) }))

const same = (left: Rule | undefined, right: Rule) => left?.action === right.action && left?.resource === right.resource && left?.effect === right.effect

const isBaseAllow = (rule: Rule) => rule.action === "*" && rule.resource === "*" && rule.effect === "allow"

/** The start index of `block` appearing whole and in order in `rules`, or -1. */
function indexOfBlock(rules: readonly Rule[], block: Block): number {
  for (let start = 0; start + block.length <= rules.length; start += 1) {
    if (block.every((rule, offset) => same(rules[start + offset], rule))) return start
  }
  return -1
}

/**
 * Inserts the block for `access` immediately after the base `* * allow`. An
 * agent without one gets no rules: inserting at index 0 would turn its
 * default deny into an allow. A block already present, for this value or
 * another, is replaced, so a replay changes nothing and a later deny is
 * never moved.
 */
export function insertDefaultRules(rules: Rule[], access: Access = "all"): void {
  const base = rules.findIndex(isBaseAllow)
  if (base < 0) return
  const block = defaultRules(access)
  if (indexOfBlock(rules.slice(base + 1), block) >= 0) return
  // An earlier block for another value is replaced, so the new one is the last word.
  for (const candidate of BLOCKS) {
    const start = indexOfBlock(rules, candidate.rules)
    if (start >= 0) rules.splice(start, candidate.rules.length)
  }
  const at = rules.findIndex(isBaseAllow)
  rules.splice(at + 1, 0, ...block.map((rule) => ({ ...rule })))
}

/**
 * Every rule of the block appears somewhere after the base allow, in order.
 * Other plugins insert at the same index, so the block need not sit directly
 * after it. An agent without a base allow has no guarded position.
 */
export function hasDefaultRules(rules: readonly Rule[], access: Access = "all"): boolean {
  const base = rules.findIndex(isBaseAllow)
  if (base < 0) return false
  return indexOfBlock(rules, defaultRules(access)) > base
}

/** OpenCode's wildcard: `*` matches any run of characters. */
function matches(input: string, pattern: string): boolean {
  const source = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")
  return new RegExp(`^${source}$`).test(input)
}

function winner(action: string, rules: readonly Rule[]): Rule | undefined {
  for (let index = rules.length - 1; index >= 0; index -= 1) {
    const rule = rules[index]!
    if (matches(action, rule.action) && matches("*", rule.resource)) return rule
  }
  return undefined
}

/**
 * Agents that missed the rules and would run a commit without asking. At
 * `all` nothing is held back, so none needs the block. At a restricting
 * value, an agent whose own rules already allow or deny every commit is not
 * listed; one with a generic allow is.
 */
export function unguardedAgents(agents: readonly { readonly id: string; readonly permissions: readonly Rule[] }[], access: Access = "all"): string[] {
  if (access === "all") return []
  return agents
    .filter((agent) => !hasDefaultRules(agent.permissions, access))
    .filter((agent) =>
      CHANGING_ACTIONS.some((action) => {
        const rule = winner(action, agent.permissions)
        // No matching rule is the host's default deny, so only a generic allow leaves a commit unasked.
        return rule?.effect === "allow" && !rule.action.startsWith("gws.")
      }),
    )
    .map((agent) => agent.id)
}

/** The JSON block the user adds first in an unguarded agent's own permission list. Every rule has `resource`. */
export function permissionsBlock(agents: readonly string[], access: Access = "all"): string {
  const rules = defaultRules(access).map((rule) => `        ${JSON.stringify(rule)}`).join(",\n")
  return [
    "{",
    `  "agents": {`,
    `    ${JSON.stringify(agents[0] ?? "agent-name")}: {`,
    `      "permissions": [`,
    rules,
    `      ]`,
    `    }`,
    `  }`,
    "}",
  ].join("\n")
}

/** The agents of the plugin's project, for status. */
export function agentLister(ctx: Pick<Plugin.Context, "agent" | "location">): () => Promise<readonly { readonly id: string; readonly permissions: readonly Rule[] }[]> {
  return async () => {
    const directory = ctx.location?.directory
    return (await ctx.agent.list(directory ? { location: { directory } } : {})).data
  }
}

/** Registers the default rules in every agent the host knows at setup. */
export async function registerApprovalRules(ctx: Pick<Plugin.Context, "agent">, access: Access = "all"): Promise<void> {
  await ctx.agent.transform((editor) => {
    for (const agent of editor.list()) editor.update(agent.id, (current) => insertDefaultRules(current.permissions, access))
  })
}
