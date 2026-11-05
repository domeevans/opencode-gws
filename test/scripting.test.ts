import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { statusSource } from "../src/host/rpc.js"
import { ErrorCode } from "../src/domain/errors.js"
import { COMMIT_TOOLS, TOOLS_RPC_ID, registerScripting } from "../src/host/scripting.js"
import { toolSpecs } from "../src/host/tools.js"
import type { Runtime } from "../src/runtime/index.js"
import { accountDir, testRuntime } from "./support/config.js"

type Handler = (input: unknown, context: ReturnType<typeof rpcContext>) => Promise<unknown>
type Evaluation = { action: string; effect: "allow" | "deny" | "ask"; metadata?: Record<string, unknown>; message?: string }
type Request = Record<string, unknown> & { action: string; resources: string[] }

interface Harness {
  runtime: Runtime
  contract: { id: string; methods: Record<string, unknown> }
  handlers: Record<string, Handler>
  asserts: Request[]
  hook: (evaluation: Evaluation) => void
  disposed: string[]
  stop: () => Promise<void>
}

let harness: Harness | undefined

afterEach(async () => {
  await harness?.stop()
  await harness?.runtime.close()
  harness = undefined
})

interface SetupOptions {
  /** Sessions the host knows, with their agents. */
  sessions?: Record<string, { agent?: string }>
  /** The host's answer to each assert; resolves by default. */
  assert?: (request: Request) => Promise<void>
  /** Replaces the session lookup, for host failures other than "not found". */
  lookup?: (sessionID: string) => Promise<unknown>
}

async function setup(options: SetupOptions = {}): Promise<Harness> {
  const runtime = await testRuntime()
  const sessions = options.sessions ?? { ses_1: { agent: "build" } }
  const handlers: Record<string, Handler> = {}
  const asserts: Request[] = []
  const disposed: string[] = []
  let contract: Harness["contract"] | undefined
  let hook: Harness["hook"] | undefined
  const ctx = {
    rpc: {
      register: async (definition: Harness["contract"], registered: Record<string, Handler>) => {
        contract = definition
        Object.assign(handlers, registered)
        return { dispose: async () => { disposed.push("rpc") } }
      },
    },
    permission: {
      assert: async (request: Request) => {
        asserts.push(request)
        await options.assert?.(request)
      },
      hook: async (name: string, callback: Harness["hook"]) => {
        expect(name).toBe("evaluate")
        hook = callback
        return { dispose: async () => { disposed.push("hook") } }
      },
    },
    session: {
      get: async ({ sessionID }: { sessionID: string }) => {
        if (options.lookup) return options.lookup(sessionID)
        const session = sessions[sessionID]
        // OpenCode rejects with its tagged Session.NotFoundError.
        if (!session) throw Object.assign(new Error(`Session not found: ${sessionID}`), { _tag: "Session.NotFoundError", sessionID })
        return { id: sessionID, ...session }
      },
    },
  }
  const stop = await registerScripting(ctx as never, runtime, statusSource(runtime, async () => []))
  harness = { runtime, contract: contract!, handlers, asserts, hook: hook!, disposed, stop }
  return harness
}

function rpcContext(signal = new AbortController().signal) {
  return { signal, error: (type: string, message: string, data?: unknown) => ({ type, message, data, handlerError: true }) }
}

function invocations(runtime: Runtime): string[] {
  const log = join(accountDir(runtime.paths), "invocations.jsonl")
  return existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : []
}

const get = { operation: "gmail.users.messages.get", params: { userId: "me", id: "m1" } }
const call = (h: Harness, method: string, input: unknown, sessionID = "ses_1", context = rpcContext()) => h.handlers[method]!({ sessionID, input }, context)

describe("tools RPC contract", () => {
  it("exposes every non-commit tool and describe, never a commit tool", async () => {
    const h = await setup()
    expect(h.contract.id).toBe(TOOLS_RPC_ID)
    expect(TOOLS_RPC_ID).toBe("google-workspace.gws.tools")
    expect(Object.keys(h.contract.methods).sort()).toEqual(["catalog", "describe", "plan", "read", "schema", "status"])
    for (const commit of ["write", "send", "share", "delete", "export", "admin"]) expect(h.handlers[commit]).toBeUndefined()
  })

  it("excludes the commit tools by name, so a direct tool such as read stays a method and no commit tool ever becomes one", async () => {
    const h = await setup()
    const specs = toolSpecs(h.runtime, async () => undefined, statusSource(h.runtime, async () => []))
    const commits = specs.filter((spec) => ["gws.write", "gws.send", "gws.share", "gws.delete", "gws.export", "gws.admin"].includes(spec.action))
    expect(commits.map((spec) => spec.name).sort()).toEqual([...COMMIT_TOOLS].sort())
    const read = specs.find((spec) => spec.name === "read")!
    expect(read.exposure.codemode).toBe(false)
    for (const spec of specs) expect(Object.hasOwn(h.contract.methods, spec.name), spec.name).toBe(!COMMIT_TOOLS.has(spec.name))
    expect(Object.hasOwn(h.contract.methods, "read")).toBe(true)
  })

  it("describes each method's permission action and its input and output as JSON Schema", async () => {
    const h = await setup()
    const description = (await h.handlers.describe!({}, rpcContext())) as { id: string; methods: Array<Record<string, any>> }
    expect(description.id).toBe(TOOLS_RPC_ID)
    expect(description.methods.map((method) => [method.name, method.action])).toEqual([
      ["status", "gws.status"],
      ["catalog", "gws.catalog"],
      ["schema", "gws.schema"],
      ["read", "gws.read"],
      ["plan", "gws.plan"],
    ])
    const read = description.methods.find((method) => method.name === "read")!
    expect(read.input).toMatchObject({ type: "object", properties: { operation: expect.any(Object) } })
    expect(read.output).toMatchObject({ type: "object", properties: { data: expect.anything(), truncated: expect.any(Object) } })
    expect(JSON.parse(JSON.stringify(description))).toEqual(description)
  })
})

describe("envelope errors", () => {
  /** The issues OpenCode reports for a method's input, from the strict validator it prefers. */
  const issues = (h: Harness, method: string, value: unknown): string[] => {
    const input = (h.contract.methods[method] as { input: { "~standard": { validate: (value: unknown) => { issues?: Array<{ message: string }> } } } }).input
    return (input["~standard"].validate(value).issues ?? []).map((issue) => issue.message)
  }

  it("uses the wording every plugin's tools RPC shares", async () => {
    const h = await setup()
    expect(issues(h, "read", { sessionID: "ses_1", input: {} })).toEqual([])
    expect(issues(h, "read", "text")).toEqual(['the envelope must be an object, such as {"sessionID":"<session>","input":<the tool\'s input>}'])
    expect(issues(h, "read", { sessionID: "ses_1", input: {}, extra: 1 })).toEqual(['"extra" is not allowed'])
    expect(issues(h, "read", { operation: "gmail.users.messages.list", params: {}, fields: "x" })).toEqual([
      '"operation" is not allowed',
      '"params" is not allowed',
      '"fields" is not allowed',
      '"sessionID" must be a non-empty string',
      '"input" is missing',
    ])
    expect(issues(h, "read", { sessionID: "", input: {} })).toEqual(['"sessionID" must be a non-empty string'])
    expect(issues(h, "describe", undefined)).toEqual([])
    expect(issues(h, "describe", {})).toEqual([])
    expect(issues(h, "describe", { sessionID: "ses_1" })).toEqual(["describe takes no input"])
  })

  it("gives the shared next steps for a missing session, a session without an agent, and a refusal", () => {
    expect(ErrorCode.SESSION_UNKNOWN.next).toBe('Create a session that names an agent, such as POST /api/session with {"agent":"build"}, and pass its id.')
    expect(ErrorCode.SESSION_AGENT_REQUIRED.next).toBe(ErrorCode.SESSION_UNKNOWN.next)
    expect(ErrorCode.PERMISSION_DENIED.next).toBe("Add an allow rule for the tool to the session's agent or to the session, or use a session whose agent allows it.")
  })
})

describe("a script's call", () => {
  it("runs read as the session: asserts gws.read for the session's agent, marked as a script, with no tool source", async () => {
    const h = await setup()
    const emit = vi.spyOn(h.runtime.audit, "emit")
    const output = await call(h, "read", get)
    expect(output).toMatchObject({ ok: true, operation: "gmail.users.messages.get", category: "read", truncated: false })
    expect(output).not.toHaveProperty("pagination")
    expect(JSON.parse(JSON.stringify(output))).toEqual(output)
    expect(h.asserts).toEqual([
      {
        sessionID: "ses_1",
        agent: "build",
        action: "gws.read",
        resources: ["personal:gmail.users.messages.get"],
        save: ["personal:gmail.users.messages.get"],
        metadata: { script: true, account: "personal", operation: "gmail.users.messages.get", service: "gmail", category: "read" },
      },
    ])
    expect(invocations(h.runtime)).toHaveLength(1)
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ event: "operation.read", outcome: "success", caller: "rpc" }))
  })

  it("binds a plan to the script's session and agent, so only that session can commit it", async () => {
    const h = await setup()
    const emit = vi.spyOn(h.runtime.audit, "emit")
    const output = (await call(h, "plan", { operation: "gmail.users.labels.create", params: { userId: "me" }, body: { name: "x" } })) as { planId: string; category: string }
    expect(output).toMatchObject({ ok: true, category: "write", planId: expect.any(String) })
    expect(h.runtime.plans.list({ sessionId: "ses_1" }).map((plan) => plan.id)).toEqual([output.planId])
    expect(() => h.runtime.inspectPlan("write", { planId: output.planId }, { sessionId: "ses_1", agentId: "other" })).toThrow(/^PLAN_CALLER_MISMATCH:/)
    expect(h.asserts.map((request) => request.action)).toEqual(["gws.plan"])
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ event: "operation.plan", outcome: "success", caller: "rpc" }))
  })

  it("answers status, catalog and schema through the same specs as the tools", async () => {
    const h = await setup()
    expect(await call(h, "status", {})).toMatchObject({ accounts: [expect.objectContaining({ alias: "personal" })], unguardedAgents: 0 })
    expect(await call(h, "catalog", { query: "send email", service: "gmail" })).toMatchObject({ entries: expect.arrayContaining([expect.objectContaining({ id: "gmail.users.messages.send" })]) })
    expect(await call(h, "schema", { operation: "gmail.users.messages.get" })).toMatchObject({ ok: true, account: "personal" })
    expect(h.asserts.map((request) => request.action)).toEqual(["gws.status", "gws.catalog", "gws.schema"])
    for (const request of h.asserts) expect(request.metadata).toMatchObject({ script: true })
  })
})

describe("refusals", () => {
  const failure = (code: string) => ({ type: "failed", handlerError: true, message: expect.stringMatching(new RegExp(`^${code}: .+ Next step: `)), data: { code, next: expect.any(String) } })

  it("turns a refused assert into PERMISSION_DENIED, and gws never runs", async () => {
    const h = await setup({ assert: async () => { throw new Error("denied by the agent's rules") } })
    expect(await call(h, "read", get)).toMatchObject(failure("PERMISSION_DENIED"))
    expect(invocations(h.runtime)).toEqual([])
  })

  it("refuses an unknown session with SESSION_UNKNOWN before any assert", async () => {
    const h = await setup()
    expect(await call(h, "read", get, "ses_missing")).toMatchObject(failure("SESSION_UNKNOWN"))
    expect(h.asserts).toEqual([])
  })

  it("reports a 404 from the session lookup as SESSION_UNKNOWN too", async () => {
    const h = await setup({ lookup: async () => { throw Object.assign(new Error("Not Found"), { status: 404 }) } })
    expect(await call(h, "read", get)).toMatchObject(failure("SESSION_UNKNOWN"))
  })

  it("lets any other session lookup failure propagate unchanged, never as SESSION_UNKNOWN", async () => {
    const failures = [Object.assign(new Error("database is locked"), { _tag: "Storage.Error" }), new Error("connection reset")]
    let next = 0
    const h = await setup({ lookup: async () => { throw failures[next++] } })
    await expect(call(h, "read", get)).rejects.toBe(failures[0])
    await expect(call(h, "read", get)).rejects.toBe(failures[1])
    expect(h.asserts).toEqual([])
    expect(invocations(h.runtime)).toEqual([])
  })

  it("refuses a session that names no agent with SESSION_AGENT_REQUIRED before any assert", async () => {
    const h = await setup({ sessions: { ses_2: {} } })
    expect(await call(h, "read", get, "ses_2")).toMatchObject(failure("SESSION_AGENT_REQUIRED"))
    expect(h.asserts).toEqual([])
  })

  it("refuses a change through read with CATEGORY_MISMATCH", async () => {
    const h = await setup()
    expect(await call(h, "read", { ...get, operation: "gmail.users.messages.trash" })).toMatchObject(failure("CATEGORY_MISMATCH"))
    expect(invocations(h.runtime)).toEqual([])
  })

  it("rejects input outside the tool's contract with GWS_VALIDATION_ERROR", async () => {
    const h = await setup()
    expect(await call(h, "read", { ...get, extra: true })).toMatchObject(failure("GWS_VALIDATION_ERROR"))
  })

  it("stops through the RPC invocation signal", async () => {
    const h = await setup()
    const abort = new AbortController()
    abort.abort()
    expect(await call(h, "read", get, "ses_1", rpcContext(abort.signal))).toMatchObject(failure("CANCELLED"))
    expect(invocations(h.runtime)).toEqual([])
  })
})

describe("unattended approvals", () => {
  const evaluation = (overrides: Partial<Evaluation>): Evaluation => ({ action: "gws.read", effect: "ask", metadata: { script: true }, ...overrides })

  it("turns an ask on a script's gws request into a deny with the reason", async () => {
    const h = await setup()
    const asked = evaluation({})
    h.hook(asked)
    expect(asked).toMatchObject({ effect: "deny", message: expect.stringMatching(/cannot answer an approval prompt/) })
  })

  it("leaves tool calls, other plugins' actions, allows and denies alone", async () => {
    const h = await setup()
    for (const untouched of [
      evaluation({ metadata: {} }),
      evaluation({ metadata: undefined }),
      evaluation({ action: "other.read" }),
      evaluation({ effect: "allow" }),
      evaluation({ effect: "deny" }),
    ]) {
      const before = { ...untouched }
      h.hook(untouched)
      expect(untouched).toEqual(before)
    }
  })

  it("disposes the hook and the RPC on cleanup", async () => {
    const h = await setup()
    await h.stop()
    expect(h.disposed.sort()).toEqual(["hook", "rpc"])
  })
})
