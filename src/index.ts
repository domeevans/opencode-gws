import { Plugin } from "@opencode/plugin"
import { loadConfig } from "./domain/config.js"
import { GwsError } from "./domain/errors.js"
import { HOST_RANGE, PLUGIN_ID, PLUGIN_VERSION, checkHost } from "./domain/version.js"
import { agentLister, registerApprovalRules } from "./host/agents.js"
import { planSummary, registerCommands } from "./host/commands.js"
import { integrationAuthReporter, integrationConnection, integrationIds, integrationTokenProvider, registerIntegrations } from "./host/integrations.js"
import { registerRpc, statusSource } from "./host/rpc.js"
import { registerSkills } from "./host/skills.js"
import { registerTools } from "./host/tools.js"
import { Runtime } from "./runtime/index.js"

/**
 * Entrypoint: options → host guard → runtime → host surfaces → cleanup.
 *
 * Setup performs local work only: config validation, trusted binary
 * resolution, a no-network version probe, and integration, tool, skill,
 * RPC, and command registration. It never calls a Google API and never
 * fetches Discovery.
 */
export default Plugin.define({
  id: PLUGIN_ID,
  async setup(ctx) {
    try {
      return await start(ctx)
    } catch (error) {
      // Every setup failure reads CODE: What happened. Next step: What to do.
      throw GwsError.from(error) ?? error
    }
  },
})

async function start(ctx: Plugin.Context): Promise<() => Promise<void>> {
  const config = loadConfig(ctx.options)
  const host = checkHost(ctx.app.version, HOST_RANGE, config.allowUntestedHost)
  const ids = integrationIds(config.accounts)

  const runtime = await Runtime.create(config, {
    pluginVersion: PLUGIN_VERSION,
    hostVersion: host.version,
    hostWarning: host.warning,
    projectDirectory: ctx.location.directory,
    tokenProvider: integrationTokenProvider(ctx, config, ids),
    connection: integrationConnection(ctx, ids),
    onAuthState: integrationAuthReporter(ctx, config, ids),
  })

  let stopRpc: (() => Promise<void>) | undefined
  let stopCommands: (() => Promise<void>) | undefined
  const close = async () => {
    const settled = runtime.close()
    try {
      await stopCommands?.()
      await stopRpc?.()
    } finally {
      await settled
    }
  }
  try {
    await registerIntegrations(ctx, config, ids)
    await registerApprovalRules(ctx)
    const status = statusSource(runtime, agentLister(ctx))
    await registerTools(ctx, runtime, status)
    await registerSkills(ctx, config, runtime.visibleServices())
    stopRpc = await registerRpc(ctx, runtime, status)
    stopCommands = await registerCommands(ctx, { status, plans: (sessionID) => runtime.plans.list({ sessionId: sessionID }).map(planSummary), doctor: runtime }, runtime.signal)
    runtime.audit.emit({ event: "plugin.loaded", outcome: "success" })
  } catch (error) {
    await close()
    throw error
  }

  return close
}
