import { createServer, type Server } from "node:http"
import { afterEach, describe, expect, it } from "vitest"
import { readSignIn, signInClient } from "../src/auth/credential.js"
import type { GoogleOAuthAuthorization } from "../src/auth/google.js"
import { accountSignInStatus } from "../src/auth/status.js"
import { loadConfig } from "../src/domain/config.js"
import { checkClientRedirect, isLoopback, resolveRedirect } from "../src/domain/redirect.js"
import type { AccountProfile, OAuthClient } from "../src/domain/types.js"
import { googleIntegration, type GoogleIntegrationOptions } from "../src/host/integrations.js"
import { TEST_CLIENT } from "./support/config.js"

/**
 * A host-supplied redirect (issue #7): with redirectUri and callbackPort the
 * authorize URL and the token exchange carry the redirect, the listener binds
 * 127.0.0.1:<callbackPort> and accepts only the redirect's path, with the same
 * state and PKCE checks and single use. A Web application client is accepted
 * when it lists the redirect; a Desktop client with a non-loopback redirect is
 * refused before anything listens.
 */

const PUBLIC = "https://host.example/oauth/return"
const WEB_SECRET = "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et"
const web = (redirectUris = [PUBLIC]): OAuthClient => ({ clientId: "123-web.apps.googleusercontent.com", clientSecret: WEB_SECRET, redirectUris })
const webJson = (redirectUris = [PUBLIC]) =>
  JSON.stringify({ web: { client_id: "123-web.apps.googleusercontent.com", client_secret: WEB_SECRET, redirect_uris: redirectUris, project_id: "p" } })

const profile = (): AccountProfile => loadConfig({ accounts: { default: { enabledServices: ["gmail"] } } }).accounts.default!

const closers: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of closers.splice(0)) await close()
})

async function listen(server: Server, port = 0): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    server.once("error", reject)
    server.listen(port, "127.0.0.1", () => {
      const address = server.address()
      if (address && typeof address !== "string") resolve(address.port)
      else reject(new Error("no port"))
    })
  })
}

const close = (server: Server) =>
  new Promise<void>((resolve) => {
    if (!server.listening) return resolve()
    server.close(() => resolve())
    server.closeAllConnections?.()
  })

/** A port that was free a moment ago. */
async function freePort(): Promise<number> {
  const server = createServer()
  const port = await listen(server)
  await close(server)
  return port
}

/** True when the port can be bound now, so nothing is listening on it. */
async function portIsFree(port: number): Promise<boolean> {
  const server = createServer()
  try {
    await listen(server, port)
    return true
  } catch {
    return false
  } finally {
    await close(server)
  }
}

async function tokenServer() {
  const requests: URLSearchParams[] = []
  const server = createServer(async (incoming, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of incoming) chunks.push(Buffer.from(chunk))
    requests.push(new URLSearchParams(Buffer.concat(chunks).toString("utf8")))
    response.writeHead(200, { "Content-Type": "application/json", Connection: "close" })
    response.end(JSON.stringify({ access_token: "access-1", refresh_token: "refresh-1", expires_in: 3600 }))
  })
  const port = await listen(server)
  closers.push(() => close(server))
  return { url: `http://127.0.0.1:${port}/token`, requests }
}

const stateOf = (authorization: GoogleOAuthAuthorization) => new URL(authorization.url).searchParams.get("state") ?? ""

/** What the remote host does: replay Google's redirect to the local listener on the redirect's path. */
async function replay(port: number, path: string, params: Record<string, string>): Promise<Response> {
  const target = new URL(`http://127.0.0.1:${port}${path}`)
  for (const [key, value] of Object.entries(params)) target.searchParams.set(key, value)
  return await fetch(target, { redirect: "manual" })
}

async function abandon(authorization: GoogleOAuthAuthorization, port: number, path: string): Promise<void> {
  const settled = authorization.callback.catch(() => undefined)
  await replay(port, path, { error: "access_denied", state: stateOf(authorization) }).catch(() => undefined)
  await settled
}

function integration(options: GoogleIntegrationOptions = {}, account = profile()) {
  return googleIntegration("default", account, "gws-default", options)
}

describe("a host-supplied redirect", () => {
  it("carries the redirect in the authorize URL and the token request, and completes on the redirect's path", async () => {
    const tokens = await tokenServer()
    const port = await freePort()
    const authorization = await integration({ auth: { tokenEndpoint: tokens.url } }).authorize({
      clientJson: webJson(),
      redirectUri: PUBLIC,
      callbackPort: port,
      access: "read",
    })
    const authorize = new URL(authorization.url)
    expect(authorize.searchParams.get("redirect_uri")).toBe(PUBLIC)
    expect(authorize.searchParams.get("client_id")).toBe("123-web.apps.googleusercontent.com")
    expect(authorization.url).not.toContain(WEB_SECRET)
    expect(authorization.instructions).not.toContain(WEB_SECRET)
    expect(authorization.instructions).toContain(`does not list ${PUBLIC} exactly`)

    expect((await replay(port, "/", { code: "c", state: stateOf(authorization) })).status).toBe(404)
    expect((await replay(port, "/oauth/return", { code: "auth-code", state: stateOf(authorization) })).status).toBe(200)
    const credential = await authorization.callback
    expect(credential).toMatchObject({ access: "access-1", refresh: "refresh-1" })
    expect(tokens.requests).toHaveLength(1)
    expect(tokens.requests[0]!.get("redirect_uri")).toBe(PUBLIC)
    expect(tokens.requests[0]!.get("code")).toBe("auth-code")
    expect(tokens.requests[0]!.get("code_verifier")).toBeTruthy()

    // A re-sign-in can reuse the Web client: its redirect URIs are kept with it.
    const signIn = readSignIn(credential.metadata)!
    expect(signInClient(signIn).client).toEqual(web())
  })

  it("refuses a wrong state", async () => {
    const tokens = await tokenServer()
    const port = await freePort()
    const authorization = await integration({ auth: { tokenEndpoint: tokens.url } }).authorize({ clientJson: webJson(), redirectUri: PUBLIC, callbackPort: port, access: "read" })
    const outcome = authorization.callback.then(() => undefined, (error: Error) => error)
    expect((await replay(port, "/oauth/return", { code: "c", state: "wrong" })).status).toBe(400)
    expect((await outcome)?.message).toMatch(/state did not match/)
    expect(tokens.requests).toHaveLength(0)
  })

  it("refuses a second use of the callback", async () => {
    const tokens = await tokenServer()
    const port = await freePort()
    const authorization = await integration({ auth: { tokenEndpoint: tokens.url } }).authorize({ clientJson: webJson(), redirectUri: PUBLIC, callbackPort: port, access: "read" })
    const params = { code: "auth-code", state: stateOf(authorization) }
    expect((await replay(port, "/oauth/return", params)).status).toBe(200)
    await authorization.callback
    const again = await replay(port, "/oauth/return", params).then((response) => response.status, () => "refused" as const)
    expect(again).not.toBe(200)
    expect(tokens.requests).toHaveLength(1)
  })

  it("takes the redirect from the plugin options, and lets a host's answer override each field", async () => {
    const port = await freePort()
    const other = await freePort()
    const options = { redirect: { redirectUri: PUBLIC, callbackPort: port }, auth: { tokenEndpoint: "http://127.0.0.1:1/token" } }
    const fromOptions = await integration(options).authorize({ clientJson: webJson(), access: "read" })
    expect(new URL(fromOptions.url).searchParams.get("redirect_uri")).toBe(PUBLIC)
    await abandon(fromOptions, port, "/oauth/return")
    const overridden = await integration(options).authorize({ clientJson: webJson(), callbackPort: other, access: "read" })
    expect(new URL(overridden.url).searchParams.get("redirect_uri")).toBe(PUBLIC)
    await abandon(overridden, other, "/oauth/return")
  })

  it("listens on a fixed loopback port with callbackPort alone, for a Desktop client", async () => {
    const port = await freePort()
    const authorization = await integration({ auth: { tokenEndpoint: "http://127.0.0.1:1/token" } }).authorize({ ...TEST_CLIENT, callbackPort: port, access: "read" })
    expect(new URL(authorization.url).searchParams.get("redirect_uri")).toBe(`http://127.0.0.1:${port}`)
    await abandon(authorization, port, "/")
  })
})

describe("refusals before the browser opens", () => {
  it("refuses a Desktop client with a non-loopback redirect, saying a Web client is needed", async () => {
    const port = await freePort()
    const attempt = integration().authorize({ ...TEST_CLIENT, redirectUri: PUBLIC, callbackPort: port, access: "read" })
    await expect(attempt).rejects.toThrow(/^AUTH_REDIRECT_MISMATCH: A Desktop app client accepts only a loopback redirect.*Next step: Use a Web application client/)
    expect(await portIsFree(port)).toBe(true)
  })

  it("refuses a Web client that does not list the redirect, or has no fixed redirect", async () => {
    const port = await freePort()
    await expect(integration().authorize({ clientJson: webJson(["https://other.example/cb"]), redirectUri: PUBLIC, callbackPort: port, access: "read" })).rejects.toThrow(
      /^AUTH_REDIRECT_MISMATCH: The redirect https:\/\/host\.example\/oauth\/return is not one of the Web client's authorised redirect URIs/,
    )
    await expect(integration().authorize({ clientJson: webJson(), access: "read" })).rejects.toThrow(/^AUTH_REDIRECT_MISMATCH: A Web application client needs a fixed redirect/)
    expect(await portIsFree(port)).toBe(true)
  })

  it("refuses a malformed redirect or port, and a redirect without a port", async () => {
    for (const answer of [
      { redirectUri: PUBLIC },
      { redirectUri: "http://host.example/cb", callbackPort: 8080 },
      { redirectUri: "not a url", callbackPort: 8080 },
      { redirectUri: `${PUBLIC}#x`, callbackPort: 8080 },
    ]) {
      await expect(integration().authorize({ clientJson: webJson(), access: "read", ...answer })).rejects.toThrow(/^AUTH_REDIRECT_INVALID: .* Next step: /)
    }
    for (const callbackPort of [0, 70_000, "x", 1.5]) {
      await expect(integration().authorize({ ...TEST_CLIENT, access: "read", callbackPort })).rejects.toThrow(/^AUTH_REDIRECT_INVALID: /)
    }
  })

  it("refuses a client JSON that is not Google's, without repeating it", async () => {
    for (const clientJson of ["{", JSON.stringify({ web: { client_id: "123-web.apps.googleusercontent.com", client_secret: WEB_SECRET } }), JSON.stringify({ other: {} })]) {
      const error = await integration().authorize({ clientJson, access: "read" }).then(() => undefined, (failure: Error) => failure)
      expect(error?.message).toMatch(/^AUTH_CLIENT_INVALID: The OAuth client JSON is not Google's/)
      expect(error?.message).not.toContain(WEB_SECRET)
    }
  })
})

describe("redirect rules", () => {
  it("knows a loopback redirect", () => {
    expect(["http://127.0.0.1:8080/cb", "http://localhost/cb", "http://[::1]:9/"].map(isLoopback)).toEqual([true, true, true])
    expect(["https://127.0.0.1/cb", "https://host.example/cb", "http://host.example/cb"].map(isLoopback)).toEqual([false, false, false])
  })

  it("keeps the default unchanged: loopback on a random port, on / and /callback", () => {
    expect(resolveRedirect({})).toEqual({ uri: "", port: 0, paths: ["/", "/callback"] })
    expect(resolveRedirect({ redirectUri: PUBLIC, callbackPort: 8080 })).toEqual({ uri: PUBLIC, port: 8080, paths: ["/oauth/return"] })
    expect(() => checkClientRedirect(TEST_CLIENT, undefined)).not.toThrow()
    expect(() => checkClientRedirect(TEST_CLIENT, "http://127.0.0.1:8080/cb")).not.toThrow()
    expect(() => checkClientRedirect(web(["http://127.0.0.1:8080/cb"]), "http://127.0.0.1:8080/cb")).not.toThrow()
  })
})

describe("plugin options", () => {
  it("accept redirectUri with callbackPort, and refuse either problem with OPTIONS_INVALID", () => {
    expect(loadConfig({ redirectUri: PUBLIC, callbackPort: 8080 }).redirect).toEqual({ redirectUri: PUBLIC, callbackPort: 8080 })
    expect(loadConfig({}).redirect).toEqual({})
    expect(loadConfig({ callbackPort: 8080 }).redirect).toEqual({ callbackPort: 8080 })
    expect(() => loadConfig({ redirectUri: PUBLIC })).toThrow(/^OPTIONS_INVALID: The redirectUri option is set without callbackPort/)
    expect(() => loadConfig({ redirectUri: "http://host.example/cb", callbackPort: 8080 })).toThrow(/^OPTIONS_INVALID: The redirectUri option must use https/)
    expect(() => loadConfig({ callbackPort: 0 })).toThrow(/^OPTIONS_INVALID:/)
  })

  it("accept Google's client JSON as oauthClient, a Web client with its redirect URIs", () => {
    expect(loadConfig({ oauthClient: JSON.parse(webJson()) }).oauthClient).toEqual(web())
    const installed = { installed: { client_id: TEST_CLIENT.clientId, client_secret: TEST_CLIENT.clientSecret, redirect_uris: ["http://localhost"] } }
    expect(loadConfig({ oauthClient: installed }).oauthClient).toEqual(TEST_CLIENT)
  })

  it("fill the hidden form fields a host can set, and never put a Web client's secret in the form", () => {
    const form = integration({ pluginClient: web(), redirect: { redirectUri: PUBLIC, callbackPort: 8080 } }).method.form
    expect(form.map((field) => field.key)).toEqual(["clientId", "clientSecret", "access", "confirmWrite", "clientJson", "redirectUri", "callbackPort"])
    expect(form[0]).toMatchObject({ hidden: true })
    expect(form[0]).not.toHaveProperty("default")
    expect(form[1]).not.toHaveProperty("default")
    expect(form[4]).toMatchObject({ type: "string", hidden: true, required: false })
    expect(form[5]).toMatchObject({ type: "string", hidden: true, default: PUBLIC })
    expect(form[6]).toMatchObject({ type: "integer", hidden: true, default: 8080, minimum: 1, maximum: 65535 })
    expect(JSON.stringify(form)).not.toContain(WEB_SECRET)
    const plain = integration().method.form
    for (const field of plain.slice(4)) {
      expect(field).toMatchObject({ hidden: true })
      expect(field).not.toHaveProperty("default")
    }
  })

  it("redact the Web client's secret from a token error", async () => {
    const server = createServer(async (incoming, response) => {
      for await (const _ of incoming) void _
      response.writeHead(400, { "Content-Type": "application/json", Connection: "close" })
      response.end(JSON.stringify({ error: "invalid_client", error_description: `bad secret ${WEB_SECRET}` }))
    })
    const tokenPort = await listen(server)
    closers.push(() => close(server))
    const port = await freePort()
    const authorization = await integration({ auth: { tokenEndpoint: `http://127.0.0.1:${tokenPort}/token` } }).authorize({ clientJson: webJson(), redirectUri: PUBLIC, callbackPort: port, access: "read" })
    const outcome = authorization.callback.then(() => undefined, (error: Error) => error)
    expect((await replay(port, "/oauth/return", { code: "auth-code-1", state: stateOf(authorization) })).status).toBe(500)
    const message = (await outcome)?.message ?? ""
    expect(message).toMatch(/invalid_client/)
    expect(message).not.toContain(WEB_SECRET)
  })

  it("keep the Web client's secret out of status", () => {
    const status = accountSignInStatus({
      alias: "default",
      name: "Google Workspace",
      integrationID: "gws-default",
      profile: profile(),
      pluginClient: web(),
      connection: { connected: true, needsAuth: false, signIn: { access: "read", clientSource: "plugin", grantedScopes: [] } },
    })
    expect(JSON.stringify(status)).not.toContain(WEB_SECRET)
  })
})
