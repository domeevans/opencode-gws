import { Plugin } from "@opencode/plugin"
import { loadConfig } from "./domain/config.js"
import { GwsError } from "./domain/errors.js"
import { HOST_RANGE, checkHost } from "./domain/host.js"
import { PLUGIN_ID, PLUGIN_VERSION } from "./domain/version.js"
import { agentLister, registerApprovalRules } from "./host/agents.js"
import { planSummary, registerCommands } from "./host/commands.js"
import { integrationAuthReporter, integrationConnection, integrationIds, integrationTokenProvider, registerIntegrations } from "./host/integrations.js"
import { registerRpc, statusSource } from "./host/rpc.js"
import { registerSkills, skillLister } from "./host/skills.js"
import { registerTools } from "./host/tools.js"
import { METHODS, registerToolsRpc, scriptMethods } from "./host/tools-rpc.js"
import { Runtime } from "./runtime/index.js"

/**
 * Entrypoint: options → host guard → runtime → host surfaces → cleanup.
 *
 * Setup performs local work only: config validation, trusted binary
 * resolution, a no-network version probe, and integration, tool, skill,
 * RPC (status and tools), and command registration. It never calls a
 * Google API and never fetches Discovery.
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
    host,
    projectDirectory: ctx.location.directory,
    tokenProvider: integrationTokenProvider(ctx, config, ids),
    connection: integrationConnection(ctx, ids),
    onAuthState: integrationAuthReporter(ctx, config, ids),
  })

  let stopRpc: (() => Promise<void>) | undefined
  let stopToolsRpc: (() => Promise<void>) | undefined
  let stopCommands: (() => Promise<void>) | undefined
  const close = async () => {
    const settled = runtime.close()
    try {
      await stopCommands?.()
      await stopToolsRpc?.()
      await stopRpc?.()
    } finally {
      await settled
    }
  }
  try {
    await registerIntegrations(ctx, config, ids)
    await registerApprovalRules(ctx, config.access)
    const status = statusSource(runtime, agentLister(ctx), skillLister(ctx), config.access)
    await registerTools(ctx, runtime, status)
    await registerSkills(ctx, config)
    stopRpc = await registerRpc(ctx, runtime, status)
    stopToolsRpc = await registerToolsRpc(ctx, {
      methods: [...METHODS, ...scriptMethods({ runtime, assert: (request) => ctx.permission.assert(request as never), status })],
    })
    stopCommands = await registerCommands(ctx, {
      status,
      plans: (sessionID) => runtime.plans.list({ sessionId: sessionID }).map(planSummary),
      doctor: runtime,
      install: async (settled) => ({ path: await runtime.binaryFor({ signal: settled, mayDownload: async () => undefined }), version: runtime.version }),
    }, runtime.signal)
    runtime.audit.emit({ event: "plugin.loaded", outcome: "success" })
  } catch (error) {
    await close()
    throw error
  }

  return close
}
