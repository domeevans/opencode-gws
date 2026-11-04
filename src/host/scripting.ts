import { Rpc } from "@opencode/plugin/rpc"
import * as z from "zod"
import { GwsError } from "../domain/errors.js"
import { RPC_ID } from "../rpc.js"
import type { Runtime } from "../runtime/index.js"
import type { PluginContext } from "./context.js"
import { SCRIPT_MARK, type PermissionRequest, type ScriptCall } from "./permissions.js"
import type { StatusSource } from "./rpc.js"
import { type Assert, type Call, type ToolSpec, parse, toolSpecs } from "./tools.js"

/**
 * The tools RPC: every tool except the commit tools (status, catalog,
 * schema, read, plan) as an RPC method of the same name, so a script can
 * call the plugin through `opencode api` with no model.
 *
 *   POST /api/rpc/google-workspace.gws.tools/<tool>
 *   { "input": { "sessionID": "<session>", "input": <the tool's input> } }
 *
 * One definition: each method runs the tool's own spec, so its input,
 * output, policy, errors and permission asserts are the tool's. A script
 * runs as a session and the agent it names: the asserts evaluate that
 * agent's rules and the session's own, a plan binds to both, and an ask is
 * refused, because no one is there to answer it. The six commit tools are
 * excluded by name, not by their exposure, so no script can commit, and a
 * direct read such as gws_read stays a method.
 */

export const TOOLS_RPC_ID = `${RPC_ID}.tools`

/** The commit tools, by name: never RPC methods, whatever their exposure. */
export const COMMIT_TOOLS: ReadonlySet<string> = new Set(["write", "send", "share", "delete", "export", "admin"])

const UNATTENDED = "A script cannot answer an approval prompt; this needs an allow rule for the session's agent."

/** The envelope's messages: the wording every plugin's tools RPC shares (the shared tools-rpc README, "Envelope errors"). */
const ENVELOPE_MESSAGES = {
  notObject: `the envelope must be an object, such as {"sessionID":"<session>","input":<the tool's input>}`,
  unknownKey: (key: string) => `"${key}" is not allowed`,
  sessionID: `"sessionID" must be a non-empty string`,
  inputMissing: `"input" is missing`,
  describe: "describe takes no input",
} as const

type Envelope = { sessionID: string; input: unknown }
type Validation = { value: unknown } | { issues: Array<{ message: string }> }

const plainObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)

/**
 * A plain JSON Schema with a strict Standard Schema validator attached, not
 * enumerable, so the contract still reads as JSON Schema. OpenCode prefers
 * the validator, and answers its issues as rpc.invalid_input.
 */
function strict(schema: Record<string, unknown>, validate: (value: unknown) => Validation): Record<string, unknown> {
  return Object.defineProperty({ ...schema }, "~standard", { value: { version: 1, vendor: "opencode-gws", validate }, enumerable: false })
}

const ENVELOPE = strict(
  { type: "object", properties: { sessionID: { type: "string", minLength: 1 }, input: {} }, required: ["sessionID", "input"], additionalProperties: false },
  (value) => {
    if (!plainObject(value)) return { issues: [{ message: ENVELOPE_MESSAGES.notObject }] }
    const found = [
      ...Object.keys(value).filter((key) => key !== "sessionID" && key !== "input").map(ENVELOPE_MESSAGES.unknownKey),
      ...(typeof value["sessionID"] === "string" && value["sessionID"] !== "" ? [] : [ENVELOPE_MESSAGES.sessionID]),
      ...("input" in value ? [] : [ENVELOPE_MESSAGES.inputMissing]),
    ]
    return found.length === 0 ? { value } : { issues: found.map((message) => ({ message })) }
  },
)

/** describe's input: nothing, or an empty object. */
const DESCRIBE_INPUT = strict({ type: "object", properties: {}, additionalProperties: false }, (value) =>
  value === undefined || value === null || (plainObject(value) && Object.keys(value).length === 0) ? { value } : { issues: [{ message: ENVELOPE_MESSAGES.describe }] },
)

/** Every method's one declared error: the code from the error table and its next step. */
const Failure = z.strictObject({ code: z.string(), next: z.string() })

const Description = z.strictObject({
  id: z.string(),
  call: z.string(),
  methods: z.array(
    z.strictObject({
      name: z.string(),
      action: z.string(),
      description: z.string(),
      input: z.record(z.string(), z.unknown()),
      output: z.record(z.string(), z.unknown()),
    }),
  ),
})
type Description = z.output<typeof Description>

type Spec = ToolSpec<z.ZodType, z.ZodType>
type Context = { signal: AbortSignal; error: (type: "failed", message: string, data: z.output<typeof Failure>) => unknown }

/** True when OpenCode refused a session lookup because the session does not exist: its Session.NotFoundError, or an HTTP 404. */
function sessionNotFound(error: unknown): boolean {
  if (error === null || typeof error !== "object") return false
  const record = error as Record<string, unknown>
  const tag = record["_tag"] ?? record["name"]
  return tag === "Session.NotFoundError" || tag === "SessionNotFoundError" || record["status"] === 404 || record["statusCode"] === 404
}

export async function registerScripting(ctx: PluginContext, runtime: Runtime, status: StatusSource): Promise<() => Promise<void>> {
  // A refused assert becomes PERMISSION_DENIED, so a script reads one error shape.
  const assert: Assert = async (request) => {
    try {
      await ctx.permission.assert(request as never)
    } catch (error) {
      throw denied(request, error)
    }
  }
  const specs = toolSpecs(runtime, assert, status).filter((spec) => !COMMIT_TOOLS.has(spec.name))
  const description = describe(specs)

  const session = async (sessionID: string, signal: AbortSignal): Promise<ScriptCall> => {
    let agent: string | undefined
    try {
      agent = (await runtime.wait(() => ctx.session.get({ sessionID: sessionID as never }), signal)).agent
    } catch (error) {
      // Only OpenCode's "no such session" is SESSION_UNKNOWN; any other failure propagates as it is.
      if (sessionNotFound(error)) throw new GwsError("SESSION_UNKNOWN", `there is no session '${sessionID}'`)
      throw error
    }
    if (!agent) throw new GwsError("SESSION_AGENT_REQUIRED", `session '${sessionID}' names no agent`)
    return { sessionID, agent, script: true }
  }

  const invoke = async (spec: Spec, raw: unknown, context: Context): Promise<unknown> => {
    try {
      runtime.assertActive(context.signal)
      const { sessionID, input } = raw as Envelope
      const host = await session(sessionID, context.signal)
      const call: Call = { host, runtime: { sessionId: sessionID, agentId: host.agent, signal: context.signal, caller: "rpc" } }
      const outcome = await spec.run(parse(spec.input, input), call)
      // RPC output must be a JSON value: drop undefined keys such as an unpaged read's pagination.
      return JSON.parse(JSON.stringify(outcome.output))
    } catch (error) {
      const known = GwsError.from(error)
      if (!known) throw error
      return context.error("failed", known.message, { code: known.code, next: known.next })
    }
  }

  const contract = Rpc.define({
    id: TOOLS_RPC_ID,
    methods: {
      describe: { input: DESCRIBE_INPUT, output: Description },
      ...Object.fromEntries(specs.map((spec) => [spec.name, { input: ENVELOPE, output: spec.output, errors: { failed: Failure } }])),
    },
    events: {},
  })
  const handlers = {
    describe: async () => description,
    ...Object.fromEntries(specs.map((spec) => [spec.name, (raw: unknown, context: Context) => invoke(spec, raw, context)])),
  }
  const registration = await ctx.rpc.register(contract, handlers as never)

  // A script's ask has no one to answer it: refuse it now instead of leaving a prompt that waits.
  const hook = await ctx.permission.hook("evaluate", (evaluation) => {
    if (evaluation.effect !== "ask" || evaluation.metadata?.[SCRIPT_MARK] !== true || !evaluation.action.startsWith("gws.")) return
    evaluation.effect = "deny"
    evaluation.message = UNATTENDED
  })

  return async () => {
    await hook.dispose().catch(() => undefined)
    await registration.dispose().catch(() => undefined)
  }
}

function denied(request: PermissionRequest, error: unknown): GwsError {
  const known = GwsError.from(error)
  if (known?.code === "CANCELLED") return known
  const reason = error instanceof Error && error.message ? error.message : "refused"
  return new GwsError("PERMISSION_DENIED", `${request.action} on ${request.resources.join(", ")} was refused for this session's agent: ${reason}`)
}

/** What a script author needs: each method's permission action and its input and output as JSON Schema. */
function describe(specs: readonly Spec[]): Description {
  return {
    id: TOOLS_RPC_ID,
    call: `POST /api/rpc/${TOOLS_RPC_ID}/<method> with {"input":{"sessionID":"<session>","input":<the tool's input>}}`,
    methods: specs.map((spec) => ({
      name: spec.name,
      action: spec.action,
      description: spec.description,
      input: z.toJSONSchema(spec.input, { io: "input", unrepresentable: "any" }) as Record<string, unknown>,
      output: z.toJSONSchema(spec.output, { io: "output", unrepresentable: "any" }) as Record<string, unknown>,
    })),
  }
}
