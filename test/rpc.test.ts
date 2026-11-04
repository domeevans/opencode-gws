import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { integrationConnection } from "../src/host/integrations.js"
import { registerRpc, statusSource } from "../src/host/rpc.js"
import { IDENTITY_SCOPES, SCOPE_PREFIX, requestedScopes } from "../src/domain/scopes.js"
import { Gws, RPC_ID, isStatus } from "../src/rpc.js"
import type { Runtime } from "../src/runtime/index.js"
import { STORED_REFRESH, STORED_TOKEN, TEST_CLIENT, account, storedSignIn, testRuntime } from "./support/config.js"

// The fake gws lives under the repo: binary trust rejects world-writable
// ancestors such as /tmp.
let dir: string
let binary: string


beforeAll(() => {
  dir = mkdtempSync(join(process.cwd(), ".rpc-test-"))
  binary = join(dir, "gws")
  writeFileSync(binary, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "gws 0.22.5"; exit 0; fi\nprintf '{"id":"m1"}'\n`)
  chmodSync(binary, 0o755)
})

afterAll(() => rmSync(dir, { recursive: true, force: true }))

type Handler = (input: unknown, context: { signal: AbortSignal; error: (type: string, message: string, data?: unknown) => unknown }) => Promise<unknown>

interface Harness {
  runtime: Runtime
  handlers: Record<string, Handler>
  disposed: () => boolean
  stop: () => Promise<void>
}

let harness: Harness | undefined

afterEach(async () => {
  vi.unstubAllEnvs()
  await harness?.stop()
  await harness?.runtime.close()
  harness = undefined
})

interface SetupOptions {
  /** Active connection per integration id: a value, a pending promise, or an error to throw. */
  connections?: Record<string, unknown>
  /** Stored credential per integration id. */
  credentials?: Record<string, unknown>
  host?: { version: string | null; range: string; tested: boolean }
  accounts?: Record<string, unknown>
  /** The agents OpenCode lists. */
  agents?: Array<{ id: string; permissions: Array<{ action: string; resource: string; effect: "allow" | "deny" | "ask" }> }>
}

async function setup(options: SetupOptions = {}): Promise<Harness> {
  const ids = new Map([
    ["personal", "gws-personal"],
    ["work", "gws-work"],
    ["ci", "gws-ci"],
  ])
  const ctx = {
    rpc: {
      register: async (definition: { id: string }, registered: Record<string, Handler>) => {
        expect(definition).toBe(Gws)
        Object.assign(handlers, registered)
        return { dispose: async () => { disposed = true } }
      },
    },
    integration: {
      connection: {
        active: async (id: string) => {
          const connection = options.connections?.[id]
          if (connection instanceof Error) throw connection
          return connection
        },
        resolve: async (connection: { integrationID?: string; id: string }) => options.credentials?.[connection.id],
      },
    },
  }
  const runtime = await testRuntime(
    {
      binary: { path: binary },
      accounts: options.accounts ?? { personal: account(), work: account({ services: ["gmail", "drive"] }) },
    },
    { host: options.host ?? { version: "2.2.3", range: ">=2.2.3 <2.3.0", tested: true }, connection: integrationConnection(ctx as never, ids) },
  )
  const handlers: Record<string, Handler> = {}
  let disposed = false
  const stop = await registerRpc(ctx as never, runtime, statusSource(runtime, async () => options.agents ?? []))
  harness = { runtime, handlers, disposed: () => disposed, stop }
  return harness
}

function rpcContext(signal = new AbortController().signal) {
  return { signal, error: (type: string, message: string, data?: unknown) => ({ type, message, data, handlerError: true }) }
}

async function status(h: Harness): Promise<Record<string, unknown> & { accounts: Array<Record<string, unknown>> }> {
  const output = await h.handlers.status!({}, rpcContext())
  expect(isStatus(output)).toBe(true)
  return output as never
}

const url = (scope: string) => `${SCOPE_PREFIX}${scope}`

describe("rpc contract", () => {
  it("is plain JSON Schema and exposes only status", () => {
    expect(Gws.id).toBe(RPC_ID)
    expect(Object.keys(Gws.methods)).toEqual(["status"])
    expect(Object.keys(Gws.events)).toEqual([])
    const { input, output } = Gws.methods.status
    expect(input).toEqual({ type: "object", properties: {}, additionalProperties: false })
    expect(output).toMatchObject({ type: "object", required: ["version", "host", "state", "gws", "services", "accounts", "unguardedAgents", "nextStep"] })
    expect(JSON.parse(JSON.stringify(output))).toEqual(output)
  })

  it("accepts only the status shape in isStatus", () => {
    const valid = { version: "1", host: { version: "2.2.3", range: ">=2.2.3 <2.3.0", tested: true }, state: "sign_in_required", nextStep: "Sign in.", gws: { path: "/g", version: "gws 0.22.5" }, services: [], accounts: [{ alias: "a", mode: "interactive", services: [], connected: false, access: "read" }], unguardedAgents: [] }
    expect(isStatus(valid)).toBe(true)
    expect(isStatus({ ...valid, accounts: [{ ...valid.accounts[0], delegationRequired: ["keep"] }] })).toBe(true)
    for (const broken of [
      null,
      { ...valid, unguardedAgents: undefined },
      { ...valid, gws: { path: "/g" } },
      { ...valid, accounts: [{ ...valid.accounts[0], mode: "other" }] },
      { ...valid, accounts: [{ ...valid.accounts[0], needsAuth: false }] },
      { ...valid, host: { ...valid.host, tested: "yes" } },
      { ...valid, host: { ...valid.host, version: undefined } },
      { ...valid, state: "ready" },
      { ...valid, nextStep: undefined },
      { ...valid, accounts: [{ ...valid.accounts[0], delegationRequired: "keep" }] },
    ]) expect(isStatus(broken), JSON.stringify(broken)).toBe(false)
  })
})

describe("status", () => {
  it("shows each account's access, client source, granted and missing scopes, and next step, never a token or secret", async () => {
    const work = requestedScopes(["gmail", "drive"], "write").filter((scope) => scope !== url("drive"))
    const h = await setup({
      connections: {
        "gws-personal": { type: "credential", id: "cred_1", label: "personal", method: "oauth" },
        "gws-work": { type: "credential", id: "cred_2", label: "work", method: "oauth" },
      },
      credentials: { cred_1: storedSignIn("read", requestedScopes(["gmail"], "read"), "plugin"), cred_2: storedSignIn("write", work) },
    })
    const output = await status(h)
    expect(output).toMatchObject({ version: "test", host: { version: "2.2.3", range: ">=2.2.3 <2.3.0", tested: true }, gws: { path: binary, version: "gws 0.22.5" }, services: ["drive", "gmail"], auditDegraded: false })
    expect(output.accounts).toEqual([
      {
        alias: "personal",
        mode: "interactive",
        services: ["gmail"],
        integrationID: "gws-personal",
        connected: true,
        access: "read",
        clientSource: "plugin",
        grantedScopes: [url("gmail.readonly"), ...IDENTITY_SCOPES],
        missingScopes: [],
      },
      {
        alias: "work",
        mode: "interactive",
        services: ["gmail", "drive"],
        integrationID: "gws-work",
        connected: true,
        access: "write",
        clientSource: "pasted",
        grantedScopes: work,
        missingScopes: [url("drive")],
        nextStep: "To sign in again, run /connect and choose Google Workspace (work), or run opencode auth login gws-work, and approve every scope Google lists.",
      },
    ])
    const text = JSON.stringify(output)
    for (const secret of [STORED_TOKEN, STORED_REFRESH, TEST_CLIENT.clientSecret, "cred_"]) expect(text).not.toContain(secret)
  })

  it("names Keep as needing domain-wide delegation for an interactive account whose scopes do not add it", async () => {
    const h = await setup({
      accounts: {
        notes: account({ services: ["gmail", "keep"], oauthClient: TEST_CLIENT }),
        delegated: account({ services: ["keep"], scopes: ["keep"], oauthClient: TEST_CLIENT }),
        ci: { mode: "credentials_file", enabledServices: ["keep"], credentialsFileEnv: "GWS_TEST_CREDENTIALS" },
      },
    })
    const [notes, delegated, ci] = (await status(h)).accounts
    expect(notes).toMatchObject({ alias: "notes", delegationRequired: ["keep"] })
    expect(delegated).not.toHaveProperty("delegationRequired")
    expect(ci).not.toHaveProperty("delegationRequired")
  })

  it("gives the sign-in step to accounts without a connection, and the setup step when no client is available", async () => {
    const h = await setup({ accounts: { personal: account({ oauthClient: TEST_CLIENT }), work: account() } })
    const [personal, work] = (await status(h)).accounts
    expect(personal).toEqual({
      alias: "personal",
      mode: "interactive",
      services: ["gmail"],
      integrationID: "gws-personal",
      connected: false,
      access: "read",
      clientSource: "account",
      nextStep: "To sign in, run /connect and choose Google Workspace (personal), or run opencode auth login gws-personal.",
    })
    expect(work).toMatchObject({ connected: false, access: "read", nextStep: "Run /connect and choose Google Workspace (work), then enter your Desktop OAuth client ID and secret, or ask your administrator." })
    expect(work).not.toHaveProperty("clientSource")
  })

  it("asks for a new sign-in when the host marks the connection or the credential is unreadable", async () => {
    const h = await setup({
      connections: {
        "gws-personal": { type: "credential", id: "cred_1", label: "p", method: "oauth", status: { status: "needs_auth", message: "expired" } },
        "gws-work": { type: "credential", id: "cred_2", label: "w", method: "oauth" },
      },
      credentials: { cred_1: storedSignIn("read", requestedScopes(["gmail"], "read")), cred_2: { type: "oauth", access: STORED_TOKEN, refresh: STORED_REFRESH, expires: 0 } },
    })
    const [personal, work] = (await status(h)).accounts
    expect(personal).toMatchObject({ connected: false, needsAuth: true, access: "read", clientSource: "pasted", nextStep: "To sign in again, run /connect and choose Google Workspace (personal), or run opencode auth login gws-personal." })
    expect(work).toMatchObject({ connected: false, nextStep: "To sign in again, run /connect and choose Google Workspace (work), or run opencode auth login gws-work." })
    expect(work).not.toHaveProperty("grantedScopes")
  })

  it("names the unguarded agents with their block, and gives one next step for the plugin", async () => {
    const allow = { action: "*", resource: "*", effect: "allow" as const }
    const h = await setup({ accounts: { personal: account({ oauthClient: TEST_CLIENT }) }, agents: [{ id: "notes", permissions: [allow] }] })
    const output = await status(h)
    expect(output["unguardedAgents"]).toEqual(["notes"])
    expect(output["permissionsBlock"]).toContain('"notes": {')
    expect(output["permissionsBlock"]).toContain('{"action":"gws.write","resource":"*","effect":"ask"}')
    expect(output["nextStep"]).toBe((output.accounts[0] as { nextStep: string }).nextStep)
  })

  it("points the next step at the unguarded agents once every account is ready", async () => {
    vi.stubEnv("GWS_CREDENTIALS", "/dev/null")
    const allow = { action: "*", resource: "*", effect: "allow" as const }
    const h = await setup({ accounts: { ci: { mode: "credentials_file", enabledServices: ["drive"], credentialsFileEnv: "GWS_CREDENTIALS" } }, agents: [{ id: "notes", permissions: [allow] }] })
    expect((await status(h))["nextStep"]).toBe("Put the permission block first in the own permissions of each agent without default rules, followed by your top-level rules for gws actions.")
  })

  it("says Nothing to do. when every account is ready and every agent guarded", async () => {
    vi.stubEnv("GWS_CREDENTIALS", "/dev/null")
    const h = await setup({ accounts: { ci: { mode: "credentials_file", enabledServices: ["drive"], credentialsFileEnv: "GWS_CREDENTIALS" } } })
    const output = await status(h)
    expect(output["unguardedAgents"]).toEqual([])
    expect(output).not.toHaveProperty("permissionsBlock")
    expect(output).toMatchObject({ state: "connected", nextStep: "Nothing to do." })
  })

  it("treats a failing connection lookup as not connected", async () => {
    const h = await setup({ connections: { "gws-work": new Error("store unavailable") } })
    expect((await status(h)).accounts.map((entry) => [entry["alias"], entry["connected"]])).toEqual([
      ["personal", false],
      ["work", false],
    ])
  })

  it("reports a headless account connected when its variable is set, with no sign-in fields, and says which variable to set otherwise", async () => {
    const h = await setup({ accounts: { ci: { mode: "credentials_file", enabledServices: ["drive"], credentialsFileEnv: "GWS_CREDENTIALS" } } })
    expect((await status(h)).accounts).toEqual([
      { alias: "ci", mode: "credentials_file", services: ["drive"], connected: false, nextStep: "Set GWS_CREDENTIALS and restart OpenCode." },
    ])
    vi.stubEnv("GWS_CREDENTIALS", "/dev/null")
    expect((await status(h)).accounts).toEqual([{ alias: "ci", mode: "credentials_file", services: ["drive"], connected: true }])
  })

  it("reports the shared fields: version, host, state, unguardedAgents and nextStep", async () => {
    const signedOut = await setup()
    expect(await status(signedOut)).toMatchObject({ version: "test", state: "sign_in_required", unguardedAgents: [], nextStep: expect.stringMatching(/^personal: /) })
    await signedOut.stop()
    await signedOut.runtime.close()
    const untested = { version: "2.2.9", range: ">=2.2.3 <2.3.0", tested: false }
    const headless = { ci: { mode: "access_token", enabledServices: ["gmail"], tokenEnv: "GWS_RPC_TEST_TOKEN" } }
    process.env["GWS_RPC_TEST_TOKEN"] = "ya29.test"
    try {
      const h = await setup({ host: untested, accounts: headless })
      expect(await status(h)).toMatchObject({ host: untested, state: "host_untested", nextStep: "Nothing to do." })
      await h.stop()
      await h.runtime.close()
    } finally {
      delete process.env["GWS_RPC_TEST_TOKEN"]
    }
    const unset = await setup({ accounts: headless })
    expect(await status(unset)).toMatchObject({ state: "not_configured" })
  })

  it("projects audit degradation", async () => {
    const h = await setup()
    const base = await h.runtime.status()
    vi.spyOn(h.runtime, "status").mockResolvedValue({ ...base, auditDegraded: true })
    expect(await status(h)).toMatchObject({ auditDegraded: true })
  })
})

describe("rpc lifecycle", () => {
  it("revokes a pending status lookup and refuses retained callbacks after close", async () => {
    let finish!: (value: unknown) => void
    const pending = new Promise((resolve) => { finish = resolve })
    const h = await setup({ connections: { "gws-personal": pending } })
    const call = h.handlers.status!(undefined, rpcContext())
    const rejected = expect(call).rejects.toThrow(/^CANCELLED:/)
    await h.runtime.close()
    await rejected
    finish({ type: "credential", id: "cred_1" })
    await expect(h.handlers.status!(undefined, rpcContext())).rejects.toThrow(/^CANCELLED:/)
  })

  it("cancels a pending status lookup through the RPC invocation signal", async () => {
    const h = await setup({ connections: { "gws-personal": new Promise(() => {}) } })
    const abort = new AbortController()
    const call = h.handlers.status!(undefined, rpcContext(abort.signal))
    const rejected = expect(call).rejects.toThrow(/^CANCELLED:/)
    abort.abort()
    await rejected
  })

  it("disposes the registration on cleanup", async () => {
    const h = await setup()
    await h.stop()
    expect(h.disposed()).toBe(true)
  })
})
