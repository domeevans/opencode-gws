import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { gateOf, rpc, session, startStock, TESTED_HOSTS, type StockHost } from "./stock.js"

/**
 * The tools RPC v2.1 on the stock binaries 2.2.3, 2.2.4, 2.2.5 and 2.2.6: a read, a plan, a read an agent asks for
 * (refused before gws runs), a deny, a commit that is not a method, describe with a session, and the location error.
 * The plugin is loaded in one project only, with the fake gws fixture as its binary, so the recorded argv says whether
 * gws ran.
 */

const unwrap = (data: unknown) => ((data as { output?: unknown })?.output ?? (data as { data?: unknown })?.data ?? data) as Record<string, any>
const refusedCode = (data: unknown) => (data as { data?: { code?: string } })?.data?.code

const listRequest = { operation: "gmail.users.messages.list", params: { userId: "me", maxResults: 1 }, fields: "messages(id)" }
const createRequest = { operation: "gmail.users.labels.create", params: { userId: "me" }, body: { name: "v2-scripted" } }

for (const version of TESTED_HOSTS) {
  // A missing stock binary skips on a laptop and fails in CI (PUBLIC-PATTERN R34), so a tested release never passes unrun.
  describe.skipIf(gateOf(version) === "skip")(`the tools RPC v2.1 on stock ${version}`, () => {
    let host: StockHost
    let build = ""
    let locked = ""

    beforeAll(async () => {
      host = await startStock(version)
      build = await session(host, "scripted")
      locked = await session(host, "scripted", [{ action: "gws.read", resource: "*", effect: "deny" }])
    }, 180_000)

    afterAll(async () => {
      await host?.close()
    })

    it("a read the agent allows runs, and gws saw it", async () => {
      const before = host.invocations().length
      const result = await rpc(host, "read", build, listRequest)
      expect(unwrap(result.data), JSON.stringify(result.data)).toMatchObject({ ok: true, operation: "gmail.users.messages.list", category: "read" })
      expect(host.invocations().length).toBe(before + 1)
    })

    it("a plan is a method, and a commit is not: the script plans, and no commit runs", async () => {
      const planned = await rpc(host, "plan", build, createRequest)
      expect(unwrap(planned.data), JSON.stringify(planned.data)).toMatchObject({ ok: true, category: "write", planId: expect.any(String) })
      const commits = () => host.invocations().filter((argv) => argv.includes("create") && !argv.includes("--dry-run"))
      const before = commits().length
      const notAMethod = await host.api("POST", "/api/rpc/google-workspace.gws.tools/write", { input: { sessionID: build, input: { planId: unwrap(planned.data).planId } } }, host.project)
      expect(JSON.stringify(notAMethod.data)).toContain("method_not_found")
      expect(commits().length).toBe(before)
    }, 60_000)

    it("an ask the agent gives a read is refused at once, before gws runs", async () => {
      const asking = await session(host, "scripted", [{ action: "gws.read", resource: "*", effect: "ask" }])
      const before = host.invocations().length
      const refused = await rpc(host, "read", asking, listRequest)
      expect(refusedCode(refused.data)).toBe("PERMISSION_DENIED")
      expect(host.invocations().length).toBe(before)
    })

    it("a denied tool is refused before dispatch, with no gws call", async () => {
      const before = host.invocations().length
      const refused = await rpc(host, "read", locked, listRequest)
      expect(refusedCode(refused.data)).toBe("PERMISSION_DENIED")
      expect(JSON.stringify(refused.data)).toContain("hidden from this session's agent")
      expect(host.invocations().length).toBe(before)
    })

    it("describe lists the read methods with their schemas, and takes no input", async () => {
      const described = await host.api("POST", "/api/rpc/google-workspace.gws.tools/describe", { input: {} }, host.project)
      const methods = unwrap(described.data).methods as { name: string; input?: unknown; output?: unknown }[]
      expect(methods.map((method) => method.name).sort()).toEqual(["catalog", "events_list", "plan", "read", "schema", "status"])
      for (const method of methods) expect(method).toMatchObject({ input: { type: "object" }, output: { type: "object" } })
      expect((await host.api("POST", "/api/rpc/google-workspace.gws.tools/describe", { input: { sessionID: build } }, host.project)).status).toBe(400)
      expect(unwrap(described.data).location).toBe(host.project)
    })

    it("a call with no location reaches the default location and fails rpc.unavailable; the query and the header work", async () => {
      const missing = await host.api("POST", "/api/rpc/google-workspace.gws.tools/describe", { input: {} })
      expect(missing.status).toBe(400)
      expect(JSON.stringify(missing.data)).toContain("rpc.unavailable")
      expect((await host.api("POST", "/api/rpc/google-workspace.gws.tools/describe", { input: {} }, host.project)).status).toBe(200)
      const header = await host.api("POST", "/api/rpc/google-workspace.gws.tools/describe", { input: {} }, undefined, { "x-opencode-directory": host.project })
      expect(header.status).toBe(200)
    })

    it("opencode api needs x-opencode-directory:$PWD: without it rpc.unavailable, with it the call runs", async () => {
      const body = JSON.stringify({ input: {} })
      const without = host.cli(["post", "/api/rpc/google-workspace.gws.tools/describe", "-d", body])
      expect(without.status).not.toBe(0)
      expect(without.out).toContain("rpc.unavailable")
      const withHeader = host.cli(["post", "/api/rpc/google-workspace.gws.tools/describe", "-d", body, "-H", `x-opencode-directory:${host.project}`])
      expect(withHeader.status).toBe(0)
      expect(JSON.parse(withHeader.out)).toMatchObject({ output: { location: host.project } })
    })

    it("names an unknown session with SESSION_UNKNOWN and a session without an agent with SESSION_AGENT_REQUIRED", async () => {
      expect(refusedCode((await rpc(host, "read", "ses_does_not_exist", listRequest)).data)).toBe("SESSION_UNKNOWN")
      const agentless = await host.api("POST", "/api/session", { title: "agentless" }, host.project)
      const id = ((agentless.data as { data?: unknown })?.data ?? agentless.data) as { id?: string }
      const refused = await rpc(host, "read", String(id.id), listRequest)
      expect(refusedCode(refused.data)).toBe("SESSION_AGENT_REQUIRED")
    })

    it("has no unclassified tool: every account tool is in the table", async () => {
      const described = unwrap((await host.api("POST", "/api/rpc/google-workspace.gws.tools/describe", { input: {} }, host.project)).data)
      expect(described.unclassified ?? []).toEqual([])
    })
  })
}
