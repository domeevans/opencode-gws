import { accessFor, requestedScopes, serviceScopes, shortScope } from "../domain/scopes.js"
import type { AccessLevel, AccountProfile, OAuthClient } from "../domain/types.js"
import { CLIENT_ID_PATTERN, CLIENT_SECRET_PATTERN, OAuthClientSchema } from "../domain/config.js"
import type { ClientChoice } from "./client.js"

/**
 * The sign-in form OpenCode renders before authentication starts, and how
 * its answer is read. Structural twins of the host's form fields keep this
 * module host-agnostic; `src/host/integrations.ts` registers them.
 *
 * Least privilege: anything but an explicit "write" answer signs in
 * read-only, and write needs the acknowledgment as well. A blank, missing,
 * or unexpected answer can never request more than the read scopes.
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

export type SignInForm = [ClientField, ClientField, AccessField, ConfirmField]

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
  const read = { value: "read" as const, label: "Read-only (recommended)", description: `Requests: ${signInScopes(profile, "read").join(" ")}` }
  if (!offersWrite(profile)) return [read]
  return [read, { value: "write", label: "Read and write", description: `Requests: ${signInScopes(profile, "write").join(" ")}` }]
}

/** The account's configured default choice: write when it names write for any service. */
export function defaultAccess(profile: AccountProfile): AccessLevel {
  const access = profile.access
  return access === "write" || (typeof access === "object" && Object.values(access).includes("write")) ? "write" : "read"
}

const WHERE = "From a Desktop app OAuth client: Google Cloud console → Google Auth platform → Clients. A Web client does not work. /gws-status lists the steps."

/** A pattern the host checks before the plugin runs: the value's format, or blank. */
function pattern(value: RegExp): string {
  return `^\\s*$|${value.source}`
}

/**
 * The client ID and secret fields. A client from the plugin options
 * (`oauthClient`, or the account's own, which organisation config can
 * set) is their hidden default: the host submits it without showing the
 * fields. Otherwise they are visible for a one-time paste; left blank, the
 * sign-in reuses the client entered at this account's previous sign-in.
 */
function clientFields(configured: ClientChoice | undefined): [ClientField, ClientField] {
  const option = configured?.client
  const preset = (value: string) => (option ? { default: value, hidden: true } : {})
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

/**
 * The fields: the OAuth client ID and secret, the access choice (each
 * option lists the exact scope URLs it requests), and the write
 * acknowledgment, which the host shows only when write is chosen.
 */
export function signInForm(alias: string, profile: AccountProfile, configured: ClientChoice | undefined): SignInForm {
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
  ]
}

interface SignInAnswer {
  /** The client entered in the form, if any. */
  pasted?: OAuthClient
  access: AccessLevel
}

function text(answer: Record<string, unknown>, key: string): string {
  const value = answer[key]
  if (value === undefined) return ""
  if (typeof value !== "string") throw new Error(`AUTH_CLIENT_INVALID: The ${key} answer is not text. Next step: Enter the client ID and secret of a Desktop app OAuth client.`)
  return value.trim()
}

/** The client ID and secret from the form: both or neither. */
function enteredClient(answer: Record<string, unknown>): OAuthClient | undefined {
  const clientId = text(answer, "clientId")
  const clientSecret = text(answer, "clientSecret")
  if (!clientId && !clientSecret) return undefined
  const client = OAuthClientSchema.safeParse({ clientId, clientSecret })
  if (!client.success) {
    throw new Error("AUTH_CLIENT_INVALID: The OAuth client needs both a client ID (…apps.googleusercontent.com) and its secret. Next step: Enter both from the same Desktop app OAuth client.")
  }
  return client.data
}

/** Read a submitted form. Rejects a half-entered client and an unacknowledged write before any network call. */
export function readAnswer(answer: Record<string, unknown>): SignInAnswer {
  const pasted = enteredClient(answer)
  const access: AccessLevel = answer["access"] === "write" ? "write" : "read"
  if (access === "write" && answer["confirmWrite"] !== true) {
    throw new Error(
      "AUTH_WRITE_UNCONFIRMED: Write access was chosen without the acknowledgment. Next step: Sign in again and confirm the write scopes, or choose Read-only.",
    )
  }
  return pasted ? { pasted, access } : { access }
}
