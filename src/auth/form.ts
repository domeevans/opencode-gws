import { accessFor, requestedScopes, serviceScopes, shortScope } from "../domain/scopes.js"
import type { AccessLevel, AccountProfile, OAuthClient, RedirectConfig } from "../domain/types.js"
import { CLIENT_ID_PATTERN, CLIENT_SECRET_PATTERN, ClientJsonSchema, DesktopClientSchema } from "../domain/config.js"
import type { ClientChoice } from "./client.js"

/**
 * The sign-in form OpenCode renders before authentication starts, and how
 * its answer is read. Structural twins of the host's form fields keep this
 * module host-agnostic; `src/host/integrations.ts` registers them.
 *
 * Anything but an explicit "write" answer signs in read-only, and write
 * needs the acknowledgment as well. A blank, missing, or unexpected answer
 * can never request more than the read scopes.
 *
 * Three hidden fields are for a host to fill, never shown: Google's client
 * JSON (a Web application client's secret is confidential, so it never
 * appears in the form itself), and the redirect URI and callback port of a
 * host that serves OpenCode to a browser on another machine. The plugin
 * options are their defaults.
 */

interface FieldBase {
  key: string
  title: string
  description?: string
  required?: boolean
  when?: Array<{ key: string; op: "eq"; value: string }>
}

export interface ClientField extends FieldBase {
  type: "string"
  placeholder: string
  /** The host refuses an answer that does not match, before the plugin runs. */
  pattern: string
  /** The configured value; with `hidden`, the host submits it without asking. */
  default?: string
  hidden?: boolean
}

export interface AccessField extends FieldBase {
  type: "string"
  default: AccessLevel
  options: Array<{ value: AccessLevel; label: string; description: string }>
}

export interface ConfirmField extends FieldBase {
  type: "boolean"
  default: boolean
}

/** A field only a host fills: never shown. */
export interface HostTextField extends FieldBase {
  type: "string"
  hidden: true
  pattern?: string
  default?: string
}

export interface HostPortField extends FieldBase {
  type: "integer"
  hidden: true
  minimum: 1
  maximum: 65535
  default?: number
}

export type SignInForm = [ClientField, ClientField, AccessField, ConfirmField, HostTextField, HostTextField, HostPortField]

/** Per-service access for one choice in the form. Write applies the account's per-service map when it names write services. */
function chosenAccess(profile: AccountProfile, choice: AccessLevel): AccountProfile["access"] {
  if (choice === "read") return "read"
  const map = profile.access
  return typeof map === "object" && Object.values(map).includes("write") ? map : "write"
}

/** Every scope a sign-in with this choice requests, identity scopes included. */
export function signInScopes(profile: AccountProfile, choice: AccessLevel): string[] {
  return requestedScopes(profile.enabledServices, chosenAccess(profile, choice), profile.scopes)
}

/** The scopes write adds over read, in short form, for the acknowledgment. */
function writeScopes(profile: AccountProfile): string[] {
  const access = chosenAccess(profile, "write")
  const read = new Set(signInScopes(profile, "read"))
  return [...new Set(profile.enabledServices.flatMap((service) => (accessFor(access, service) === "write" ? serviceScopes(service).write : [])))]
    .filter((scope) => !read.has(scope))
    .map(shortScope)
}

/** Explicit `access: "read"` (or a map with no write) does not offer write. An omitted setting does. */
function offersWrite(profile: AccountProfile): boolean {
  if (profile.accessSpecified !== true) return true
  const access = profile.access
  if (access === "read") return false
  if (access === "write") return true
  return Object.values(access).includes("write")
}

function accessOptions(profile: AccountProfile): AccessField["options"] {
  const read = { value: "read" as const, label: "Read-only", description: `Requests: ${signInScopes(profile, "read").join(" ")}` }
  if (!offersWrite(profile)) return [read]
  return [read, { value: "write", label: "Read and write", description: `Requests: ${signInScopes(profile, "write").join(" ")}` }]
}

/** The account's configured default choice: write when it names write for any service. */
export function defaultAccess(profile: AccountProfile): AccessLevel {
  const access = profile.access
  return access === "write" || (typeof access === "object" && Object.values(access).includes("write")) ? "write" : "read"
}

const WHERE =
  "From a Desktop app OAuth client: Google Cloud console → Google Auth platform → Clients. A Web client works only with a redirect URI the host sets. /gws-status lists the steps."

/** A pattern the host checks before the plugin runs: the value's format, or blank. */
function pattern(value: RegExp): string {
  return `^\\s*$|${value.source}`
}

/**
 * The client ID and secret fields. A Desktop client from the plugin
 * options (`oauthClient`, or the account's own, which organisation config
 * can set) is their hidden default: the host submits it without showing
 * the fields. A configured Web client hides them with no default, so its
 * confidential secret never appears in the form; the sign-in uses the
 * configured client anyway. Otherwise they are visible for a one-time
 * paste; left blank, the sign-in reuses the client entered at this
 * account's previous sign-in.
 */
function clientFields(configured: ClientChoice | undefined): [ClientField, ClientField] {
  const option = configured?.client
  const preset = (value: string) => (!option ? {} : option.redirectUris ? { hidden: true } : { default: value, hidden: true })
  const blank = " Leave both blank to reuse the client from this account's previous sign-in."
  return [
    {
      key: "clientId",
      type: "string",
      title: "OAuth client ID",
      description: `${WHERE}${blank}`,
      required: false,
      placeholder: "…apps.googleusercontent.com",
      pattern: pattern(CLIENT_ID_PATTERN),
      ...preset(option?.clientId ?? ""),
    },
    {
      key: "clientSecret",
      type: "string",
      title: "OAuth client secret",
      description: "The secret of the same Desktop app client. Google treats it as non-confidential for installed apps; it is kept with the sign-in in OpenCode's credential store.",
      required: false,
      placeholder: "GOCSPX-…",
      pattern: pattern(CLIENT_SECRET_PATTERN),
      ...preset(option?.clientSecret ?? ""),
    },
  ]
}

/** The fields a host fills: a client JSON, and the redirect and callback port, defaulting to the plugin options. */
function hostFields(redirect: RedirectConfig): [HostTextField, HostTextField, HostPortField] {
  return [
    {
      key: "clientJson",
      type: "string",
      title: "OAuth client JSON",
      description: 'Google\'s downloaded client JSON, {"installed": …} or {"web": …}. When set, it replaces the client ID and secret. Kept with the sign-in in OpenCode\'s credential store.',
      required: false,
      hidden: true,
    },
    {
      key: "redirectUri",
      type: "string",
      title: "OAuth redirect URI",
      description: "The absolute URL Google redirects to after consent, when the browser is not on this machine. Needs callbackPort. Blank: a loopback redirect.",
      required: false,
      hidden: true,
      pattern: "^\\s*$|^https?://\\S+$",
      ...(redirect.redirectUri !== undefined ? { default: redirect.redirectUri } : {}),
    },
    {
      key: "callbackPort",
      type: "integer",
      title: "OAuth callback port",
      description: "The port on 127.0.0.1 where the redirect reaches the sign-in's listener.",
      required: false,
      hidden: true,
      minimum: 1,
      maximum: 65535,
      ...(redirect.callbackPort !== undefined ? { default: redirect.callbackPort } : {}),
    },
  ]
}

/**
 * The fields: the OAuth client ID and secret, the access choice (each
 * option lists the exact scope URLs it requests), and the write
 * acknowledgment, which the host shows only when write is chosen.
 */
export function signInForm(alias: string, profile: AccountProfile, configured: ClientChoice | undefined, redirect: RedirectConfig = {}): SignInForm {
  const write = writeScopes(profile)
  return [
    ...clientFields(configured),
    {
      key: "access",
      type: "string",
      title: "Access",
      description: `What ${alias} may do in Google Workspace. Read-only cannot change, send, share, or delete anything.`,
      required: true,
      default: defaultAccess(profile),
      options: accessOptions(profile),
    },
    {
      key: "confirmWrite",
      type: "boolean",
      title: `I understand this grants write access to: ${write.join(", ") || "no additional scopes"}`,
      description: "Agents can then plan changes, sends, shares, and deletes. Each one still asks before it runs.",
      required: true,
      default: false,
      when: [{ key: "access", op: "eq", value: "write" }],
    },
    ...hostFields(redirect),
  ]
}

interface SignInAnswer {
  /** The client entered in the form, if any. */
  pasted?: OAuthClient
  access: AccessLevel
  /** The redirect a host filled in, when it did. */
  redirect: RedirectConfig
}

function text(answer: Record<string, unknown>, key: string): string {
  const value = answer[key]
  if (value === undefined) return ""
  if (typeof value !== "string") throw new Error(`AUTH_CLIENT_INVALID: The ${key} answer is not text. Next step: Enter the client ID and secret of a Desktop app OAuth client.`)
  return value.trim()
}

/** Google's client JSON from the form. The message never repeats the JSON, which may hold a confidential secret. */
function clientJson(value: string): OAuthClient {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    parsed = undefined
  }
  const client = ClientJsonSchema.safeParse(parsed)
  if (!client.success) {
    throw new Error(
      'AUTH_CLIENT_INVALID: The OAuth client JSON is not Google\'s downloaded client JSON. Next step: Pass the file Google Cloud console downloads for the client: {"installed": …} for a Desktop app, or {"web": …} with redirect_uris for a Web application.',
    )
  }
  return client.data
}

/** The client from the form: the client JSON, or the client ID and secret, both or neither. */
function enteredClient(answer: Record<string, unknown>): OAuthClient | undefined {
  const json = text(answer, "clientJson")
  if (json) return clientJson(json)
  const clientId = text(answer, "clientId")
  const clientSecret = text(answer, "clientSecret")
  if (!clientId && !clientSecret) return undefined
  const client = DesktopClientSchema.safeParse({ clientId, clientSecret })
  if (!client.success) {
    throw new Error("AUTH_CLIENT_INVALID: The OAuth client needs both a client ID (…apps.googleusercontent.com) and its secret. Next step: Enter both from the same Desktop app OAuth client.")
  }
  return client.data
}

/** The redirect the host filled in: a blank or missing field is unset. */
function enteredRedirect(answer: Record<string, unknown>): RedirectConfig {
  const redirectUri = text(answer, "redirectUri")
  const raw = answer["callbackPort"]
  let callbackPort: number | undefined
  if (typeof raw === "number") callbackPort = raw
  else if (typeof raw === "string" && raw.trim()) callbackPort = /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : Number.NaN
  else if (raw !== undefined && raw !== null && raw !== "") callbackPort = Number.NaN
  if (callbackPort !== undefined && (!Number.isInteger(callbackPort) || callbackPort < 1 || callbackPort > 65_535)) {
    throw new Error(
      "AUTH_REDIRECT_INVALID: The callbackPort answer is not a port from 1 to 65535. Next step: Set callbackPort to the local port the redirect reaches, or leave it blank.",
    )
  }
  return { ...(redirectUri ? { redirectUri } : {}), ...(callbackPort !== undefined ? { callbackPort } : {}) }
}

/** Read a submitted form. Rejects a half-entered client, a bad redirect, and an unacknowledged write before any network call. */
export function readAnswer(answer: Record<string, unknown>): SignInAnswer {
  const pasted = enteredClient(answer)
  const redirect = enteredRedirect(answer)
  const access: AccessLevel = answer["access"] === "write" ? "write" : "read"
  if (access === "write" && answer["confirmWrite"] !== true) {
    throw new Error(
      "AUTH_WRITE_UNCONFIRMED: Write access was chosen without the acknowledgment. Next step: Sign in again and confirm the write scopes, or choose Read-only.",
    )
  }
  return pasted ? { pasted, access, redirect } : { access, redirect }
}
