/**
 * The tools RPC, `google-workspace.gws.tools`: every read tool, and with the `rpcCommits` option every commit tool, as
 * an RPC method, so a script can call it with no model, plus the source contract's `probe`, `calendar_today` and
 * `images_read`.
 *
 *   POST /api/rpc/google-workspace.gws.tools/<method>
 *   { "input": { "sessionID": "<session>", "input": <the tool's input> } }
 *
 * The transport is the source contract's `tools-rpc` module (`@we-the-rebel-alliance/source-contract`, version 2.3,
 * bundled into dist/index.js): the family's shared v2 module, unchanged for a method without a resource resolver, and
 * gws declares none. What v2 kept between the PLUGIN-SPECIFIC markers is here: the plugin's id, its methods, its next
 * steps and its error mapping. gws has no `execute.before` or `execute.after` hook, so it passes no shapers: a script's
 * arguments reach the tool, and its result comes back, exactly as a model's do.
 */
import {
  type Failure,
  type JsonSchema,
  type MethodSpec,
  type NextSteps,
  type PluginMethod,
  type ToolsRpcContext,
  type ToolsRpcPlugin,
  registerToolsRpc as registerPackageRpc,
  toolsRpcId,
} from "@we-the-rebel-alliance/source-contract/tools-rpc"
import * as z from "zod"
import { GwsError } from "../domain/errors.js"
import { RPC_ID, unguardedCommitsText } from "../rpc.js"
import type { Runtime } from "../runtime/index.js"
import { unguardedAgents, type Rule as AgentRule } from "./agents.js"
import { nativeGate } from "./permissions.js"
import type { StatusSource } from "./rpc.js"
import { sourceMethods } from "./sources.js"
import { parse, toolSpecs, type Assert, type ToolClass } from "./tools.js"

/** The plugin's id. The RPC id is `<PLUGIN_ID>.tools`: `google-workspace.gws.tools`, `package.json` `sources.rpc`. */
export const PLUGIN_ID = RPC_ID
export const TOOLS_RPC_ID = toolsRpcId(PLUGIN_ID)

/**
 * gws has no MCP server, so its methods are plugin-owned tools from `toolSpecs`, each with its name, action, schemas,
 * permission asserts, run function and class. `scriptMethods` turns those specs into the module's methods.
 *
 * By default only the read tools are methods (status, catalog, schema, read, plan and events_list), with the source
 * contract's three reads that are not tools (probe, calendar_today and images_read, `./sources.ts`), so a script can
 * plan a change but a commit runs only from the model's approved tool. With the `rpcCommits` option, which a host turns
 * on only when it confirms each change on its own screen before it calls the RPC, the six commit tools (write, send,
 * share, delete, export and admin) are methods too. A commit method runs the commit tool's own spec: the plan stays
 * single-use and bound to the account, session and agent that made it, the commit asserts its own action, and an
 * `ask` on that action is refused like any other.
 */
export interface MethodSources {
  readonly runtime: Runtime
  /** The host's permission check: the tool's own asserts run inside its spec, exactly as on the model path. */
  readonly assert: Assert
  readonly status: StatusSource
  /**
   * The host's agents, for the names a commit method's describe gives: the agents without the default rules. Without
   * it, describe names none.
   */
  readonly listAgents?: () => Promise<readonly { readonly id: string; readonly permissions: readonly AgentRule[] }[]>
}

/** How long one agent listing serves the commit methods' describe notes: one describe pass reads it once. */
const UNGUARDED_TTL_MS = 1000

export function scriptMethods(sources: MethodSources): readonly MethodSpec[] {
  return [...toolMethods(sources), ...sourceMethods(sources)]
}

/** The tool specs as methods: the read tools, and the six commits when `rpcCommits` is on. */
function toolMethods(sources: MethodSources): readonly MethodSpec[] {
  const commits = sources.runtime.config.rpcCommits
  // The agents without the default rules, from the agent list alone: one listing, shared by the six commit methods'
  // describe notes for a second, so a describe pass lists the agents once. A failed listing names none.
  let cached: { readonly at: number; readonly names: Promise<readonly string[]> } | undefined
  const unguardedNames = (): Promise<readonly string[]> => {
    const { listAgents } = sources
    if (!listAgents) return Promise.resolve([])
    const now = Date.now()
    if (cached && now - cached.at < UNGUARDED_TTL_MS) return cached.names
    const names = listAgents().then(
      (agents) => unguardedAgents(agents, sources.runtime.config.access),
      () => [],
    )
    cached = { at: now, names }
    return names
  }
  return toolSpecs(sources.runtime, sources.assert, sources.status)
    .filter((spec) => commits || spec.class === "read")
    .map((spec): PluginMethod => {
      // A commit method's describe names the agents without the default rules, whose scripts commit without asking.
      // describe awaits `available` and then reads `description`, so `available` refreshes the names it reads.
      // Only the agent list is read, never the runtime's status.
      let unguarded: readonly string[] = []
      return {
        kind: "plugin",
        name: spec.name,
        action: spec.action,
        class: spec.class satisfies ToolClass,
        ...(spec.exposure.codemode ? {} : { directOnly: true }),
        get description() {
          return unguarded.length > 0 ? `${spec.description} Note: ${unguardedCommitsText(unguarded)}.` : spec.description
        },
        ...(spec.class === "read"
          ? {}
          : {
              async available() {
                unguarded = await unguardedNames()
                return undefined
              },
            }),
        input: schemaOf(spec.input, "input"),
        output: schemaOf(spec.output, "output"),
        async run(input, call) {
          // The tool's own input check, its policy, its asserts and its error mapping are the model path's: a script
          // calls the same spec. A script call still carries a tool source id, so this RPC's evaluate hook can refuse
          // an inner ask instead of leaving a prompt no one answers.
          const host = { sessionID: call.sessionID, agent: call.agent, messageID: call.messageID, id: call.id }
          const runtime = { sessionId: call.sessionID, agentId: call.agent, signal: call.signal, caller: "rpc" as const, mayDownload: nativeGate(host, sources.assert) }
          const outcome = await spec.run(parse(spec.input, input, spec.invalid), { host, runtime })
          return outcome.output
        },
      }
    })
}

/**
 * A tool's Zod schema as the plain JSON Schema describe reports. If the converter cannot represent a schema, the
 * method reports the shared module's empty object schema rather than failing describe.
 */
function schemaOf(schema: z.ZodType, io: "input" | "output"): JsonSchema {
  try {
    return z.toJSONSchema(schema, { io, unrepresentable: "any" }) as JsonSchema
  } catch {
    return { type: "object" }
  }
}

/** The next step for each code. Each is one sentence that ends with a full stop. */
export const NEXT_STEPS: NextSteps = {
  SESSION_UNKNOWN: `Create a session in the location you mean, such as POST /api/session with {"agent":"build"} sent with the header "x-opencode-directory: <dir>" or the location[directory] query, and pass its id.`,
  SESSION_AGENT_REQUIRED: `Create a session that names an agent this project has, with its project as the location, such as POST /api/session with {"agent":"build","location":{"directory":"/path/to/project"}}, and pass its id.`,
  PERMISSION_DENIED: "Add an allow rule for the action to the session's agent or to the session, or use a session whose agent allows it.",
  CANCELLED: "Call the method again if you still need the result.",
}

/**
 * A gws failure from a tool's own spec: its code, what happened and its next step, as the model reads them. Every
 * code in the error table is passed through, so a refusal a caller can act on keeps its own remedy.
 */
export function pluginError(error: unknown): Failure | undefined {
  const known = GwsError.from(error)
  if (!known) return undefined
  return { code: known.code, what: known.detail, next: known.next }
}

/** v2's PLUGIN-SPECIFIC block, as the package takes it. */
export const PLUGIN: ToolsRpcPlugin = { id: PLUGIN_ID, nextSteps: NEXT_STEPS, pluginError }

/** Register the tools RPC with the plugin's methods. The host's context is passed whole; the package reads its parts structurally. */
export function registerToolsRpc(ctx: unknown, methods: readonly MethodSpec[]): Promise<() => Promise<void>> {
  return registerPackageRpc(ctx as ToolsRpcContext, { plugin: PLUGIN, methods })
}
