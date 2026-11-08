import { realpathSync } from "node:fs"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { ACCOUNT, FAKE_GWS, PLUGIN_ID, SERVICES, prompt, startHost, type Harness } from "./harness.js"
import { PLUGIN_PACKAGE, packageJson } from "./package.js"
import { request } from "../support/requests.js"

/**
 * The plugin inside the real OpenCode runtime: config loading, the version
 * gate, tool and skill registries, and permission rules,
 * and tool execution driven by a scripted model: Code Mode for the reads
 * and plans, direct calls for the commit tools. Nothing here fakes the
 * host; only the model and `gws` are scripted.
 */

const CODE_MODE = ["status", "catalog", "schema", "plan", "events_list"]
const COMMITS = ["write", "send", "share", "delete", "export", "admin"]
const TOOLS = [...CODE_MODE, "read", ...COMMITS]

const PERMISSIONS = [
  { action: "gws.write", resource: "*", effect: "deny" as const },
  { action: "gws.send", resource: "*", effect: "ask" as const },
  { action: "gws.delete", resource: "*", effect: "allow" as const },
]

const sendRequest = request("gmail.users.messages.send", { params: { userId: "me" }, body: { raw: "aG9zdCB0ZXN0" } })

const deleteRequest = request("gmail.users.messages.delete", { params: { userId: "me", id: "m-fake-1" } })

const labelRequest = request("gmail.users.labels.create", { params: { userId: "me" }, body: { name: "host-test" } })

let host: Harness
let sessionID: string

beforeAll(async () => {
  host = await startHost({ permissions: PERMISSIONS })
  sessionID = (await host.opencode.sessions.create({ location: host.location })).id
})

afterAll(async () => {
  await host?.close()
})

/** One scripted model turn that runs `code` in the host's Code Mode `execute` tool; returns what the model saw. */
async function execute(code: string): Promise<Record<string, unknown>> {
  host.model.script({ code })
  await prompt(host, sessionID, "run")
  const seen = host.model.lastToolResult()
  if (seen === undefined) throw new Error("the model never received a tool result")
  return JSON.parse(seen) as Record<string, unknown>
}

/** One scripted model turn that calls the direct tool gws_<tool>; returns what the model saw. */
async function direct(tool: string, input: unknown): Promise<Record<string, unknown>> {
  host.model.script({ tool: `gws_${tool}`, input })
  await prompt(host, sessionID, "run")
  return JSON.parse(host.model.lastToolResult()!) as Record<string, unknown>
}

/** Code Mode snippet: await a gws call and return `{ value }` or `{ error }` with the thrown message. */
function call(tool: string, input: unknown): string {
  return `try { return { value: await tools.gws.${tool}(${JSON.stringify(input)}) } } catch (e) { return { error: String(e?.message ?? e) } }`
}

function commits(): string[][] {
  return host.invocations().filter((argv) => !argv.includes("--dry-run"))
}

function permissionAsked(action: string, after: Set<unknown>) {
  return (event: { type: string; data?: Record<string, unknown> }) =>
    event.type === "permission.asked" && event.data?.action === action && event.data?.sessionID === sessionID && !after.has(event.data?.id)
}

function askedIds(): Set<unknown> {
  return new Set(host.events.filter((event) => event.type === "permission.asked").map((event) => event.data?.id))
}

describe("plugin load", () => {
  it("is active in the real host, loaded from this package's config entry", async () => {
    const { data } = await host.opencode.plugin.list({ location: host.location })
    const entry = data.find((plugin) => plugin.id === PLUGIN_ID)
    expect(entry?.state).toEqual({ status: "active" })
    expect(entry?.source).toMatchObject({ type: "local", path: PLUGIN_PACKAGE })
    expect(entry?.features).toMatchObject({ server: true })
  })
})

describe("tool registry", () => {
  it("registers every gws tool under the gws namespace with its permission action", async () => {
    const tools = (await host.probe.tool.list()).filter((tool) => tool.options?.namespace === "gws")
    expect(tools.map((tool) => tool.id).sort()).toEqual(TOOLS.map((name) => `gws_${name}`).sort())
    for (const tool of tools) {
      expect(tool.options).toMatchObject({ namespace: "gws", permission: `gws.${tool.name}`, codemode: CODE_MODE.includes(tool.name) })
      expect(tool.options?.pinned).toBe(["catalog", "plan"].includes(tool.name) ? true : undefined)
    }
  })

  it("hides a tool from the model when a host rule denies its action", async () => {
    const result = await execute(`return search({ namespace: "gws", limit: 50 })`)
    const paths = (result.items as Array<{ path: string }>).map((item) => item.path).sort()
    expect(paths).toEqual(CODE_MODE.map((name) => `tools.gws.${name}`).sort())
    // The commit tools are direct; the denied one is not offered to the model.
    const offered = host.model.requests.at(-1)?.tools ?? []
    expect(offered).toEqual(expect.arrayContaining(COMMITS.filter((name) => name !== "write").map((name) => `gws_${name}`)))
    expect(offered).not.toContain("gws_write")
    // Still registered: the deny is enforced by the host permission layer.
    expect((await host.probe.tool.list()).some((tool) => tool.id === "gws_write")).toBe(true)
  })
})

describe("tool execution", () => {
  it("runs status, catalog and schema in Code Mode and read as a direct tool, against the fake gws", async () => {
    const before = host.invocations().length
    const result = await execute(`
      const status = await tools.gws.status({})
      const catalog = await tools.gws.catalog({ query: "messages.send", service: "gmail" })
      const schema = await tools.gws.schema(${JSON.stringify(request("gmail.users.getProfile"))})
      return { status, catalog, schema }
    `)
    const { status, catalog, schema } = result as Record<string, Record<string, unknown>>
    const read = await direct("read", request("gmail.users.messages.list", { params: { userId: "me" }, fields: "messages(id)" }))

    expect(status).toMatchObject({
      version: packageJson.version,
      host: { version: host.hostVersion, range: ">=2.2.3 <2.3.0" },
      gws: { path: realpathSync(FAKE_GWS), version: "gws 0.22.5" },
      services: [...SERVICES].sort(),
      accounts: [{ alias: ACCOUNT, mode: "interactive", services: SERVICES }],
    })
    expect(JSON.stringify(catalog)).toContain("gmail.users.messages.send")
    expect(schema).toMatchObject({ ok: true, account: ACCOUNT, schema: { id: "gmail.users.getProfile", httpMethod: "GET" } })
    expect(read).toMatchObject({
      ok: true,
      operation: "gmail.users.messages.list",
      category: "read",
      data: { messages: [{ id: "m-fake-1" }, { id: "m-fake-2" }] },
      trust: { workspaceContent: "untrusted" },
    })

    // status/catalog are local and schema runs account-free, so only the read reached gws with the account.
    const ran = host.invocations().slice(before)
    expect(ran).toHaveLength(1)
    expect(ran[0]?.slice(0, 4)).toEqual(["gmail", "users", "messages", "list"])
    expect(ran[0]).not.toContain("--dry-run")
  })

  it("asks on gws.send; reject runs nothing and keeps the plan, once commits it exactly once", async () => {
    const planned = (await execute(call("plan", sendRequest))).value as Record<string, unknown>
    expect(planned).toMatchObject({ ok: true, category: "send" })
    expect(planned).not.toHaveProperty("requiresConfirmation")
    const planId = planned.planId as string
    const dryRun = host.invocations().at(-1)!
    expect(dryRun.at(-1)).toBe("--dry-run")
    const commitArgv = dryRun.slice(0, -1)
    expect(commits().filter((argv) => argv.join(" ") === commitArgv.join(" "))).toHaveLength(0)

    // Reject: the commit tool fails, gws never runs the commit argv.
    let seen = askedIds()
    const requests = host.model.requests.length
    host.model.script({ tool: "gws_send", input: { planId } })
    await host.opencode.sessions.prompt({ sessionID, text: "send it" })
    const rejected = await host.waitForEvent(permissionAsked("gws.send", seen))
    expect(rejected.data).toMatchObject({
      action: "gws.send",
      resources: [`${ACCOUNT}:gmail.users.messages.send`],
      metadata: { planId, category: "send", operation: "gmail.users.messages.send", account: ACCOUNT },
      source: { type: "tool" },
    })
    expect(rejected.data?.save).toBeUndefined()
    await host.opencode.permission.reply({ sessionID, requestID: rejected.data!.id as string, decision: "reject" })
    await host.opencode.sessions.wait({ sessionID })
    // A rejected direct call ends the step: the model is not asked again.
    expect(host.model.requests.length).toBe(requests + 1)
    const replied = await host.waitForEvent((event) => event.type === "permission.replied" && event.data?.requestID === rejected.data!.id)
    expect(replied.data).toMatchObject({ sessionID, reply: "reject" })
    expect(commits().filter((argv) => argv.join(" ") === commitArgv.join(" "))).toHaveLength(0)

    // Once: the same plan is still ready and commits.
    seen = askedIds()
    host.model.script({ tool: "gws_send", input: { planId } })
    await host.opencode.sessions.prompt({ sessionID, text: "send it now" })
    const approved = await host.waitForEvent(permissionAsked("gws.send", seen))
    await host.opencode.permission.reply({ sessionID, requestID: approved.data!.id as string, decision: "once" })
    await host.opencode.sessions.wait({ sessionID })
    const committed = JSON.parse(host.model.lastToolResult()!) as Record<string, unknown>
    expect(committed["error"]).toBeUndefined()
    expect(committed).toMatchObject({ ok: true, planId, category: "send", result: { id: "sent-fake-1" } })
    expect(commits().filter((argv) => argv.join(" ") === commitArgv.join(" "))).toHaveLength(1)

    // Single use: a replay is refused before any prompt and runs nothing.
    seen = askedIds()
    const replay = await direct("send", { planId })
    expect(JSON.stringify(replay.error)).toMatch(/PLAN_ALREADY_USED/)
    expect(host.events.some(permissionAsked("gws.send", seen))).toBe(false)
    expect(commits().filter((argv) => argv.join(" ") === commitArgv.join(" "))).toHaveLength(1)
  })

  it("commits a delete without a prompt when a user rule allows gws.delete", async () => {
    const planned = (await execute(call("plan", deleteRequest))).value as Record<string, unknown>
    expect(planned).toMatchObject({ ok: true, category: "delete" })
    const before = commits().length
    const seen = askedIds()
    const done = await direct("delete", { planId: planned.planId })
    expect(done).toMatchObject({ ok: true, category: "delete" })
    expect(host.events.some(permissionAsked("gws.delete", seen))).toBe(false)
    expect(host.events.some(permissionAsked("gws.confirm", seen))).toBe(false)
    expect(commits().length).toBe(before + 1)
  })

  it("refuses a commit tool the host denies, even with a valid plan", async () => {
    const planned = (await execute(call("plan", labelRequest))).value as Record<string, unknown>
    expect(planned).toMatchObject({ ok: true, category: "write" })
    const before = commits().length
    const seen = askedIds()

    const result = await direct("write", { planId: planned.planId })
    expect(JSON.stringify(result)).toMatch(/gws_write/)
    expect(result["ok"]).toBeUndefined()
    expect(host.events.some(permissionAsked("gws.write", seen))).toBe(false)
    expect(commits().length).toBe(before)
  })
})

describe("skill registry", () => {
  it("lists every skill the plugin registers, read from this package", async () => {
    const expected = ["opencode-gws", "opencode-gws-recipes"].map((id) => ({
      id,
      path: join(PLUGIN_PACKAGE, "skills", id, "SKILL.md"),
    }))

    const { data } = await host.opencode.skill.list({ location: host.location })
    for (const skill of expected) {
      const listed = data.find((entry) => entry.id === skill.id)
      expect(listed, skill.id).toBeDefined()
      expect(listed?.path).toBe(skill.path)
      expect(listed?.path.startsWith(join(PLUGIN_PACKAGE, "skills"))).toBe(true)
      expect(listed?.content.length).toBeGreaterThan(0)
    }
  })
})
