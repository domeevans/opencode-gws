import { Gws, type GwsAccount, type GwsStatus } from "../rpc.js"
import type { Runtime } from "../runtime/index.js"
import { permissionsBlock, unguardedAgents, type Rule } from "./agents.js"
import type { PluginContext } from "./context.js"

/**
 * The plugin's one status model and the `google-workspace.gws` RPC that
 * serves it. The RPC, the TUI dialog, /gws-status and gws_status all render
 * this model. Nothing here can approve or commit a plan; that stays with
 * the commit tools and the OpenCode permission prompt they raise.
 */

export type StatusSource = (signal?: AbortSignal) => Promise<GwsStatus>

type AgentList = () => Promise<readonly { readonly id: string; readonly permissions: readonly Rule[] }[]>

/** The first thing to do: an account's sign-in, then the unguarded agents. */
function nextStep(accounts: readonly GwsAccount[], agents: readonly string[]): string | undefined {
  const account = accounts.find((entry) => entry.nextStep)
  if (account?.nextStep) return accounts.length > 1 ? `${account.alias}: ${account.nextStep}` : account.nextStep
  if (agents.length > 0) return "Put the permission block first in the own permissions of each agent without default rules, followed by your top-level rules for gws actions."
  return undefined
}

/** Plugin status with each account's sign-in state and the unguarded agents. Never a token or a client secret. */
export function statusSource(runtime: Runtime, listAgents: AgentList): StatusSource {
  return async (signal) => {
    const base = await runtime.status(signal)
    const agents = unguardedAgents(await runtime.wait(() => listAgents(), signal))
    const next = nextStep(base.accounts, agents)
    return {
      pluginVersion: base.pluginVersion,
      hostVersion: base.hostVersion,
      ...(base.hostWarning ? { hostWarning: base.hostWarning } : {}),
      gws: { path: base.binary.path, version: base.binary.version },
      services: base.services,
      accounts: base.accounts,
      auditDegraded: base.auditDegraded,
      unguardedAgents: agents,
      ...(agents.length > 0 ? { permissionsBlock: permissionsBlock(agents) } : {}),
      ...(next ? { nextStep: next } : {}),
    }
  }
}

export async function registerRpc(ctx: PluginContext, runtime: Runtime, status: StatusSource): Promise<() => Promise<void>> {
  const registration = await ctx.rpc.register(Gws, {
    status: async (_input, context) => runtime.wait((signal) => status(signal), context.signal),
  })

  return async () => {
    await registration.dispose().catch(() => undefined)
  }
}
