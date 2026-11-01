import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { request } from "../support/requests.js"
import { ACCOUNT, prompt, startHost, type Harness } from "./harness.js"

/**
 * Default ask rules: reads never prompt. Each commit prompts once, and a
 * rejection spawns nothing. Write offers Always; send does not.
 */

let host: Harness
let sessionID: string

beforeAll(async () => {
  host = await startHost()
  sessionID = (await host.opencode.sessions.create({ location: host.location })).id
})

afterAll(async () => {
  await host?.close()
})

async function execute(code: string): Promise<Record<string, unknown>> {
  host.model.script({ code })
  await prompt(host, sessionID, "run")
  return JSON.parse(host.model.lastToolResult()!) as Record<string, unknown>
}

function call(tool: string, input: unknown): string {
  return `try { return { value: await tools.gws.${tool}(${JSON.stringify(input)}) } } catch (e) { return { error: String(e?.message ?? e) } }`
}

const commits = () => host.invocations().filter((argv) => !argv.includes("--dry-run"))
const asked = () => host.events.filter((event) => event.type === "permission.asked" && event.data?.sessionID === sessionID)

describe("default ask rules", () => {
  it("reads without a permission prompt", async () => {
    const before = asked().length
    const read = await execute(call("read", { operation: "gmail.users.messages.list", params: { userId: "me" }, fields: "messages(id)" }))
    expect(read["error"]).toBeUndefined()
    expect(asked().length).toBe(before)
  })

  it("asks before a write, offers Always for that operation, and runs nothing when rejected", async () => {
    const plan = (await execute(call("plan", request("gmail.users.labels.create", { params: { userId: "me" }, body: { name: "defaults" } })))).value as Record<string, unknown>
    expect(plan).toMatchObject({ ok: true, category: "write" })
    expect(plan).not.toHaveProperty("requiresConfirmation")
    const before = commits().length
    const seen = new Set(asked().map((event) => event.data?.id))
    host.model.script({ tool: "gws_write", input: { planId: plan.planId } })
    await host.opencode.sessions.prompt({ sessionID, text: "commit" })
    const asking = await host.waitForEvent((event) => event.type === "permission.asked" && event.data?.sessionID === sessionID && event.data?.action === "gws.write" && !seen.has(event.data?.id))
    expect(asking.data?.save).toEqual([`${ACCOUNT}:gmail.users.labels.create`])
    await host.opencode.permission.reply({ sessionID, requestID: asking.data!.id as string, decision: "reject" })
    await host.opencode.sessions.wait({ sessionID })
    expect(commits().length).toBe(before)
  })

  it("asks before a send with no Always, and runs nothing when rejected", async () => {
    const plan = (await execute(call("plan", request("gmail.users.messages.send", { params: { userId: "me" }, body: { raw: "ZGVmYXVsdHM=" } })))).value as Record<string, unknown>
    const before = commits().length
    const seen = new Set(asked().map((event) => event.data?.id))
    host.model.script({ tool: "gws_send", input: { planId: plan.planId } })
    await host.opencode.sessions.prompt({ sessionID, text: "send" })
    const asking = await host.waitForEvent((event) => event.type === "permission.asked" && event.data?.action === "gws.send" && !seen.has(event.data?.id))
    expect(asking.data?.save ?? []).toEqual([])
    await host.opencode.permission.reply({ sessionID, requestID: asking.data!.id as string, decision: "reject" })
    await host.opencode.sessions.wait({ sessionID })
    expect(commits().length).toBe(before)
  })
})
