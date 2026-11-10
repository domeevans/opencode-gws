import { Rpc } from "@opencode/plugin/rpc"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { request } from "../support/requests.js"
import { ACCOUNT, startHost, type Harness } from "./harness.js"

/**
 * The tools RPC through the real host: a script calls the plugin as a
 * session, under that session's agent and session rules, with no model.
 * The agents are config-only, so they carry exactly the rules below.
 */

// The client side only names the methods: the plugin checks each input against the tool's own contract.
const open = {}
const Tools = Rpc.define({
  id: "google-workspace.gws.tools",
  methods: {
    describe: { input: open, output: open },
    ...Object.fromEntries(
      ["status", "catalog", "schema", "read", "plan", "events_list"].map((name) => [
        name,
        { input: open, output: open, errors: { failed: open } },
      ]),
    ),
  },
  events: {},
})

let host: Harness
const sessions: Record<string, string> = {}

beforeAll(async () => {
  host = await startHost({
    agents: {
      locked: { permissions: [{ action: "gws.*", resource: "*", effect: "deny" }] },
      careful: { permissions: [{ action: "gws.read", resource: "*", effect: "ask" }] },
    },
  })
  const create = async (input: Record<string, unknown>) => (await host.opencode.sessions.create({ location: host.location, ...input } as never)).id
  sessions.build = await create({ agent: "build" })
  sessions.locked = await create({ agent: "locked" })
  sessions.careful = await create({ agent: "careful" })
  sessions.agentless = await create({})
  // Session rules come after the agent's: this script may list mail but not open a message.
  sessions.narrow = await create({ agent: "build", permissions: [{ action: "gws.read", resource: `${ACCOUNT}:gmail.users.messages.get`, effect: "deny" }] })
})

afterAll(async () => {
  await host?.close()
})

const tools = () => host.opencode.rpc(Tools) as unknown as Record<string, (input: unknown, options: unknown) => Promise<unknown>>
const at = () => ({ location: host.location })

/** The method's result, or the declared error's `{ type, code, message }`. */
async function run(method: string, session: string, input: unknown): Promise<Record<string, any>> {
  try {
    return { value: await tools()[method]!({ sessionID: session, input }, at()) }
  } catch (error) {
    const e = error as Record<string, any>
    return { type: e.type ?? e._tag, code: e.data?.code, message: String(e.message ?? e) }
  }
}

const list = request("gmail.users.messages.list", { params: { userId: "me", maxResults: 1 }, fields: "messages(id)" })
const get = request("gmail.users.messages.get", { params: { userId: "me", id: "m-1" } })
const asked = (session: string) => host.events.filter((event) => event.type === "permission.asked" && event.data?.sessionID === session)

describe("tools RPC on a real host", () => {
  it("describes exactly the read tools as methods, each with its input and output schema", async () => {
    const description = (await tools().describe!({}, at())) as { methods: Array<{ name: string; input: unknown; output: unknown }> }
    expect(description.methods.map((method) => method.name).sort()).toEqual(["catalog", "events_list", "plan", "read", "schema", "status"])
    for (const method of description.methods) expect({ name: method.name, input: method.input, output: method.output }).toMatchObject({ input: { type: "object" }, output: { type: "object" } })
  })

  it("reads as a session whose agent allows it, with no model turn", async () => {
    const before = host.invocations().length
    const requests = host.model.requests.length
    const result = await run("read", sessions.build!, list)
    expect(result.value, result.message).toMatchObject({ ok: true, operation: "gmail.users.messages.list", category: "read" })
    expect(host.invocations().length).toBe(before + 1)
    expect(host.model.requests.length).toBe(requests)
  })

  it("refuses a session whose agent denies gws, before gws runs", async () => {
    const before = host.invocations().length
    const result = await run("read", sessions.locked!, list)
    expect(result).toMatchObject({ type: "failed", code: "PERMISSION_DENIED" })
    expect(host.invocations().length).toBe(before)
  })

  it("refuses an ask at once instead of leaving a prompt no one will answer", async () => {
    const before = host.invocations().length
    const started = Date.now()
    const result = await run("read", sessions.careful!, list)
    expect(result).toMatchObject({ type: "failed", code: "PERMISSION_DENIED" })
    expect(result.message).toMatch(/cannot answer/)
    expect(Date.now() - started).toBeLessThan(5000)
    expect(asked(sessions.careful!)).toEqual([])
    expect(host.invocations().length).toBe(before)
  })

  it("applies the session's own rules after the agent's", async () => {
    expect((await run("read", sessions.narrow!, list)).value).toMatchObject({ ok: true })
    expect(await run("read", sessions.narrow!, get)).toMatchObject({ type: "failed", code: "PERMISSION_DENIED" })
  })

  it("plans as a session, and the model commits it with no prompt at the default access", async () => {
    const planned = await run("plan", sessions.build!, request("gmail.users.labels.create", { params: { userId: "me" }, body: { name: "scripted" } }))
    expect(planned.value, planned.message).toMatchObject({ ok: true, category: "write", planId: expect.any(String) })
    const writes = () => host.invocations().filter((argv) => argv.includes("create") && !argv.includes("--dry-run"))
    const before = writes().length
    const prompts = asked(sessions.build!).length
    host.model.script({ tool: "gws_write", input: { planId: planned.value.planId } })
    await host.opencode.sessions.prompt({ sessionID: sessions.build!, text: "commit" } as never)
    await host.opencode.sessions.wait({ sessionID: sessions.build! } as never)
    expect(writes().length).toBe(before + 1)
    expect(asked(sessions.build!).length).toBe(prompts)
  })

  it("names an unknown session with SESSION_UNKNOWN, and a session without an agent with SESSION_AGENT_REQUIRED", async () => {
    expect(await run("read", "ses_does_not_exist", list)).toMatchObject({ type: "failed", code: "SESSION_UNKNOWN" })
    expect(await run("read", sessions.agentless!, list)).toMatchObject({ type: "failed", code: "SESSION_AGENT_REQUIRED" })
  })

  it("answers a bad envelope with the shared wording", async () => {
    const raw = async (method: string, body: unknown) => {
      try {
        return { value: await tools()[method]!(body, at()) }
      } catch (error) {
        const e = error as Record<string, any>
        return { type: e.type ?? e._tag, message: String(e.message ?? e) }
      }
    }
    const extra = await raw("read", { sessionID: sessions.build!, input: list, extra: 1 })
    expect(extra.value).toBeUndefined()
    expect(extra.message).toContain('"extra" is not allowed')
    expect((await raw("read", { input: list })).message).toContain('"sessionID" must be a non-empty string')
    expect((await raw("describe", 1)).message).toContain("describe takes no input")
  })

  it("plans a change as a script, and offers no commit as a method: the model commits the plan through its approved tool", async () => {
    const planned = await run("plan", sessions.build!, request("gmail.users.labels.create", { params: { userId: "me" }, body: { name: "scripted-two" } }))
    expect(planned.value, planned.message).toMatchObject({ ok: true, category: "write", planId: expect.any(String) })
    const described = (await tools().describe!({}, at())) as { methods: Array<{ name: string }> }
    expect(described.methods.map((method) => method.name)).not.toContain("write")
  })
})
