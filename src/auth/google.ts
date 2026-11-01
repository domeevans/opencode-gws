import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { grantedScopes } from "../domain/scopes.js"
import type { AccessLevel } from "../domain/types.js"
import type { ClientChoice } from "./client.js"
import { readSignIn, signInClient, signInMetadata } from "./credential.js"

/**
 * Google OAuth for the Workspace integration.
 *
 * The browser flow uses a Desktop OAuth client with a loopback redirect and
 * PKCE (S256). The module writes no file: tokens, the client, and the
 * granted scopes go into the OpenCode credential it returns.
 */

export const GOOGLE_AUTHORIZE_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth"
const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token"
export const GOOGLE_METHOD_ID = "google"
const DEFAULT_AUTH_TIMEOUT_MS = 10 * 60 * 1000

/**
 * Structural twin of the host's `Credential.OAuth`. Declared here so this
 * module stays host-agnostic; `src/host/integrations.ts` adapts it.
 */
export interface OAuthCredential {
  type: "oauth"
  methodID: string
  refresh: string
  access: string
  expires: number
  metadata?: Record<string, unknown>
}

export interface GoogleAuthOptions {
  authorizeEndpoint?: string
  tokenEndpoint?: string
  timeoutMs?: number
  fetch?: typeof globalThis.fetch
  now?: () => number
}

interface GoogleAuthorizeInput {
  alias: string
  client: ClientChoice
  access: AccessLevel
  /** Every scope to request, identity scopes included. */
  scopes: readonly string[]
  options?: GoogleAuthOptions
}

export interface GoogleOAuthAuthorization {
  url: string
  instructions: string
  expiresAt: number
  mode: "auto"
  callback: Promise<OAuthCredential>
}

interface GoogleRefreshInput {
  alias: string
  /** The integration's name in /connect. */
  name: string
  credential: OAuthCredential
  options?: GoogleAuthOptions
}

interface Pkce {
  verifier: string
  challenge: string
}

export function createPkce(): Pkce {
  const verifier = randomBytes(32).toString("base64url")
  return {
    verifier,
    challenge: createHash("sha256").update(verifier).digest("base64url"),
  }
}

function createOAuthState(): string {
  return randomBytes(32).toString("base64url")
}

/** Lowercase an account alias into the integration-id alphabet. */
export function sanitizeIntegrationAlias(alias: string): string {
  const slug = alias
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
  return slug || "account"
}

export function integrationIdFor(alias: string): string {
  return `gws-${sanitizeIntegrationAlias(alias)}`
}

/** The name /connect shows: "Google Workspace", plus the alias when several accounts sign in. */
export function integrationNames(accounts: Readonly<Record<string, { readonly mode: string }>>): Map<string, string> {
  const interactive = Object.keys(accounts).filter((alias) => accounts[alias]?.mode === "interactive")
  return new Map(interactive.map((alias) => [alias, interactive.length > 1 ? `Google Workspace (${alias})` : "Google Workspace"]))
}

/**
 * One stable id per configured account. Aliases that sanitize to the same
 * slug get a numeric suffix, so `Work` and `work` remain distinct.
 */
export function integrationIds(accounts: Record<string, unknown>): Map<string, string> {
  const ids = new Map<string, string>()
  const used = new Set<string>()
  for (const alias of Object.keys(accounts)) {
    const base = integrationIdFor(alias)
    let id = base
    let suffix = 2
    while (used.has(id)) {
      id = `${base}-${suffix}`
      suffix += 1
    }
    used.add(id)
    ids.set(alias, id)
  }
  return ids
}

interface BuildAuthorizeUrlInput {
  clientId: string
  redirectUri: string
  scopes: readonly string[]
  state: string
  codeChallenge: string
  authorizeEndpoint?: string
}

export function buildAuthorizeUrl(input: BuildAuthorizeUrlInput): string {
  const url = new URL(input.authorizeEndpoint ?? GOOGLE_AUTHORIZE_ENDPOINT)
  url.searchParams.set("response_type", "code")
  url.searchParams.set("client_id", input.clientId)
  url.searchParams.set("redirect_uri", input.redirectUri)
  url.searchParams.set("scope", input.scopes.join(" "))
  url.searchParams.set("state", input.state)
  url.searchParams.set("code_challenge", input.codeChallenge)
  url.searchParams.set("code_challenge_method", "S256")
  url.searchParams.set("access_type", "offline")
  url.searchParams.set("prompt", "consent")
  return url.toString()
}

/** What OpenCode shows next to the sign-in URL: the account, the access level, and every scope. */
function signInInstructions(alias: string, access: AccessLevel, scopes: readonly string[]): string {
  return [
    `Sign in to Google Workspace (${alias}) with ${access === "write" ? "read and write" : "read-only"} access.`,
    `Google will ask you to approve exactly these scopes: ${scopes.join(", ")}.`,
    "If Google shows redirect_uri_mismatch, the client is not a Desktop app.",
  ].join(" ")
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

interface TokenSet {
  access: string
  refresh?: string
  expiresIn: number
  /** The granted scopes, when the response lists them. */
  scopes?: string[]
}

function tokenError(status: number, json: Record<string, unknown>, secrets: readonly string[]): Error {
  const code = typeof json["error"] === "string" ? json["error"] : ""
  const description = typeof json["error_description"] === "string" ? json["error_description"] : ""
  let message = `Google token endpoint rejected the request (HTTP ${status})`
  if (code) message += `: ${code}`
  if (description && description !== code) message += ` (${description})`
  message = scrubSecrets(message, secrets)
  return new Error(message)
}

function scrubSecrets(text: string, secrets: readonly string[]): string {
  let out = text
  for (const secret of secrets) {
    if (secret) out = out.split(secret).join("[redacted]")
  }
  return out
    .replace(/[A-Za-z0-9_-]{32,}/g, "[redacted]")
    .replace(/[\r\n\t]+/g, " ")
    .slice(0, 300)
}

async function postToken(
  endpoint: string,
  body: URLSearchParams,
  fetchImpl: typeof globalThis.fetch,
  secrets: readonly string[],
): Promise<TokenSet> {
  let response: Response
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: body.toString(),
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    })
  } catch {
    throw new Error("Google token request failed: could not reach the token endpoint.")
  }

  let text = ""
  try {
    text = await response.text()
  } catch {
    /* an error response body is optional */
  }
  let json: Record<string, unknown> = {}
  if (text.trim()) {
    try {
      const parsed: unknown = JSON.parse(text)
      if (isRecord(parsed)) json = parsed
    } catch {
      if (response.ok) throw new Error("Google token endpoint returned an invalid response.")
    }
  }
  if (!response.ok) throw tokenError(response.status, json, secrets)

  const access = typeof json["access_token"] === "string" ? json["access_token"] : ""
  if (!access) throw new Error("Google token endpoint returned no access token.")
  const refresh = typeof json["refresh_token"] === "string" && json["refresh_token"] ? json["refresh_token"] : undefined
  const rawExpires = typeof json["expires_in"] === "number" ? json["expires_in"] : Number(json["expires_in"])
  const expiresIn = Number.isFinite(rawExpires) && rawExpires > 0 ? Math.floor(rawExpires) : 3600
  return { access, refresh, expiresIn, scopes: grantedScopes(json["scope"]) }
}

function stateMatches(actual: string, expected: string): boolean {
  const left = Buffer.from(actual)
  const right = Buffer.from(expected)
  return left.length === right.length && timingSafeEqual(left, right)
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; font: 16px/1.5 system-ui, -apple-system, Segoe UI, sans-serif; background: Canvas; color: CanvasText; }
  main { max-width: 34rem; padding: 2rem; text-align: center; }
  h1 { font-size: 1.35rem; margin: 0 0 0.75rem; }
  p { margin: 0.5rem 0; color: color-mix(in srgb, CanvasText 78%, Canvas); }
</style>
</head>
<body><main><h1>${escapeHtml(title)}</h1>${body}</main></body>
</html>`
}

async function listenOnLoopback(server: Server): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const onError = (): void => {
      server.off("listening", onListening)
      reject(new Error("Google sign-in could not start a local callback server."))
    }
    const onListening = (): void => {
      server.off("error", onError)
      const address = server.address()
      if (!address || typeof address === "string") {
        reject(new Error("Google sign-in could not determine the local callback port."))
        return
      }
      resolve(address.port)
    }
    server.once("error", onError)
    server.once("listening", onListening)
    server.listen(0, "127.0.0.1")
  })
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      server.closeAllConnections?.()
      resolve()
    }, 500)
    timer.unref?.()
    server.close(() => {
      clearTimeout(timer)
      resolve()
    })
  })
}

function respond(response: ServerResponse, status: number, title: string, body: string): void {
  if (response.writableEnded) return
  response.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Connection": "close",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  })
  response.end(page(title, body))
}

export async function authorizeGoogle(input: GoogleAuthorizeInput): Promise<GoogleOAuthAuthorization> {
  const options = input.options ?? {}
  const { client } = input.client
  const scopes = [...input.scopes]
  const pkce = createPkce()
  const state = createOAuthState()
  const timeoutMs = options.timeoutMs ?? DEFAULT_AUTH_TIMEOUT_MS
  const now = options.now ?? Date.now
  const fetchImpl = options.fetch ?? globalThis.fetch
  const tokenEndpoint = options.tokenEndpoint ?? GOOGLE_TOKEN_ENDPOINT
  const authorizeEndpoint = options.authorizeEndpoint ?? GOOGLE_AUTHORIZE_ENDPOINT

  let resolveCallback!: (credential: OAuthCredential) => void
  let rejectCallback!: (error: Error) => void
  const callback = new Promise<OAuthCredential>((resolve, reject) => {
    resolveCallback = resolve
    rejectCallback = reject
  })
  // The host may abandon an attempt without awaiting the callback. Mark the
  // rejection as handled so an abandoned attempt cannot crash the process.
  void callback.catch(() => {})

  let finished = false
  let processing = false
  let timer: NodeJS.Timeout | undefined
  let port = 0

  const finish = async (error?: Error, credential?: OAuthCredential): Promise<void> => {
    if (finished) return
    finished = true
    if (timer) clearTimeout(timer)
    await closeServer(server)
    if (error) rejectCallback(error)
    else if (credential) resolveCallback(credential)
    else rejectCallback(new Error("Google sign-in failed: no credential was produced."))
  }

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    try {
      if (request.method !== "GET") {
        respond(response, 405, "Method not allowed", "<p>Use the sign-in link from OpenCode.</p>")
        return
      }
      const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1")
      if (requestUrl.pathname !== "/" && requestUrl.pathname !== "/callback") {
        respond(response, 404, "Not found", "<p>This is not the OAuth callback.</p>")
        return
      }
      if (finished) {
        respond(response, 409, "Sign-in already finished", "<p>This sign-in attempt has already completed.</p>")
        return
      }
      const stateParam = requestUrl.searchParams.get("state") ?? ""
      const oauthError = requestUrl.searchParams.get("error")
      const code = requestUrl.searchParams.get("code")
      if (!stateParam && !oauthError && !code) {
        respond(response, 400, "Waiting for Google sign-in", "<p>Open the sign-in link from OpenCode.</p>")
        return
      }
      if (!stateMatches(stateParam, state)) {
        respond(response, 400, "Sign-in failed", "<p>The OAuth state did not match. Start the sign-in again.</p>")
        await finish(new Error("Google sign-in failed: OAuth state did not match. Start the sign-in again."))
        return
      }
      if (oauthError) {
        const oauthCode = /^[A-Za-z0-9_.-]{1,80}$/.test(oauthError) ? oauthError : "authorization failed"
        respond(response, 400, "Sign-in failed", `<p>Google returned: ${escapeHtml(oauthCode)}.</p>`)
        await finish(new Error(`Google sign-in failed: ${oauthCode}.`))
        return
      }
      if (!code) {
        respond(response, 400, "Sign-in failed", "<p>The callback did not include an authorization code.</p>")
        await finish(new Error("Google sign-in failed: the callback did not include an authorization code."))
        return
      }
      if (processing) {
        respond(response, 409, "Sign-in already in progress", "<p>This sign-in attempt is already being completed.</p>")
        return
      }
      processing = true
      try {
        const body = new URLSearchParams({
          grant_type: "authorization_code",
          code,
          client_id: client.clientId,
          client_secret: client.clientSecret,
          redirect_uri: `http://127.0.0.1:${port}`,
          code_verifier: pkce.verifier,
        })
        const token = await postToken(tokenEndpoint, body, fetchImpl, [code, pkce.verifier, client.clientSecret])
        if (!token.refresh) {
          throw new Error(
            "Google did not return a refresh token. Remove this app's access at https://myaccount.google.com/permissions and sign in again.",
          )
        }
        const credential: OAuthCredential = {
          type: "oauth",
          methodID: GOOGLE_METHOD_ID,
          refresh: token.refresh,
          access: token.access,
          expires: Math.floor(now() + token.expiresIn * 1000),
          // Google lists the granted scopes, which can be fewer than requested
          // when the user unticks some on the consent screen.
          metadata: signInMetadata({ client: input.client, access: input.access, requestedScopes: scopes, grantedScopes: token.scopes ?? scopes }),
        }
        if (!finished) {
          respond(response, 200, "Google Workspace connected", "<p>Authentication is complete. You can close this window.</p>")
        }
        await finish(undefined, credential)
      } catch (error) {
        if (!finished) {
          respond(
            response,
            500,
            "Sign-in failed",
            "<p>OpenCode could not complete the Google token exchange. Check the terminal for the next step.</p>",
          )
        }
        await finish(error instanceof Error ? error : new Error("Google sign-in failed: the token exchange failed."))
      }
    } catch {
      if (!finished) {
        respond(response, 500, "Sign-in failed", "<p>OpenCode could not process the local OAuth callback.</p>")
      }
      await finish(new Error("Google sign-in failed: the local OAuth callback could not be processed."))
    }
  }

  const server = createServer((request, response) => {
    void handle(request, response)
  })

  try {
    port = await listenOnLoopback(server)
  } catch (error) {
    await closeServer(server)
    throw error
  }

  server.on("error", () => {
    void finish(new Error("Google sign-in failed: the local callback server stopped unexpectedly."))
  })

  timer = setTimeout(() => {
    const minutes = Math.max(1, Math.round(timeoutMs / 60_000))
    void finish(new Error(`Google sign-in timed out after ${minutes} minute${minutes === 1 ? "" : "s"}. Start the sign-in again.`))
  }, timeoutMs)
  timer.unref?.()

  let url: string
  try {
    url = buildAuthorizeUrl({
      clientId: client.clientId,
      redirectUri: `http://127.0.0.1:${port}`,
      scopes,
      state,
      codeChallenge: pkce.challenge,
      authorizeEndpoint,
    })
  } catch (error) {
    await finish(error instanceof Error ? error : new Error("Google sign-in failed: could not build the authorization URL."))
    throw error
  }

  return {
    url,
    instructions: signInInstructions(input.alias, input.access, scopes),
    expiresAt: now() + timeoutMs,
    mode: "auto",
    callback,
  }
}

/**
 * Refresh with the client the sign-in used, from the credential itself, so
 * a later change of the configured client does not break it.
 * Google may report a changed grant; the stored granted scopes follow it.
 */
export async function refreshGoogle(input: GoogleRefreshInput): Promise<OAuthCredential> {
  const signIn = readSignIn(input.credential.metadata)
  if (!input.credential.refresh || !signIn) {
    throw new Error(`AUTH_REQUIRED: The Google Workspace sign-in for ${input.alias} cannot be refreshed. Next step: Run /connect, choose ${input.name}, and sign in again.`)
  }
  const options = input.options ?? {}
  const now = options.now ?? Date.now
  const fetchImpl = options.fetch ?? globalThis.fetch
  const tokenEndpoint = options.tokenEndpoint ?? GOOGLE_TOKEN_ENDPOINT
  const { client } = signInClient(signIn)
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: input.credential.refresh,
    client_id: client.clientId,
    client_secret: client.clientSecret,
  })
  const token = await postToken(tokenEndpoint, body, fetchImpl, [input.credential.refresh, input.credential.access, client.clientSecret])
  return {
    type: "oauth",
    methodID: input.credential.methodID,
    refresh: token.refresh ?? input.credential.refresh,
    access: token.access,
    expires: Math.floor(now() + token.expiresIn * 1000),
    metadata: { ...signIn, grantedScopes: token.scopes ?? signIn.grantedScopes },
  }
}
