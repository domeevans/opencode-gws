import { createHash } from "node:crypto"
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { createServer, type Server } from "node:http"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it, vi } from "vitest"
import { readAnswer } from "../src/auth/form.js"
import {
  GOOGLE_AUTHORIZE_ENDPOINT,
  GOOGLE_METHOD_ID,
  buildAuthorizeUrl,
  createPkce,
  refreshGoogle,
  type GoogleOAuthAuthorization,
  type OAuthCredential,
} from "../src/auth/google.js"
import { loadConfig } from "../src/domain/config.js"
import { IDENTITY_SCOPES, SCOPE_PREFIX, requestedScopes, shortScope } from "../src/domain/scopes.js"
import type { AccountProfile } from "../src/domain/types.js"
import {
  googleIntegration,
  integrationIdFor,
  integrationIds,
  integrationNames,
  registerIntegrations,
  sanitizeIntegrationAlias,
  type GoogleIntegrationOptions,
} from "../src/host/integrations.js"
import { buildChildEnv } from "../src/process/env.js"
import type { Runtime } from "../src/runtime/index.js"
import { TEST_CLIENT, account, accountDir, fakeTokens, testConfig, testRuntime } from "./support/config.js"
import { request } from "./support/requests.js"

const tempDirs: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "opencode-gws-auth-"))
  tempDirs.push(dir)
  return dir
}
const runtimes: Runtime[] = []
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.close()
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const url = (scope: string) => `${SCOPE_PREFIX}${scope}`
/** An id_token as Google's token endpoint returns it, with these claims. */
const idToken = (claims: Record<string, unknown>) => `eyJhbGciOiJSUzI1NiJ9.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.c2ln`
/** The account with no plugin options at all: every service, Read and write by default. */
const defaultProfile = (): AccountProfile => loadConfig({}).accounts.default!
const withoutIdentity = (scopes: readonly string[]) => scopes.filter((scope) => !IDENTITY_SCOPES.includes(scope))
const READ_DEFAULT = withoutIdentity(requestedScopes(defaultProfile().enabledServices, "read"))
const WRITE_DEFAULT = withoutIdentity(requestedScopes(defaultProfile().enabledServices, "write"))
const pasted = (client = TEST_CLIENT) => ({ clientId: client.clientId, clientSecret: client.clientSecret })

interface MockTokenServer {
  url: string
  requests: URLSearchParams[]
  close: () => Promise<void>
}

async function tokenServer(responder: (params: URLSearchParams) => { status: number; body: unknown }): Promise<MockTokenServer> {
  const requests: URLSearchParams[] = []
  const server: Server = createServer(async (incoming, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of incoming) chunks.push(Buffer.from(chunk))
    const params = new URLSearchParams(Buffer.concat(chunks).toString("utf8"))
    requests.push(params)
    const result = responder(params)
    response.writeHead(result.status, { "Content-Type": "application/json", Connection: "close" })
    response.end(JSON.stringify(result.body))
  })
  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (address && typeof address !== "string") resolve(address.port)
      else reject(new Error("no port"))
    })
  })
  return {
    url: `http://127.0.0.1:${port}/token`,
    requests,
    close: () => new Promise<void>((resolve) => {
      server.close(() => resolve())
      server.closeAllConnections?.()
    }),
  }
}

const scopesOf = (authorization: GoogleOAuthAuthorization) => new URL(authorization.url).searchParams.get("scope")?.split(" ")
const stateOf = (authorization: GoogleOAuthAuthorization) => new URL(authorization.url).searchParams.get("state") ?? ""

async function completeCallback(authorization: GoogleOAuthAuthorization, params: Record<string, string>): Promise<Response> {
  const target = new URL(new URL(authorization.url).searchParams.get("redirect_uri")!)
  for (const [key, value] of Object.entries(params)) target.searchParams.set(key, value)
  return await fetch(target, { redirect: "manual" })
}

/** A sign-in that is abandoned: the callback rejection is expected and ignored. */
async function abandon(authorization: GoogleOAuthAuthorization): Promise<void> {
  const settled = authorization.callback.catch(() => undefined)
  await completeCallback(authorization, { error: "access_denied", state: stateOf(authorization) })
  await settled
}

function integration(profile: AccountProfile = defaultProfile(), options: GoogleIntegrationOptions = {}) {
  return googleIntegration("default", profile, "gws-default", options)
}

describe("integration identity", () => {
  it("derives stable ids and names from account aliases", () => {
    expect(sanitizeIntegrationAlias("personal")).toBe("personal")
    expect(sanitizeIntegrationAlias("Personal Work")).toBe("personal-work")
    expect(sanitizeIntegrationAlias("  Personal__Work!! ")).toBe("personal-work")
    expect(sanitizeIntegrationAlias("!!!")).toBe("account")
    expect(integrationIdFor("Personal Work")).toBe("gws-personal-work")
    expect(integrationNames({ only: { mode: "interactive" }, ci: { mode: "credentials_file" } })).toEqual(new Map([["only", "Google Workspace"]]))
    expect(integrationNames({ Personal: { mode: "interactive" }, work: { mode: "interactive" } })).toEqual(
      new Map([
        ["Personal", "Google Workspace (Personal)"],
        ["work", "Google Workspace (work)"],
      ]),
    )
    expect([...integrationIds({ Work: {}, work: {}, "Personal Work": {} }).values()]).toEqual(["gws-work", "gws-work-2", "gws-personal-work"])
  })

  it("registers one integration per interactive account and none for headless accounts", async () => {
    const config = testConfig({
      accounts: {
        personal: account({ services: ["gmail"] }),
        work: account({ services: ["drive"] }),
        ci: { mode: "credentials_file", enabledServices: ["drive"], credentialsFileEnv: "GWS_CREDENTIALS" },
      },
    })
    const integrations = new Map<string, { id: string; name: string }>()
    const methods: Array<{ integrationID: string; method: { form: unknown[] }; label?: () => string | undefined }> = []
    const ctx = {
      integration: {
        transform: async (callback: (draft: unknown) => void) =>
          callback({
            update: (id: string, update: (ref: { id: string; name: string }) => void) => {
              const ref = integrations.get(id) ?? { id, name: id }
              update(ref)
              integrations.set(id, ref)
            },
            method: { update: (input: (typeof methods)[number]) => methods.push(input) },
          }),
      },
    }
    expect(await registerIntegrations(ctx as never, config)).toBe(2)
    expect([...integrations.values()]).toEqual([
      { id: "gws-personal", name: "Google Workspace (personal)" },
      { id: "gws-work", name: "Google Workspace (work)" },
    ])
    expect(methods.map((method) => [method.integrationID, method.label?.(), method.method.form.length])).toEqual([
      ["gws-personal", "personal", 7],
      ["gws-work", "work", 7],
    ])
  })
})

describe("sign-in form", () => {
  it("has the client ID and secret, access, and write acknowledgment fields, and lists each option's exact scopes", () => {
    const [clientId, clientSecret, access, confirm] = integration().method.form
    expect([clientId.key, clientSecret.key, access.key, confirm.key]).toEqual(["clientId", "clientSecret", "access", "confirmWrite"])
    expect(access).toMatchObject({ type: "string", required: true, default: "write" })
    expect(access.options.map((option) => [option.value, option.label])).toEqual([
      ["read", "Read-only"],
      ["write", "Read and write"],
    ])
    expect(access.options[0]!.description).toBe(`Requests: ${[...READ_DEFAULT, ...IDENTITY_SCOPES].join(" ")}`)
    expect(access.options[1]!.description).toBe(`Requests: ${[...WRITE_DEFAULT, ...IDENTITY_SCOPES].join(" ")}`)
    expect(confirm).toMatchObject({
      type: "boolean",
      required: true,
      default: false,
      when: [{ key: "access", op: "eq", value: "write" }],
      title: `I understand this grants write access to: ${WRITE_DEFAULT.filter((scope) => !READ_DEFAULT.includes(scope)).map(shortScope).join(", ")}`,
    })
  })

  it("shows the client fields for a one-time paste when no option sets a client, blank reusing the previous sign-in's", () => {
    const [clientId, clientSecret] = integration().method.form
    expect(clientId).toMatchObject({ type: "string", title: "OAuth client ID", required: false })
    expect(clientSecret).toMatchObject({ type: "string", title: "OAuth client secret", required: false })
    for (const field of [clientId, clientSecret]) {
      expect(field).not.toHaveProperty("hidden")
      expect(field).not.toHaveProperty("default")
    }
    expect(clientId.description).toMatch(/Desktop app OAuth client/)
    expect(clientId.description).toMatch(/Leave both blank to reuse the client from this account's previous sign-in\./)
  })

  it("lets the host refuse a malformed client ID or secret, and accept blanks", () => {
    const [id, secret] = integration().method.form.map((field) => new RegExp((field as { pattern: string }).pattern))
    expect([id!.test(TEST_CLIENT.clientId), id!.test("not-a-client"), id!.test(""), id!.test("  ")]).toEqual([true, false, true, true])
    expect([secret!.test(TEST_CLIENT.clientSecret), secret!.test("has space"), secret!.test("")]).toEqual([true, false, true])
  })

  it("hides the client fields with the option's values as their default when the account or the plugin options set a client", () => {
    for (const [profile, options] of [
      [{ ...defaultProfile(), oauthClient: TEST_CLIENT }, {}],
      [defaultProfile(), { pluginClient: TEST_CLIENT }],
    ] as const) {
      const [clientId, clientSecret] = integration(profile, options).method.form
      expect(clientId).toMatchObject({ hidden: true, default: TEST_CLIENT.clientId, required: false })
      expect(clientSecret).toMatchObject({ hidden: true, default: TEST_CLIENT.clientSecret, required: false })
    }
  })

  it("defaults access to the account's configured access and shows its extra scopes in both options", () => {
    const profile = loadConfig({ accounts: { default: account({ services: ["gmail", "drive"], access: { drive: "write" }, scopes: ["directory.readonly"] }) } }).accounts.default!
    const [, , access, confirm] = integration(profile).method.form
    expect(access.default).toBe("write")
    expect(access.options[0]!.description).toBe(`Requests: ${[url("gmail.readonly"), url("drive.readonly"), url("drive.apps.readonly"), url("directory.readonly"), ...IDENTITY_SCOPES].join(" ")}`)
    expect(access.options[1]!.description).toBe(`Requests: ${[url("gmail.readonly"), url("drive"), url("drive.apps.readonly"), url("directory.readonly"), ...IDENTITY_SCOPES].join(" ")}`)
    expect(confirm.title).toBe("I understand this grants write access to: drive")
  })
})

describe("sign-in answers", () => {
  it("signs in read-only unless write is chosen explicitly and acknowledged", () => {
    for (const answer of [{}, { access: "" }, { access: "read" }, { access: "WRITE" }, { access: ["write"] }, { confirmWrite: true }]) {
      expect(readAnswer(answer as Record<string, unknown>).access).toBe("read")
    }
    expect(readAnswer({ access: "write", confirmWrite: true }).access).toBe("write")
    for (const confirmWrite of [undefined, false, "true"]) {
      expect(() => readAnswer({ access: "write", confirmWrite })).toThrow(/^AUTH_WRITE_UNCONFIRMED: .* Next step: /)
    }
  })

  it("rejects a half-entered client and a missing client before any network call", async () => {
    const fetchSpy = vi.fn()
    const definition = integration(defaultProfile(), { auth: { fetch: fetchSpy as never } })
    await expect(definition.authorize({ clientId: TEST_CLIENT.clientId, access: "read" })).rejects.toThrow(/^AUTH_CLIENT_INVALID: .* Next step: /)
    await expect(definition.authorize({ clientId: "bad id", clientSecret: TEST_CLIENT.clientSecret, access: "read" })).rejects.toThrow(/^AUTH_CLIENT_INVALID:/)
    await expect(definition.authorize({ access: "read" })).rejects.toThrow(/^AUTH_CLIENT_REQUIRED: .* Next step: /)
    await expect(definition.authorize({ clientId: "  ", clientSecret: "", access: "read" })).rejects.toThrow(/^AUTH_CLIENT_REQUIRED:/)
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe("authorization URL", () => {
  it("includes PKCE, state, redirect, offline consent, and scopes", () => {
    const authorize = new URL(
      buildAuthorizeUrl({
        clientId: TEST_CLIENT.clientId,
        redirectUri: "http://127.0.0.1:4321",
        scopes: [url("gmail.readonly"), "openid"],
        state: "state-value",
        codeChallenge: "challenge-value",
      }),
    )
    expect(`${authorize.origin}${authorize.pathname}`).toBe(GOOGLE_AUTHORIZE_ENDPOINT)
    expect(Object.fromEntries(authorize.searchParams)).toEqual({
      response_type: "code",
      client_id: TEST_CLIENT.clientId,
      redirect_uri: "http://127.0.0.1:4321",
      scope: `${url("gmail.readonly")} openid`,
      state: "state-value",
      code_challenge: "challenge-value",
      code_challenge_method: "S256",
      access_type: "offline",
      prompt: "consent",
    })
  })

  it("generates a PKCE verifier and S256 challenge", () => {
    const pkce = createPkce()
    expect(pkce.verifier.length).toBeGreaterThanOrEqual(43)
    expect(pkce.challenge).toBe(createHash("sha256").update(pkce.verifier).digest("base64url"))
  })

  it("asks only for read and identity scopes for the default account, whatever else the answer holds", async () => {
    for (const answer of [{}, { access: "read" }, { access: "nonsense" }]) {
      const authorization = await integration().authorize({ ...pasted(), ...answer })
      expect(scopesOf(authorization)).toEqual([...READ_DEFAULT, ...IDENTITY_SCOPES])
      expect(authorization.url).not.toContain(TEST_CLIENT.clientSecret)
      await abandon(authorization)
    }
  })

  it("asks for write scopes only after the acknowledgment, and names the account and scopes in the instructions", async () => {
    const authorization = await integration().authorize({ ...pasted(), access: "write", confirmWrite: true })
    expect(scopesOf(authorization)).toEqual([...WRITE_DEFAULT, ...IDENTITY_SCOPES])
    expect(authorization.instructions).toContain("Google Workspace (default) with read and write access")
    for (const scope of [...WRITE_DEFAULT, ...IDENTITY_SCOPES]) expect(authorization.instructions).toContain(scope)
    expect(authorization.instructions).toContain("If Google shows redirect_uri_mismatch, the client is not a Desktop app.")
    await abandon(authorization)
  })

  it("uses the configured client over an entered one, and an entered one over the previous sign-in's", async () => {
    const other = { clientId: "999-other.apps.googleusercontent.com", clientSecret: "other-secret" }
    const configured = await integration({ ...defaultProfile(), oauthClient: TEST_CLIENT }).authorize({ ...pasted(other), access: "read" })
    expect(new URL(configured.url).searchParams.get("client_id")).toBe(TEST_CLIENT.clientId)
    await abandon(configured)
    const own = await integration(defaultProfile(), { previous: async () => ({ client: TEST_CLIENT, source: "pasted" }) }).authorize({ ...pasted(other), access: "read" })
    expect(new URL(own.url).searchParams.get("client_id")).toBe(other.clientId)
    await abandon(own)
    const reused = await integration(defaultProfile(), { previous: async () => ({ client: other, source: "pasted" }) }).authorize({ access: "read" })
    expect(new URL(reused.url).searchParams.get("client_id")).toBe(other.clientId)
    await abandon(reused)
  })
})

describe("loopback browser flow", () => {
  it("exchanges the code with PKCE and stores the client, access, and requested and granted scopes", async () => {
    const granted = [url("gmail.readonly"), url("drive.readonly"), "openid", url("userinfo.email")]
    const mock = await tokenServer(() => ({
      status: 200,
      body: { access_token: "access-token-1", refresh_token: "refresh-token-1", expires_in: 3600, scope: granted.join(" "), token_type: "Bearer" },
    }))
    try {
      const before = Date.now()
      const authorization = await integration(defaultProfile(), { auth: { tokenEndpoint: mock.url } }).authorize({ ...pasted(), access: "read" })
      expect(authorization.mode).toBe("auto")
      expect(authorization.expiresAt).toBeGreaterThan(Date.now())
      const authorizeUrl = new URL(authorization.url)
      expect(authorizeUrl.searchParams.get("redirect_uri")).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)

      const response = await completeCallback(authorization, { code: "auth-code", state: stateOf(authorization) })
      expect(response.status).toBe(200)
      const credential = await authorization.callback
      expect(credential).toMatchObject({ type: "oauth", methodID: GOOGLE_METHOD_ID, access: "access-token-1", refresh: "refresh-token-1" })
      expect(credential.expires).toBeGreaterThanOrEqual(before + 3600 * 1000)
      expect(credential.metadata).toEqual({
        clientId: TEST_CLIENT.clientId,
        clientSecret: TEST_CLIENT.clientSecret,
        clientSource: "pasted",
        access: "read",
        requestedScopes: [...READ_DEFAULT, ...IDENTITY_SCOPES],
        grantedScopes: granted,
      })

      const sent = mock.requests[0]!
      expect(createHash("sha256").update(sent.get("code_verifier") ?? "").digest("base64url")).toBe(authorizeUrl.searchParams.get("code_challenge"))
      expect(Object.fromEntries([...sent].filter(([key]) => key !== "code_verifier"))).toEqual({
        grant_type: "authorization_code",
        code: "auth-code",
        client_id: TEST_CLIENT.clientId,
        client_secret: TEST_CLIENT.clientSecret,
        redirect_uri: authorizeUrl.searchParams.get("redirect_uri"),
      })
    } finally {
      await mock.close()
    }
  })

  it("stores the signed-in email and Workspace domain from the id_token, and nothing else from it", async () => {
    const id_token = idToken({ iss: "https://accounts.google.com", sub: "sub-never-stored", email: "ada@example.com", email_verified: true, hd: "example.com", name: "name-never-stored" })
    const mock = await tokenServer(() => ({ status: 200, body: { access_token: "a", refresh_token: "r", expires_in: 60, id_token } }))
    try {
      const authorization = await integration(defaultProfile(), { auth: { tokenEndpoint: mock.url } }).authorize({ ...pasted(), access: "read" })
      await completeCallback(authorization, { code: "c", state: stateOf(authorization) })
      const { metadata } = await authorization.callback
      expect(metadata).toMatchObject({ email: "ada@example.com", domain: "example.com" })
      expect(JSON.stringify(metadata)).not.toMatch(/never-stored|id_token|eyJ/)
    } finally {
      await mock.close()
    }
  })

  it("signs in without an identity when the token response has no id_token or a malformed one", async () => {
    for (const extra of [{}, { id_token: "not-a-jwt" }]) {
      const mock = await tokenServer(() => ({ status: 200, body: { access_token: "a", refresh_token: "r", expires_in: 60, ...extra } }))
      try {
        const authorization = await integration(defaultProfile(), { auth: { tokenEndpoint: mock.url } }).authorize({ ...pasted(), access: "read" })
        await completeCallback(authorization, { code: "c", state: stateOf(authorization) })
        const { metadata } = await authorization.callback
        expect(metadata).not.toHaveProperty("email")
        expect(metadata).not.toHaveProperty("domain")
      } finally {
        await mock.close()
      }
    }
  })

  it("records the requested scopes as granted when Google's response omits the scope field", async () => {
    const mock = await tokenServer(() => ({ status: 200, body: { access_token: "a", refresh_token: "r", expires_in: 60 } }))
    try {
      const authorization = await integration(defaultProfile(), { auth: { tokenEndpoint: mock.url } }).authorize({ ...pasted(), access: "read" })
      await completeCallback(authorization, { code: "c", state: stateOf(authorization) })
      expect((await authorization.callback).metadata?.grantedScopes).toEqual([...READ_DEFAULT, ...IDENTITY_SCOPES])
    } finally {
      await mock.close()
    }
  })

  it("rejects a callback with the wrong state", async () => {
    const authorization = await integration(defaultProfile(), { auth: { tokenEndpoint: "http://127.0.0.1:1/token" } }).authorize(pasted())
    const outcome = authorization.callback.then(() => undefined, (error: Error) => error)
    expect((await completeCallback(authorization, { code: "code", state: "wrong-state" })).status).toBe(400)
    expect((await outcome)?.message).toMatch(/state did not match/)
  })

  it("rejects on timeout", async () => {
    const authorization = await integration(defaultProfile(), { auth: { tokenEndpoint: "http://127.0.0.1:1/token", timeoutMs: 50 } }).authorize(pasted())
    await expect(authorization.callback).rejects.toThrow(/timed out/)
  })

  it("never includes tokens or secrets in a token error", async () => {
    const code = "auth-code-secret"
    const mock = await tokenServer(() => ({
      status: 400,
      body: { error: "invalid_grant", error_description: `Bad code ${code} and secret ${TEST_CLIENT.clientSecret}`, access_token: "access-token-secret" },
    }))
    try {
      const authorization = await integration(defaultProfile(), { auth: { tokenEndpoint: mock.url } }).authorize(pasted())
      const outcome = authorization.callback.then(() => undefined, (error: Error) => error)
      expect((await completeCallback(authorization, { code, state: stateOf(authorization) })).status).toBe(500)
      const message = (await outcome)?.message ?? ""
      expect(message).toMatch(/token endpoint/)
      for (const secret of ["access-token-secret", TEST_CLIENT.clientSecret, code]) expect(message).not.toContain(secret)
    } finally {
      await mock.close()
    }
  })

  it("writes no file: the auth modules never import a file-writing API", () => {
    const auth = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "auth")
    for (const file of readdirSync(auth)) {
      expect(readFileSync(join(auth, file), "utf8"), file).not.toMatch(/from "node:fs|\b(?:writeFile|appendFile|mkdir|createWriteStream)/)
    }
  })
})

describe("refresh", () => {
  const signedIn = (overrides: Record<string, unknown> = {}): OAuthCredential => ({
    type: "oauth",
    methodID: GOOGLE_METHOD_ID,
    refresh: "refresh-token-1",
    access: "access-token-1",
    expires: Date.now() + 1000,
    metadata: {
      clientId: TEST_CLIENT.clientId,
      clientSecret: TEST_CLIENT.clientSecret,
      clientSource: "pasted",
      access: "read",
      requestedScopes: [...READ_DEFAULT, ...IDENTITY_SCOPES],
      grantedScopes: [url("gmail.readonly")],
      ...overrides,
    },
  })

  it("uses the stored client, keeps the metadata, and follows a changed grant", async () => {
    const mock = await tokenServer(() => ({ status: 200, body: { access_token: "access-token-2", expires_in: 900, scope: `${url("gmail.readonly")} ${url("drive.readonly")}` } }))
    try {
      const refreshed = await refreshGoogle({ alias: "default", name: "Google Workspace", credential: signedIn(), options: { tokenEndpoint: mock.url } })
      expect(refreshed).toMatchObject({ type: "oauth", methodID: GOOGLE_METHOD_ID, access: "access-token-2", refresh: "refresh-token-1" })
      expect(refreshed.metadata).toEqual({ ...signedIn().metadata, grantedScopes: [url("gmail.readonly"), url("drive.readonly")] })
      expect(Object.fromEntries(mock.requests[0]!)).toEqual({
        grant_type: "refresh_token",
        refresh_token: "refresh-token-1",
        client_id: TEST_CLIENT.clientId,
        client_secret: TEST_CLIENT.clientSecret,
      })
    } finally {
      await mock.close()
    }
  })

  it("keeps the granted scopes when the response omits them, across repeated refreshes", async () => {
    const mock = await tokenServer(() => ({ status: 200, body: { access_token: "next", expires_in: 900 } }))
    try {
      let credential = signedIn()
      for (let round = 0; round < 2; round++) credential = await refreshGoogle({ alias: "default", name: "Google Workspace", credential, options: { tokenEndpoint: mock.url } })
      expect(credential.metadata).toEqual(signedIn().metadata)
    } finally {
      await mock.close()
    }
  })

  it("follows the identity in a refresh's id_token, and keeps the stored one when the refresh has none", async () => {
    const id_token = idToken({ email: "ada@example.com", email_verified: true, hd: "example.com" })
    const withToken = await tokenServer(() => ({ status: 200, body: { access_token: "next", expires_in: 900, id_token } }))
    try {
      const refreshed = await refreshGoogle({ alias: "default", name: "Google Workspace", credential: signedIn(), options: { tokenEndpoint: withToken.url } })
      expect(refreshed.metadata).toEqual({ ...signedIn().metadata, email: "ada@example.com", domain: "example.com" })
    } finally {
      await withToken.close()
    }
    const without = await tokenServer(() => ({ status: 200, body: { access_token: "next", expires_in: 900 } }))
    try {
      const stored = signedIn({ email: "ada@example.com", domain: "example.com" })
      const refreshed = await refreshGoogle({ alias: "default", name: "Google Workspace", credential: stored, options: { tokenEndpoint: without.url } })
      expect(refreshed.metadata).toEqual(stored.metadata)
    } finally {
      await without.close()
    }
  })

  it("asks for a new sign-in when the credential has no stored client", async () => {
    const fetchSpy = vi.fn()
    await expect(refreshGoogle({ alias: "default", name: "Google Workspace", credential: { ...signedIn(), metadata: { clientId: "x" } }, options: { fetch: fetchSpy as never } })).rejects.toThrow(
      /^AUTH_REQUIRED: .* Next step: Run \/connect, choose Google Workspace, and sign in again\.$/,
    )
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe("child environment", () => {
  it("passes the access token only in the child environment, with the plugin-owned account directory", () => {
    const profile = testConfig().accounts.personal!
    const dir = tempDir()
    const withToken = buildChildEnv(profile, dir, tempDir(), "integration-access-token")
    expect(withToken["GOOGLE_WORKSPACE_CLI_TOKEN"]).toBe("integration-access-token")
    expect(withToken["GOOGLE_WORKSPACE_CLI_CONFIG_DIR"]).toBe(dir)
    expect(withToken["GOOGLE_WORKSPACE_CLI_KEYRING_BACKEND"]).toBeUndefined()
  })

  it("keeps gws's token-cache key in the account directory only for credentials files", () => {
    vi.stubEnv("GWS_TEST_CREDENTIALS", "/dev/null")
    try {
      const profile = testConfig({ accounts: { ci: { mode: "credentials_file", enabledServices: ["drive"], credentialsFileEnv: "GWS_TEST_CREDENTIALS" } } }).accounts.ci!
      const env = buildChildEnv(profile, tempDir(), tempDir())
      expect(env["GOOGLE_WORKSPACE_CLI_KEYRING_BACKEND"]).toBe("file")
      expect(env["GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE"]).toBe("/dev/null")
    } finally {
      vi.unstubAllEnvs()
    }
  })
})

describe("scope preflight", () => {
  const call = { sessionId: "ses_1", agentId: "build" }
  const invocations = (runtime: Runtime) => {
    const log = join(accountDir(runtime.paths), "invocations.jsonl")
    return existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : []
  }
  const readOnly = async (services = ["gmail", "drive"]) => {
    const runtime = await testRuntime(
      { accounts: { personal: account({ services }) } },
      { tokenProvider: fakeTokens("ya29.read-only", requestedScopes(services, "read")) },
    )
    runtimes.push(runtime)
    return runtime
  }

  it("fails a write plan on a read-only sign-in with AUTH_SCOPE_MISSING and the next step, before gws runs", async () => {
    const runtime = await readOnly()
    const plan = runtime.plan(request("drive.files.create", { body: { name: "x" } }), call)
    await expect(plan).rejects.toThrow(
      /^AUTH_SCOPE_MISSING: The sign-in for 'personal' has not granted a scope drive\.files\.create needs \(one of: drive, drive\.appdata, drive\.file\)\. Next step: To sign in again, run \/connect and choose Google Workspace, or run opencode auth login gws-personal, and choose Read and write; or add one of them to accounts\.personal\.scopes\.$/,
    )
    await expect(runtime.plan(request("gmail.users.messages.send", { params: { userId: "me" }, body: { raw: "eA" } }), call)).rejects.toThrow(/^AUTH_SCOPE_MISSING:/)
    expect(invocations(runtime)).toEqual([])
  })

  it("lets a read through on the same sign-in", async () => {
    const runtime = await readOnly()
    await runtime.read(request("gmail.users.getProfile", { params: { userId: "me" } }), call)
    expect(invocations(runtime)).toHaveLength(1)
  })

  it("names Read and write for a read whose scope only the write level requests", async () => {
    const runtime = await readOnly(["drive"])
    await expect(runtime.read(request("drive.files.generateIds", { params: { count: 1 } }), call)).rejects.toThrow(
      /^AUTH_SCOPE_MISSING: .*drive\.files\.generateIds needs \(one of: drive, .*\)\. Next step: To sign in again, run \/connect and choose Google Workspace, .*and choose Read and write/,
    )
    expect(invocations(runtime)).toEqual([])
    // drive.apps.readonly is in the read set, so the app list runs on the same Read-only sign-in.
    await expect(runtime.read(request("drive.apps.list", { fields: "items(id)" }), call)).resolves.toMatchObject({ ok: true })
  })

  it("refuses an app-only method with a next step that says no Google sign-in can run it", async () => {
    const services = ["chat"]
    const runtime = await testRuntime(
      { accounts: { personal: account({ services, access: "write" }) } },
      { tokenProvider: fakeTokens("ya29.write", requestedScopes(services, "write")) },
    )
    runtimes.push(runtime)
    await expect(runtime.read(request("chat.spaces.messages.attachments.get", { params: { name: "spaces/s/messages/m/attachments/a" } }), call)).rejects.toThrow(
      /^AUTH_SCOPE_MISSING: chat\.spaces\.messages\.attachments\.get needs a scope Google grants only to an app's own credentials .* Next step: Tell the user this method cannot run with a Google sign-in, and use another method\.$/,
    )
    expect(invocations(runtime)).toEqual([])
  })

  it("refuses a Keep method with a next step that says it needs domain-wide delegation", async () => {
    const services = ["gmail", "keep"]
    const runtime = await testRuntime(
      { accounts: { personal: account({ services, access: "write" }) } },
      { tokenProvider: fakeTokens("ya29.write", requestedScopes(services, "write")) },
    )
    runtimes.push(runtime)
    await expect(runtime.read(request("keep.notes.list", { fields: "notes(name)" }), call)).rejects.toThrow(
      /^AUTH_SCOPE_MISSING: keep\.notes\.list needs keep or keep\.readonly, which Google grants only through domain-wide delegation that a Workspace admin sets up, and the sign-in for 'personal' has not granted it\. Next step: Tell the user this method needs domain-wide delegation; once their admin has set it up, they add keep or keep\.readonly to accounts\.personal\.scopes and sign in again\.$/,
    )
    expect(invocations(runtime)).toEqual([])
  })

  it("fails with AUTH_REQUIRED and the sign-in step, before gws runs, when the account is not signed in", async () => {
    const runtime = await testRuntime({}, { tokenProvider: async () => undefined })
    runtimes.push(runtime)
    await expect(runtime.read(request("gmail.users.getProfile", { params: { userId: "me" } }), call)).rejects.toThrow(
      /^AUTH_REQUIRED: 'personal' is not signed in to Google Workspace\. Next step: To sign in, run \/connect and choose Google Workspace, or run opencode auth login gws-personal\.$/,
    )
    expect(invocations(runtime)).toEqual([])
  })

  it("does not check headless accounts, whose grant is unknown", async () => {
    vi.stubEnv("GWS_TEST_TOKEN", "ya29.headless")
    try {
      const runtime = await testRuntime({ accounts: { personal: { mode: "access_token", enabledServices: ["drive"], tokenEnv: "GWS_TEST_TOKEN" } } }, { tokenProvider: async () => undefined })
      runtimes.push(runtime)
      const planned = await runtime.plan(request("drive.files.create", { body: { name: "x" } }), call)
      expect(planned.planId).toMatch(/^plan_/)
      expect(invocations(runtime)).toHaveLength(1)
    } finally {
      vi.unstubAllEnvs()
    }
  })
})
