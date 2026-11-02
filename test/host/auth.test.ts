import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { doctorTarget } from "../../src/auth/doctor.js"
import { loadManifest } from "../../src/domain/manifest.js"
import { IDENTITY_SCOPES, MAX_SCOPES, requestedScopes } from "../../src/domain/scopes.js"
import { TEST_CLIENT, storedSignIn } from "../support/config.js"
import { request } from "../support/requests.js"
import { prompt, startHost, type Harness } from "./harness.js"

/**
 * Sign-in in the real host, with no `accounts` option: the implicit
 * `default` account with every service at Read and write, its sign-in form,
 * the OAuth start (cancelled after its URL is checked, so Google is never
 * contacted), and the scope preflight with credentials stored directly in
 * the host's credential store: first a read-only one, then a write one.
 */

const SERVICES = loadManifest().services.map((service) => service.alias)
const READ = requestedScopes(SERVICES, "read")
const WRITE = requestedScopes(SERVICES, "write")
/** The services /gws-doctor probes; the rest have no read-only check. */
const PROBED = SERVICES.filter((service) => doctorTarget("default", service).operation !== undefined)

let host: Harness
let sessionID: string

beforeAll(async () => {
  host = await startHost({ options: { accounts: undefined } })
  sessionID = (await host.opencode.sessions.create({ location: host.location })).id
})

afterAll(async () => {
  await host?.close()
})

const at = () => ({ location: host.location })

/** One scripted model turn that runs `code` in Code Mode; returns what the model saw. */
/** One scripted model turn that calls gws_read directly; returns what the model saw. */
async function read(input: unknown): Promise<Record<string, unknown>> {
  host.model.script({ tool: "gws_read", input })
  await prompt(host, sessionID, "run")
  return JSON.parse(host.model.lastToolResult() ?? "{}") as Record<string, unknown>
}

async function execute(code: string): Promise<Record<string, unknown>> {
  host.model.script({ code })
  await prompt(host, sessionID, "run")
  const seen = host.model.lastToolResult()
  if (seen === undefined) throw new Error("the model never received a tool result")
  return JSON.parse(seen) as Record<string, unknown>
}

const call = (tool: string, input: unknown) =>
  `try { return { value: await tools.gws.${tool}(${JSON.stringify(input)}) } } catch (e) { return { error: String(e?.message ?? e) } }`

describe("the default account's sign-in", () => {
  it("registers gws-default as Google Workspace with the client ID and secret, access, and write acknowledgment fields", async () => {
    const { data } = await host.opencode.integration.get({ integrationID: "gws-default", ...at() })
    expect(data.name).toBe("Google Workspace")
    const method = data.methods.find((entry) => entry.type === "oauth") as { form?: Array<Record<string, unknown>> } | undefined
    const form = method?.form ?? []
    expect(form.map((field) => field["key"])).toEqual(["clientId", "clientSecret", "access", "confirmWrite"])
    expect(form[0]).toMatchObject({ type: "string", required: false })
    expect(form[0]).not.toHaveProperty("hidden")
    expect(form[1]).toMatchObject({ type: "string", required: false })
    expect(form[2]).toMatchObject({ type: "string", required: true, default: "write" })
    expect((form[2]!["options"] as Array<{ description: string }>)[0]!.description).toBe(`Requests: ${READ.join(" ")}`)
    expect((form[2]!["options"] as Array<{ description: string }>)[1]!.description).toBe(`Requests: ${WRITE.join(" ")}`)
    expect(form[3]).toMatchObject({ type: "boolean", required: true, when: [{ key: "access", op: "eq", value: "write" }] })
  })

  it("starts a sign-in that requests only read and identity scopes", async () => {
    const answer = { clientId: TEST_CLIENT.clientId, clientSecret: TEST_CLIENT.clientSecret, access: "read" }
    const { data } = await host.opencode.integration.oauth.connect({ integrationID: "gws-default", methodID: "google", answer, ...at() })
    try {
      const authorize = new URL(data.url)
      expect(authorize.searchParams.get("scope")?.split(" ")).toEqual(READ)
      expect(authorize.searchParams.get("client_id")).toBe(TEST_CLIENT.clientId)
      expect(data.instructions).toContain("redirect_uri_mismatch")
    } finally {
      await host.opencode.integration.oauth.cancel({ integrationID: "gws-default", attemptID: data.attemptID, ...at() })
    }
  })

  it("starts a Read and write sign-in that requests every scope in one consent, under the cap", async () => {
    const answer = { clientId: TEST_CLIENT.clientId, clientSecret: TEST_CLIENT.clientSecret, access: "write", confirmWrite: true }
    const { data } = await host.opencode.integration.oauth.connect({ integrationID: "gws-default", methodID: "google", answer, ...at() })
    try {
      const scopes = new URL(data.url).searchParams.get("scope")?.split(" ") ?? []
      expect(scopes).toEqual(WRITE)
      expect(scopes.length).toBeLessThanOrEqual(MAX_SCOPES)
    } finally {
      await host.opencode.integration.oauth.cancel({ integrationID: "gws-default", attemptID: data.attemptID, ...at() })
    }
  })

  it("lets the host refuse a malformed client ID before the plugin runs", async () => {
    const answer = { clientId: "not a client", clientSecret: TEST_CLIENT.clientSecret, access: "read" }
    await expect(host.opencode.integration.oauth.connect({ integrationID: "gws-default", methodID: "google", answer, ...at() })).rejects.toThrow()
  })

  it("refuses write without the acknowledgment, before any network call", async () => {
    await expect(host.opencode.integration.oauth.connect({ integrationID: "gws-default", methodID: "google", answer: { access: "write" }, ...at() })).rejects.toThrow()
  })
})

describe("scope preflight with a read-only sign-in", () => {
  beforeAll(async () => {
    await host.opencode.credential.create({ integrationID: "gws-default", value: storedSignIn("read", READ) as never, activate: true })
  })

  it("runs a read", async () => {
    const before = host.invocations().length
    const result = await read(request("gmail.users.getProfile", { account: "default", params: { userId: "me" } }))
    expect(result["error"]).toBeUndefined()
    expect(result).toMatchObject({ ok: true, operation: "gmail.users.getProfile" })
    expect(host.invocations().length).toBe(before + 1)
  })

  it("fails a write plan with AUTH_SCOPE_MISSING and the next step, without spawning gws", async () => {
    const before = host.invocations().length
    const result = await execute(call("plan", request("drive.files.create", { account: "default", body: { name: "host-test" } })))
    expect(String(result["error"])).toMatch(/AUTH_SCOPE_MISSING: .*drive\.files\.create.*choose Read and write/)
    expect(host.invocations().length).toBe(before)
  })

  it("shows the access, client source, and granted scopes in status", async () => {
    const result = await execute(call("status", {}))
    expect((result["value"] as { accounts: unknown[] }).accounts).toEqual([
      expect.objectContaining({ alias: "default", connected: true, access: "read", clientSource: "pasted", grantedScopes: READ, missingScopes: [] }),
    ])
    expect(JSON.stringify(result)).not.toContain(TEST_CLIENT.clientSecret)
    expect(READ).toEqual(expect.arrayContaining([...IDENTITY_SCOPES]))
  })
})

describe("onboarding commands", () => {
  // A synthetic message with resume: false is enqueued in the session inbox; 2.2.3 emits no separate event for it.
  const posted = (command: string) => (event: { type: string; data?: Record<string, unknown> }) =>
    event.type === "session.inbox.enqueued" && (event.data?.["item"] as { type?: string } | undefined)?.type === "synthetic" && JSON.stringify(event).includes(`"command":"${command}"`)

  it("posts /gws-status with the signed-in account and no setup steps", async () => {
    await host.opencode.sessions.command({ sessionID, name: "gws-status", text: "" })
    const event = JSON.stringify(await host.waitForEvent(posted("gws-status")))
    expect(event).toContain("Connection: connected\\nAccount: default (OpenCode sign-in)\\nAccess: read-only\\nClient: entered at sign-in")
    expect(event).toContain("No pending plans in this session.")
    expect(event).not.toContain("Set up an OAuth client")
  })

  it("posts /gws-doctor results after one read per service", async () => {
    const before = host.invocations().length
    await host.opencode.sessions.command({ sessionID, name: "gws-doctor", text: "" })
    const event = await host.waitForEvent(posted("gws-doctor"))
    expect(host.invocations().length).toBe(before + PROBED.length)
    for (const service of ["gmail", "drive", "calendar", "docs", "sheets"]) expect(JSON.stringify(event)).toContain(`- default ${service}: OK`)
  })
})

describe("the default account after a Read and write consent", () => {
  beforeAll(async () => {
    await host.opencode.credential.create({ integrationID: "gws-default", value: storedSignIn("write", WRITE) as never, activate: true })
  })

  it("lists every service at write access with no missing scopes", async () => {
    const result = await execute(call("status", {}))
    const [account] = (result["value"] as { accounts: Array<Record<string, unknown>> }).accounts
    expect(account).toMatchObject({ alias: "default", connected: true, access: "write", missingScopes: [] })
    expect([...(account!["services"] as string[])].sort()).toEqual([...SERVICES].sort())
  })

  it("plans a write that a read-only sign-in could not", async () => {
    const result = await execute(call("plan", request("drive.files.create", { account: "default", body: { name: "host-test" } })))
    expect(result["error"]).toBeUndefined()
    expect(result["value"]).toMatchObject({ ok: true, category: "write" })
  })
})
