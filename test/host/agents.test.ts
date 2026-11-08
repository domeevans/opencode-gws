import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { request } from "../support/requests.js"
import { defaultRules, hasDefaultRules } from "../../src/host/agents.js"
import { ACCOUNT, prompt, startHost, type Harness } from "./harness.js"
import { Gws, isStatus } from "./package.js"

/**
 * One host, so the embedded SDK's process-wide paths stay inside this root.
 * The host runs at `access: "ask-changes"`, so each commit asks and the
 * reads run: user allow on gws.export, user deny on gws.admin, a config-only
 * agent, and a custom deny agent. Built-in agents still receive the rules.
 */

let host: Harness
let sessionID: string
let root: string

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "gws-host-agents-"))
  host = await startHost({
    permissions: [
      { action: "gws.export", resource: "*", effect: "allow" },
      { action: "gws.admin", resource: "*", effect: "deny" },
    ],
    agents: {
      locked: { permissions: [{ action: "gws.*", resource: "*", effect: "deny" }] },
      notes: { permissions: [{ action: "*", resource: "*", effect: "allow" }] },
    },
    options: { access: "ask-changes" },
  })
  sessionID = (await host.opencode.sessions.create({ location: host.location })).id
})

afterAll(async () => {
  await host?.close()
  rmSync(root, { recursive: true, force: true })
})

async function execute(code: string): Promise<Record<string, unknown>> {
  host.model.script({ code })
  await prompt(host, sessionID, "run")
  return JSON.parse(host.model.lastToolResult()!) as Record<string, unknown>
}

function call(tool: string, input: unknown): string {
  return `try { return { value: await tools.gws.${tool}(${JSON.stringify(input)}) } } catch (e) { return { error: String(e?.message ?? e) } }`
}

const asked = () => host.events.filter((event) => event.type === "permission.asked" && event.data?.sessionID === sessionID)

describe("agent ask rules", () => {
  it("puts the rules immediately after each built-in agent's base allow", async () => {
    const { data } = await host.opencode.agent.list({ location: host.location })
    const builtins = data.filter((agent) => agent.id !== "locked" && agent.id !== "notes")
    expect(builtins.length).toBeGreaterThan(0)
    for (const agent of builtins) {
      expect(hasDefaultRules(agent.permissions, "ask-changes"), agent.id).toBe(true)
    }
  })

  it("does not give the rules to a config-only agent, and status names it", async () => {
    const { data } = await host.opencode.agent.list({ location: host.location })
    const notes = data.find((agent) => agent.id === "notes" || agent.name === "notes")
    expect(notes, "config-only agent").toBeDefined()
    expect(hasDefaultRules(notes!.permissions, "ask-changes")).toBe(false)
    const rpc = await host.opencode.rpc(Gws).status({}, { location: host.location })
    if (!isStatus(rpc)) throw new Error(`not a status: ${JSON.stringify(rpc)}`)
    expect(rpc.access).toBe("ask-changes")
    expect(rpc.permissionsBlock).toContain(JSON.stringify(defaultRules("ask-changes")[0]))
    expect(rpc.unguardedAgents).toEqual(["notes"])
    expect(rpc.permissionsBlock).toContain('"resource":"*"')
    const status = await execute(call("status", {}))
    const value = (status["value"] ?? status) as Record<string, unknown>
    // unguardedAgents is always a list of names; the compact tool output carries only the count.
    expect(value["unguardedAgentCount"], String(status["error"])).toBe(1)
    expect(value).not.toHaveProperty("unguardedAgents")
    expect(String(value["permissions"])).toContain("/gws-status")
    expect(JSON.stringify(value)).not.toContain("notes")
  })

  it("keeps a custom deny agent denied", async () => {
    const { data } = await host.opencode.agent.list({ location: host.location })
    const locked = data.find((agent) => agent.id === "locked" || agent.name === "locked")
    expect(locked).toBeDefined()
    const winner = [...locked!.permissions].reverse().find((rule) => rule.action === "gws.*" || rule.action === "gws.write")
    expect(winner?.effect).toBe("deny")
  })

  it("lets a user allow rule remove the export prompt, and a user deny hide admin", async () => {
    // Inside the project: a destination outside it asks external_directory as well (external-directory.test.ts).
    const destination = join(host.location.directory, "export.txt")
    const planned = (await execute(call("plan", request("drive.files.export", { params: { fileId: "f-1", mimeType: "text/plain" }, download: { path: destination } })))).value as Record<string, unknown>
    expect(planned).toMatchObject({ ok: true, category: "export" })
    const before = asked().length
    host.model.script({ tool: "gws_export", input: { planId: planned.planId } })
    await prompt(host, sessionID, "export")
    expect(asked().length).toBe(before)
    const offered = host.model.requests.at(-1)!
    expect(offered.tools).not.toEqual(expect.arrayContaining(["gws_admin"]))
  })

  it("saves Always for a write and does not offer it for a send", async () => {
    const planned = (await execute(call("plan", request("gmail.users.labels.create", { params: { userId: "me" }, body: { name: "again" } })))).value as Record<string, unknown>
    const seen = new Set(asked().map((event) => event.data?.id))
    host.model.script({ tool: "gws_write", input: { planId: planned.planId } })
    await host.opencode.sessions.prompt({ sessionID, text: "write" })
    const asking = await host.waitForEvent((event) => event.type === "permission.asked" && event.data?.action === "gws.write" && !seen.has(event.data?.id))
    expect(asking.data?.save).toEqual([`${ACCOUNT}:gmail.users.labels.create`])
    await host.opencode.permission.reply({ sessionID, requestID: asking.data!.id as string, decision: "always" })
    await host.opencode.sessions.wait({ sessionID })

    const second = (await execute(call("plan", request("gmail.users.labels.create", { params: { userId: "me" }, body: { name: "again-2" } })))).value as Record<string, unknown>
    const prompts = asked().length
    host.model.script({ tool: "gws_write", input: { planId: second.planId } })
    await prompt(host, sessionID, "write again")
    expect(asked().length).toBe(prompts)

    const sent = (await execute(call("plan", request("gmail.users.messages.send", { params: { userId: "me" }, body: { raw: "YQ==" } })))).value as Record<string, unknown>
    const sendSeen = new Set(asked().map((event) => event.data?.id))
    host.model.script({ tool: "gws_send", input: { planId: sent.planId } })
    await host.opencode.sessions.prompt({ sessionID, text: "send" })
    const sendAsk = await host.waitForEvent((event) => event.type === "permission.asked" && event.data?.action === "gws.send" && !sendSeen.has(event.data?.id))
    expect(sendAsk.data?.save ?? []).toEqual([])
    await host.opencode.permission.reply({ sessionID, requestID: sendAsk.data!.id as string, decision: "reject" })
    await host.opencode.sessions.wait({ sessionID })
  })
})
