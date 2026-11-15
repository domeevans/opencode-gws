import type { PluginMethod, ToolCall } from "@we-the-rebel-alliance/source-contract/tools-rpc"
import { afterEach, describe, expect, it } from "vitest"
import { readSignIn } from "../src/auth/credential.js"
import { integrationConnection, integrationIds, integrationTokenProvider } from "../src/host/integrations.js"
import { statusSource } from "../src/host/rpc.js"
import { scriptMethods } from "../src/host/script-methods.js"
import type { Runtime } from "../src/runtime/index.js"
import { agentCopy, JELLY, keepsMetadataKey } from "./support/agent-copy.js"
import { ACCOUNT, ALL_SCOPES, storedSignIn, testConfig, testRuntime } from "./support/config.js"

/**
 * Jelly's copy of a person's gws sign-in for an agent (D210): the access token, `jelly-host-owns-refresh` for the
 * refresh token, a claimed day, and every metadata key but the secret-named ones, so the client secret stays with the
 * person. Every read works on it.
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

describe("jelly's rules (fixture)", () => {
  it("keep every fact jelly lists, refuse every secret it lists, and leave out exactly gws's client secret", () => {
    for (const key of JELLY.kept) expect([key, keepsMetadataKey(key)]).toEqual([key, true])
    for (const key of JELLY.refused) expect([key, keepsMetadataKey(key)]).toEqual([key, false])
    const { person, copy } = signedIn()
    expect(Object.keys(person.metadata).filter((key) => !(key in copy.metadata))).toEqual(["clientSecret"])
    expect(copy).toMatchObject({ refresh: JELLY.sentinel, access: person.access })
  })
})

describe("reading an agent's copy", () => {
  it("readSignIn reads the access, scopes, email and domain", () => {
    const { copy } = signedIn()
    expect(readSignIn(copy.metadata)).toMatchObject({ access: "read", grantedScopes: ALL_SCOPES, email: EMAIL, domain: "example.com" })
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
