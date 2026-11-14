import { type ProbeResult, parseProbeInput, probeResult } from "@we-the-rebel-alliance/source-contract/events"
import type { PluginMethod, ToolCall } from "@we-the-rebel-alliance/source-contract/tools-rpc"
import { calendarAccount } from "../domain/calendar.js"
import { GwsError } from "../domain/errors.js"
import { isDriveLink, imageUrl } from "../domain/images.js"
import type { Runtime } from "../runtime/index.js"
import { calendarToday } from "./calendar.js"
import { CALENDAR_SOURCE } from "./calendar-events.js"
import { GMAIL_SOURCE } from "./gmail-events.js"
import { imagesRead } from "./images.js"
import { type Caller, type PermissionRequest, localRequest, operationRequest } from "./permissions.js"
import type { StatusSource } from "./rpc.js"

/**
 * The source contract's methods that are not tools (`package.json` `sources`, read through the tools RPC
 * `google-workspace.gws.tools`): `probe`, and the two snapshot sources' reads, `calendar_today` (`gws.calendar.today`,
 * an `agenda`) and `images_read` (`gws.image`, an `image`). Each is a read-only method of the tools RPC with its own
 * action, never a model tool: a consumer such as Memory, Artifacts or Jelly calls it in a session its grant fences.
 *
 * - `probe` answers whose a source is, `{ source, account, owner, scopes, trust }`, from the account's verified sign-in
 *   (the email in the id_token Google returned at sign-in, which `gws_status` also reports) and the scopes Google
 *   granted for that source's service. It calls no Google API and reads no content, so it asserts `gws.probe` only.
 *   An account with no verified email (not signed in, or a headless credential) is refused with AUTH_REQUIRED, the
 *   contract's NEEDS_SIGN_IN: there is no `owner: null`.
 * - `calendar_today` is Jelly's `calendar.today` (the same reader: the account's own time zone, 60 seconds of reuse,
 *   a stale answer when Google fails later the same day) as the contract's snapshot: `{ data: <agenda>, asOf, account,
 *   trust }`, where `asOf` is when Google was read. It asserts `gws.calendar_today`, then `gws.read` on
 *   `<account>:calendar.calendars.get` and `<account>:calendar.events.list`, before any read.
 * - `images_read` is Jelly's `images.read` as the contract's snapshot: `{ data: { dataUri, alt }, asOf, account?,
 *   trust }`. It asserts `gws.images_read`, and `gws.read` on `<account>:drive.files.get` before a Drive read. A GIF is
 *   refused (the image output takes PNG, JPEG and WebP), and a picture whose data URI is over the output's limit is
 *   TOO_LARGE, never cut.
 */

/** The probe's permission action, `sources.probe.action`. */
export const PROBE_ACTION = "gws.probe"
/** `gws.calendar.today`'s method and action. */
export const CALENDAR_TODAY = { method: "calendar_today", action: "gws.calendar_today", source: "calendar-today" } as const
/** `gws.image`'s method and action. */
export const IMAGES_READ = { method: "images_read", action: "gws.images_read", source: "image" } as const

/** The source contract's `image` output: a data URI of at most 1 MB less 4 KB, so the whole answer fits 1 MB. */
export const IMAGE_DATA_URI_MAX = 1024 * 1024 - 4 * 1024
/** The source contract's `agenda` output: at most 120 characters of title and location. */
const AGENDA_TEXT_MAX = 120
/** The alt text every picture carries: the contract's image output requires one, and the plugin knows no better. */
const IMAGE_ALT = "A picture from Google Workspace"

/** The sources probe knows, the name each is asked by, and the read that resolves its account. */
const PROBED: Readonly<Record<string, { readonly operation: string; readonly scopes: RegExp }>> = {
  [GMAIL_SOURCE]: { operation: "gmail.users.getProfile", scopes: /^https:\/\/(?:mail\.google\.com\/|www\.googleapis\.com\/auth\/gmail\.)/ },
  [CALENDAR_SOURCE]: { operation: "calendar.events.list", scopes: /^https:\/\/www\.googleapis\.com\/auth\/calendar(?:\.|$)/ },
  [CALENDAR_TODAY.source]: { operation: "calendar.events.list", scopes: /^https:\/\/www\.googleapis\.com\/auth\/calendar(?:\.|$)/ },
  [IMAGES_READ.source]: { operation: "drive.files.get", scopes: /^https:\/\/www\.googleapis\.com\/auth\/drive(?:\.|$)/ },
}

export interface SourceMethodsInput {
  readonly runtime: Runtime
  readonly assert: (request: PermissionRequest) => Promise<void>
  readonly status: StatusSource
}

const host = (call: ToolCall): Caller => ({ sessionID: call.sessionID, agent: call.agent, messageID: call.messageID, id: call.id })
const plain = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)
const text = (max: number) => ({ type: "string", minLength: 1, maxLength: max }) as const

/** A snapshot read's input: its own source name, an account, and its params; anything else is INPUT_INVALID. */
function snapshotInput(input: unknown, source: string, params: readonly string[]): Record<string, unknown> {
  const value = input === undefined || input === null ? {} : input
  if (!plain(value)) throw new GwsError("INPUT_INVALID", "the input must be an object")
  const problems = Object.keys(value)
    .filter((key) => key !== "source" && key !== "account" && !params.includes(key))
    .map((key) => `"${key.slice(0, 40)}" is not an input of this source`)
  if (value["source"] !== undefined && value["source"] !== source) problems.push(`"source" must be "${source}"`)
  const account = value["account"]
  if (account !== undefined && (typeof account !== "string" || account.length === 0 || account.length > 128)) problems.push(`"account" must be a configured account alias`)
  if (problems.length > 0) throw new GwsError("INPUT_INVALID", problems.join("; "))
  return value
}

/** At most `max` characters, ending in an ellipsis when cut, never splitting a character. */
function clip(value: string, max: number): string {
  if (value.length <= max) return value
  let kept = ""
  for (const char of value) {
    if (kept.length + char.length > max - 1) break
    kept += char
  }
  return `${kept}…`
}

export function sourceMethods({ runtime, assert, status }: SourceMethodsInput): PluginMethod[] {
  const authorize = (call: ToolCall, request: PermissionRequest) => runtime.wait(() => assert(request), call.signal)
  const today = calendarToday(runtime)
  const image = imagesRead(runtime)

  const probe: PluginMethod = {
    kind: "plugin",
    name: "probe",
    action: PROBE_ACTION,
    class: "read",
    description:
      "The source contract's probe: whose a source (gmail, calendar, calendar-today or image) is, from the account's verified sign-in, and the scopes Google granted for it. Calls no Google API and reads no content.",
    input: {
      type: "object",
      additionalProperties: false,
      properties: { source: { type: "string", enum: Object.keys(PROBED) }, account: text(128) },
    },
    output: {
      type: "object",
      additionalProperties: false,
      required: ["source", "account", "owner", "trust"],
      properties: {
        source: { type: "string" },
        account: { type: "string" },
        owner: { type: "object", additionalProperties: false, required: ["id", "label"], properties: { id: { type: "string" }, label: { type: "string" } } },
        scopes: { type: "array", items: { type: "string" } },
        trust: { const: "untrusted" },
      },
    },
    async run(input, call): Promise<ProbeResult> {
      const parsed = parseProbeInput(input)
      if (!parsed.ok) throw new GwsError("INPUT_INVALID", parsed.problems.join("; "))
      const name = parsed.value.source ?? GMAIL_SOURCE
      const probed = PROBED[name]
      if (probed === undefined) {
        throw new GwsError("SOURCE_UNKNOWN", `the source '${name}' is not one this plugin declares`, { next: `Probe one of ${Object.keys(PROBED).join(", ")}.` })
      }
      const named = parsed.value.account ?? (name === CALENDAR_TODAY.source ? calendarAccount(runtime.config) : undefined)
      // The account the source would read: its service must be enabled for it, as for the read itself.
      const { account } = runtime.inspect({ ...(named === undefined ? {} : { account: named }), operation: probed.operation }, "read")
      await authorize(call, localRequest(host(call), PROBE_ACTION))
      const signedIn = (await status(call.signal)).accounts.find((entry) => entry.alias === account)
      if (!signedIn?.connected || signedIn.email === undefined) {
        throw new GwsError("AUTH_REQUIRED", `the account '${account}' has no verified sign-in email for the probe to name`, {
          next: "Sign the account in again through /connect, and approve every scope Google lists.",
        })
      }
      const scopes = (signedIn.grantedScopes ?? []).filter((scope) => probed.scopes.test(scope)).slice(0, 64)
      return probeResult({ source: name, account, owner: { id: `mailto:${signedIn.email}`, label: signedIn.email } }, { scopes })
    },
  }

  const calendar: PluginMethod = {
    kind: "plugin",
    name: CALENDAR_TODAY.method,
    action: CALENDAR_TODAY.action,
    class: "read",
    description:
      "The source contract's snapshot gws.calendar.today: today's events on the account's primary calendar, in its own time zone, as an agenda. Untrusted Workspace content.",
    input: { type: "object", additionalProperties: false, properties: { source: { const: CALENDAR_TODAY.source }, account: text(128) } },
    output: {
      type: "object",
      required: ["data", "asOf", "account", "trust"],
      properties: { data: { type: "object" }, asOf: { type: "string" }, account: { type: "string" }, trust: { const: "untrusted" } },
    },
    async run(input, call) {
      const value = snapshotInput(input, CALENDAR_TODAY.source, [])
      const named = (value["account"] as string | undefined) ?? calendarAccount(runtime.config)
      if (named === undefined) {
        throw new GwsError("CALENDAR_UNAVAILABLE", "no configured account enables calendar", {
          next: "Add calendar to an account's enabledServices, or remove accounts so the default account enables it.",
        })
      }
      const targets = ["calendar.calendars.get", "calendar.events.list"].map((operation) => runtime.inspect({ account: named, operation }, "read"))
      await authorize(call, localRequest(host(call), CALENDAR_TODAY.action))
      for (const target of targets) await authorize(call, operationRequest(host(call), "gws.read", target))
      const account = targets[0]!.account
      const answer = await runtime.wait((settled) => today(settled, account), call.signal)
      const items = answer.events.map((event) => ({
        id: event.id,
        title: clip(event.title, AGENDA_TEXT_MAX),
        start: event.start,
        end: event.end,
        ...(event.allDay ? { allDay: true } : {}),
        ...(event.location === undefined ? {} : { location: clip(event.location, AGENDA_TEXT_MAX) }),
        ...(event.url === undefined ? {} : { url: event.url }),
        ...(event.joinUrl === undefined ? {} : { joinUrl: event.joinUrl }),
      }))
      return { data: { items }, asOf: new Date(Date.parse(answer.at)).toISOString(), account, trust: "untrusted" }
    },
  }

  const images: PluginMethod = {
    kind: "plugin",
    name: IMAGES_READ.method,
    action: IMAGES_READ.action,
    class: "read",
    description:
      "The source contract's snapshot gws.image: one picture from a Drive link or an address Google returned to the account, as a PNG, JPEG or WebP data URI. Untrusted Workspace content.",
    input: {
      type: "object",
      additionalProperties: false,
      required: ["url"],
      properties: { source: { const: IMAGES_READ.source }, account: text(128), url: text(2048) },
    },
    output: {
      type: "object",
      required: ["data", "asOf", "trust"],
      properties: { data: { type: "object" }, asOf: { type: "string" }, account: { type: "string" }, trust: { const: "untrusted" } },
    },
    async run(input, call) {
      const value = snapshotInput(input, IMAGES_READ.source, ["url"])
      const named = value["account"] as string | undefined
      const url = imageUrl(value["url"])
      // A Drive file is read through gws as an account: resolve it now, so a refusal comes before any read.
      const drive = isDriveLink(url) && named !== undefined ? runtime.inspect({ account: named, operation: "drive.files.get" }, "read") : undefined
      await authorize(call, localRequest(host(call), IMAGES_READ.action))
      let reader: string | undefined
      const answer = await runtime.wait(
        (settled) =>
          image(url.href, settled, {
            ...(named === undefined ? {} : { account: drive?.account ?? named }),
            authorize: async (account, operation) =>
              authorize(call, operationRequest(host(call), "gws.read", drive ?? runtime.inspect({ account, operation }, "read"))),
            onAccount: (account) => {
              reader = account
            },
          }),
        call.signal,
      )
      if (answer.mime === "image/gif") {
        throw new GwsError("IMAGE_TYPE_REFUSED", "the picture is a GIF, and the image source answers PNG, JPEG or WebP", { next: "Read a PNG, JPEG or WebP picture." })
      }
      const dataUri = `data:${answer.mime};base64,${answer.base64}`
      if (dataUri.length > IMAGE_DATA_URI_MAX) {
        throw new GwsError("TOO_LARGE", `the picture's data URI is ${dataUri.length} characters, over the image output's ${IMAGE_DATA_URI_MAX}`)
      }
      return { data: { dataUri, alt: IMAGE_ALT }, asOf: new Date().toISOString(), ...(reader === undefined ? {} : { account: reader }), trust: "untrusted" }
    },
  }

  return [probe, calendar, images]
}
