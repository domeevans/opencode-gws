import type { PluginMethod, ToolCall } from "@we-the-rebel-alliance/source-contract/tools-rpc"
import { afterEach, describe, expect, it, vi } from "vitest"
import { HOST_OWNED_REFRESH, readSignIn, renewableSignIn } from "../src/auth/credential.js"
import { refreshGoogle } from "../src/auth/google.js"
import { integrationConnection, integrationIds, integrationTokenProvider, registerIntegrations } from "../src/host/integrations.js"
import { statusSource } from "../src/host/rpc.js"
import { scriptMethods } from "../src/host/script-methods.js"
import type { Runtime } from "../src/runtime/index.js"
import { agentCopy, JELLY, keepsMetadataKey } from "./support/agent-copy.js"
import { ACCOUNT, ALL_SCOPES, account, storedSignIn, testConfig, testRuntime } from "./support/config.js"

/**
 * Jelly's copy of a person's gws sign-in for an agent (D210): the access token, `jelly-host-owns-refresh` for the
 * refresh token, a claimed day, and every metadata key but the secret-named ones, so the client secret stays with the
 * person. Every read works on it; a renewal never runs from it, and never reaches Google.
 */

const EMAIL = "ada@example.com"
const runtimes: Runtime[] = []
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.close()
})

/** The person's sign-in, as gws stores it, and the copy Jelly makes of it for an agent. */
function signedIn() {
  const person = storedSignIn("read", ALL_SCOPES, "plugin")
  const stored = { ...person, metadata: { ...person.metadata, email: EMAIL, domain: "example.com" } }
  return { person: stored, copy: agentCopy(stored) }
}

/** The host's integration API, holding one stored credential for every account. */
function host(credential: unknown) {
  const active = { type: "credential" as const, id: "cred_1", method: "oauth" as const }
  return {
    integration: {
      get: async ({ integrationID }: { integrationID: string }) => ({ data: { id: integrationID, name: "Google Workspace", connections: [active] } }),
      connection: { active: async () => active, resolve: async () => credential, status: async () => {} },
    },
  }
}

/** A fake `fetch` that counts the calls it gets, and answers none. */
function countingFetch() {
  const fetch = vi.fn(async () => {
    throw new Error("no network in this test")
  })
  return fetch
}

describe("jelly's rules (fixture)", () => {
  it("keep every fact jelly lists, refuse every secret it lists, and leave out exactly gws's client secret", () => {
    for (const key of JELLY.kept) expect([key, keepsMetadataKey(key)]).toEqual([key, true])
    for (const key of JELLY.refused) expect([key, keepsMetadataKey(key)]).toEqual([key, false])
    const { person, copy } = signedIn()
    expect(Object.keys(person.metadata).filter((key) => !(key in copy.metadata))).toEqual(["clientSecret"])
    expect(copy).toMatchObject({ refresh: JELLY.sentinel, access: person.access })
    expect(JELLY.sentinel).toBe(HOST_OWNED_REFRESH)
  })
})

describe("reading an agent's copy", () => {
  it("readSignIn reads the access, scopes, email and domain; it cannot be renewed", () => {
    const { copy } = signedIn()
    expect(readSignIn(copy.metadata)).toMatchObject({ access: "read", grantedScopes: ALL_SCOPES, email: EMAIL, domain: "example.com" })
    expect(renewableSignIn(copy.metadata)).toBeUndefined()
  })

  it("the token provider gives the copy's access token and the scopes Google granted", async () => {
    const { copy } = signedIn()
    const config = testConfig()
    const provider = integrationTokenProvider(host(copy) as never, config, integrationIds(config.accounts))
    expect(await provider(ACCOUNT)).toEqual({ access: copy.access, grantedScopes: ALL_SCOPES })
  })

  it("status shows the account signed in, with its email", async () => {
    const { copy } = signedIn()
    const config = testConfig()
    const view = await integrationConnection(host(copy) as never, integrationIds(config.accounts))(ACCOUNT)
    expect(view).toEqual({ connected: true, needsAuth: false, signIn: { access: "read", clientSource: "plugin", grantedScopes: ALL_SCOPES, email: EMAIL, domain: "example.com" } })
  })

  it("the probe names the verified email, through the same status every caller reads", async () => {
    const { copy } = signedIn()
    const config = testConfig()
    const ids = integrationIds(config.accounts)
    const runtime = await testRuntime({}, { connection: integrationConnection(host(copy) as never, ids), tokenProvider: integrationTokenProvider(host(copy) as never, config, ids) })
    runtimes.push(runtime)
    const methods = scriptMethods({ runtime, status: statusSource(runtime, async () => []), assert: async () => {} }) as PluginMethod[]
    const call: ToolCall = { sessionID: "ses_copy", agent: "build", messageID: "msg_copy", id: "call_copy", signal: new AbortController().signal, progress: async () => {} }
    const probe = methods.find((method) => method.name === "probe")!
    expect(await probe.run({ source: "gmail" }, call)).toMatchObject({ account: ACCOUNT, owner: { id: `mailto:${EMAIL}`, label: EMAIL } })
  })
})

describe("renewing", () => {
  it("the sentinel is refused first, with gws's sign-in-again AUTH_REQUIRED and no network call", async () => {
    const fetch = countingFetch()
    const { person, copy } = signedIn()
    // Even with the client secret still there, the sentinel is never sent to Google.
    for (const credential of [copy, { ...person, refresh: HOST_OWNED_REFRESH }]) {
      await expect(refreshGoogle({ alias: ACCOUNT, name: "Google Workspace", credential, options: { fetch: fetch as never } })).rejects.toThrow(
        /^AUTH_REQUIRED: .* Next step: Run \/connect, choose Google Workspace, and sign in again\.$/,
      )
    }
    expect(fetch).toHaveBeenCalledTimes(0)
  })

  it("a copy without its client secret is never renewed, whatever its refresh token", async () => {
    const fetch = countingFetch()
    const { copy } = signedIn()
    await expect(refreshGoogle({ alias: ACCOUNT, name: "Google Workspace", credential: { ...copy, refresh: "1//a-refresh-token" }, options: { fetch: fetch as never } })).rejects.toThrow(/^AUTH_REQUIRED: /)
    expect(fetch).toHaveBeenCalledTimes(0)
  })

  it("the registered method refuses the sentinel as the plugin's AUTH_REQUIRED, and labels the account by its email", async () => {
    const methods: Array<{ refresh: (credential: unknown) => Promise<unknown>; label: (credential: unknown) => string | undefined }> = []
    const ctx = {
      integration: {
        transform: async (callback: (draft: unknown) => void) =>
          callback({ update: () => {}, method: { update: (input: (typeof methods)[number]) => methods.push(input) } }),
      },
    }
    await registerIntegrations(ctx as never, testConfig({ accounts: { personal: account() } }))
    const { person, copy } = signedIn()
    await expect(methods[0]!.refresh(copy)).rejects.toThrow(/^AUTH_REQUIRED: /)
    expect(methods[0]!.label(person)).toBe(EMAIL)
    expect(methods[0]!.label(copy)).toBe(EMAIL)
    expect(methods[0]!.label(storedSignIn("read", ALL_SCOPES))).toBe(ACCOUNT)
  })
})
