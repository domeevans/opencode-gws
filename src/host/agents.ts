import type { Plugin } from "@opencode/plugin"

/**
 * Approval model: default ask rules through `ctx.agent.transform`. A user
 * `permissions` allow rule and a saved "Always" on a write both remove the
 * prompt, because the last matching rule wins.
 *
 * Agents defined only in the user's config are created after plugins run, so
 * they miss these rules. Status names them and gives the per-agent block.
 * Never put that block in the top-level `permissions`: top-level rules apply
 * after every agent's base rules and would loosen Explore.
 */

export interface Rule {
  action: string
  resource: string
  effect: "allow" | "deny" | "ask"
}

const ASK_ACTIONS = ["gws.write", "gws.export", "gws.send", "gws.share", "gws.delete", "gws.admin"] as const

/** Reads (status, catalog, schema, read, plan) get no rule. */
export const ASK_RULES: readonly Rule[] = ASK_ACTIONS.map((action) => ({ action, resource: "*", effect: "ask" as const }))

const same = (left: Rule, right: Rule) => left.action === right.action && left.resource === right.resource && left.effect === right.effect

const isBaseAllow = (rule: Rule) => rule.action === "*" && rule.resource === "*" && rule.effect === "allow"

/**
 * Inserts any missing ask rules immediately after the base `* * allow`. An
 * agent without one gets no rules: inserting at index 0 would turn its
 * default deny into an ask. A rule already present is skipped, so a replay
 * changes nothing and a later deny is never moved.
 */
export function insertAskRules(rules: Rule[]): void {
  const base = rules.findIndex(isBaseAllow)
  if (base < 0) return
  let index = base + 1
  for (const rule of ASK_RULES) {
    if (rules.some((existing) => same(existing, rule))) continue
    rules.splice(index, 0, { ...rule })
    index += 1
  }
}

/**
 * Every ask rule appears somewhere after the base allow. Other plugins
 * insert at the same index, so the rules need not sit directly after it.
 * An agent without a base allow has no guarded position.
 */
export function hasAskRules(rules: readonly Rule[]): boolean {
  const base = rules.findIndex(isBaseAllow)
  if (base < 0) return false
  const after = rules.slice(base + 1)
  return ASK_RULES.every((rule) => after.some((found) => same(found, rule)))
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
 * Agents that missed the ask rules and would run a commit without asking.
 * A gws allow or deny already decides that commit, and no matching rule
 * denies it, so those agents are not listed. A generic allow is.
 */
export function unguardedAgents(agents: readonly { readonly id: string; readonly permissions: readonly Rule[] }[]): string[] {
  return agents
    .filter((agent) => !hasAskRules(agent.permissions))
    .filter((agent) =>
      ASK_ACTIONS.some((action) => {
        const rule = winner(action, agent.permissions)
        // No matching rule is the host's default deny, so only a generic allow leaves a commit unasked.
        return rule?.effect === "allow" && !rule.action.startsWith("gws.")
      }),
    )
    .map((agent) => agent.id)
}

/** The JSON block the user adds first in an unguarded agent's own permission list. Every rule has `resource`. */
export function permissionsBlock(agents: readonly string[]): string {
  const rules = ASK_RULES.map((rule) => `        ${JSON.stringify(rule)}`).join(",\n")
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

/** Registers the ask rules in every agent the host knows at setup. */
export async function registerApprovalRules(ctx: Pick<Plugin.Context, "agent">): Promise<void> {
  await ctx.agent.transform((editor) => {
    for (const agent of editor.list()) editor.update(agent.id, (current) => insertAskRules(current.permissions))
  })
}
