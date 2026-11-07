import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { available, binary, rpc, session, startStock, TESTED_HOSTS, type StockHost } from "./stock.js"

/**
 * The tools RPC v2 on the stock binaries 2.2.3, 2.2.4, 2.2.5 and 2.2.6: a read, an allowed write, a write that would ask
 * (refused before anything runs), a deny, describe with a session, and the location error. The plugin is loaded in one
 * project only, with the fake gws fixture as its binary, so the recorded argv says whether gws ran.
 */

const unwrap = (data: unknown) => ((data as { output?: unknown })?.output ?? (data as { data?: unknown })?.data ?? data) as Record<string, any>
const refusedCode = (data: unknown) => (data as { data?: { code?: string } })?.data?.code

const listRequest = { operation: "gmail.users.messages.list", params: { userId: "me", maxResults: 1 }, fields: "messages(id)" }
const createRequest = { operation: "gmail.users.labels.create", params: { userId: "me" }, body: { name: "v2-scripted" } }

for (const version of TESTED_HOSTS) {
  if (!available(version)) {
    it(`${version}: the stock binary is missing, so this version is skipped`, () => {
      console.log(`no stock binary for ${version} at ${binary(version)}`)
    })
    continue
  }

  describe(`the tools RPC v2 on stock ${version}`, () => {
    let host: StockHost
    let build = ""
    let locked = ""

    beforeAll(async () => {
      host = await startStock(version)
      build = await session(host, "build")
      locked = await session(host, "build", [{ action: "gws.read", resource: "*", effect: "deny" }])
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

    it("a plan and its commit are methods: the commit is refused before gws runs unless the session allows it", async () => {
      const planned = await rpc(host, "plan", build, createRequest)
      expect(unwrap(planned.data), JSON.stringify(planned.data)).toMatchObject({ ok: true, category: "write", planId: expect.any(String) })
      const commits = () => host.invocations().filter((argv) => argv.includes("create") && !argv.includes("--dry-run"))
      const before = commits().length
      const refused = await rpc(host, "write", build, { planId: unwrap(planned.data).planId })
      expect(refusedCode(refused.data)).toBe("PERMISSION_DENIED")
      expect(JSON.stringify(refused.data)).toContain("would ask")
      expect(commits().length).toBe(before)
    }, 60_000)

    it("the commit runs when the session allows its action, for a plan made in that session", async () => {
      const allowed = await session(host, "build", [{ action: "gws.write", resource: "*", effect: "allow" }])
      const planned = await rpc(host, "plan", allowed, createRequest)
      expect(unwrap(planned.data), JSON.stringify(planned.data)).toMatchObject({ ok: true, category: "write" })
      const commits = () => host.invocations().filter((argv) => argv.includes("create") && !argv.includes("--dry-run"))
      const before = commits().length
      const committed = await rpc(host, "write", allowed, { planId: unwrap(planned.data).planId })
      expect(unwrap(committed.data), JSON.stringify(committed.data)).toMatchObject({ ok: true })
      expect(commits().length).toBe(before + 1)
    }, 60_000)

    it("a denied tool is refused before dispatch, with no gws call", async () => {
      const before = host.invocations().length
      const refused = await rpc(host, "read", locked, listRequest)
      expect(refusedCode(refused.data)).toBe("PERMISSION_DENIED")
      expect(JSON.stringify(refused.data)).toContain("hidden from this session's agent")
      expect(host.invocations().length).toBe(before)
    })

    it("describe with a session reports each method's class and permission, and without one omits the permission", async () => {
      const described = await host.api("POST", "/api/rpc/google-workspace.gws.tools/describe", { input: { sessionID: build } }, host.project)
      const methods = unwrap(described.data).methods as { name: string; class: string; permission?: string }[]
      expect(Object.fromEntries(methods.map((method) => [method.name, method.class]))).toEqual({
        status: "read",
        catalog: "read",
        schema: "read",
        read: "read",
        plan: "read",
        write: "write",
        send: "send",
        share: "send",
        delete: "destructive",
        export: "export",
        admin: "destructive",
      })
      const permission = Object.fromEntries(methods.map((method) => [method.name, method.permission]))
      expect(permission).toMatchObject({ status: "allow", read: "allow", plan: "allow", write: "ask", delete: "ask" })
      const plain = unwrap((await host.api("POST", "/api/rpc/google-workspace.gws.tools/describe", { input: {} }, host.project)).data)
      expect(plain.methods.every((method: object) => !Object.hasOwn(method, "permission"))).toBe(true)
      expect(plain.location).toBe(host.project)
      expect(plain.locationHint).toContain("x-opencode-directory")
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
