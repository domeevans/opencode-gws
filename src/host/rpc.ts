import { Gws, NOTHING_TO_DO, UNGUARDED_NEXT_STEP, type GwsAccount, type GwsState, type GwsStatus } from "../rpc.js"
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
  if (agents.length > 0) return UNGUARDED_NEXT_STEP
  return undefined
}

/**
 * An account that needs signing in comes first, then one whose headless
 * credential is unset. An untested release inside the range keeps the
 * working state: only host.tested and the OpenCode row say so. Outside the
 * range setup refuses with HOST_UNTESTED, so there is no status-only state.
 */
function stateOf(accounts: readonly GwsAccount[]): GwsState {
  if (accounts.some((account) => account.needsAuth || (!account.connected && account.mode === "interactive"))) return "sign_in_required"
  if (accounts.some((account) => !account.connected)) return "not_configured"
  return "connected"
}

/** Plugin status with each account's sign-in state and the unguarded agents. Never a token or a client secret. */
export function statusSource(runtime: Runtime, listAgents: AgentList): StatusSource {
  return async (signal) => {
    const base = await runtime.status(signal)
    const agents = unguardedAgents(await runtime.wait(() => listAgents(), signal))
    const next = nextStep(base.accounts, agents)
    return {
      version: base.version,
      host: base.host,
      state: stateOf(base.accounts),
      gws: { path: base.binary.path, version: base.binary.version },
      services: base.services,
      accounts: base.accounts,
      auditDegraded: base.auditDegraded,
      unguardedAgents: agents,
      ...(agents.length > 0 ? { permissionsBlock: permissionsBlock(agents) } : {}),
      nextStep: next ?? NOTHING_TO_DO,
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
