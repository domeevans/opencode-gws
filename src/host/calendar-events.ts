import { createHash } from "node:crypto"
import { decodeBoundCursor, encodeBoundCursor } from "@we-the-rebel-alliance/source-contract/cursor"
import {
  type EventsGap,
  type EventsListRequest,
  type EventsListResult,
  type RefusedEvent,
  type SourceEvent,
  eventsListResult,
  fitPage,
  makeEvent,
  oldestFirst,
  screenEvents,
  startTime,
} from "@we-the-rebel-alliance/source-contract/events"
import { GwsError, throwIfCancelled } from "../domain/errors.js"
import type { CallContext } from "../runtime/accounts.js"
import type { Runtime } from "../runtime/index.js"
import { CURSOR_PLUGIN, PAGE_MAX_BYTES, PLUGIN_PACKAGE } from "./source-page.js"

/**
 * events_list for Calendar, the source `gws.calendar`: the events of the
 * account's primary calendar since a cursor, as the source contract's
 * events. Every call is plain reads through the runtime, so each one passes
 * the plugin's policy and audit like a gws_read; the tool asserts
 * gws.events_list on `calendar.events.list`, then gws.read on it and on the
 * primary calendar's read, before any of them runs.
 *
 * - The first listing (no cursor) is a full sync from `since`: one
 *   `calendar.events.list` walk with `timeMin`.
 * - After that it follows `syncToken`, which Google answers with the events
 *   that changed since. `nextSyncToken` arrives only on the last page, so a
 *   call that stops early resumes from the page token (and the entry within
 *   that page), not from the sync token.
 * - A sync token Google has expired answers HTTP 410: the source starts a
 *   full sync again from the last event it listed, and the page says so with
 *   `gap: { reason: "expired", since }`.
 * - `showDeleted: true` and `singleEvents: true` are set on every call, so a
 *   cancelled event is listed with Google's `cancelled` status: one meeting
 *   with the same external_id (the event id), the `cancelled` label, and no
 *   text or actors.
 * - An event holding a secret is refused for good (`refused[]`, reason
 *   `secret`). A page is one `events.list` answer, so no single event can
 *   fail on its own: the source never answers `failed[]`.
 * - The scope is one calendar: `primary`, or the primary calendar's own id.
 *   The cursor is the contract's version 2, bound to (gws, calendar,
 *   account, scope), and names a digest of the calendar's id, so a cursor
 *   from another account or calendar is refused.
 */

/** The `source` input that names Calendar. */
export const CALENDAR_SOURCE = "calendar"

/** Every read events_list makes for Calendar. The tool asserts gws.read on `<account>:<operation>` for each before it runs any. */
export const CALENDAR_READS = ["calendar.calendarList.get", "calendar.events.list"] as const

/** The operation `gws.events_list` is asserted on: the one the listing follows. */
export const CALENDAR_FOLLOW = "calendar.events.list"

/** The one scope key this source declares. */
export const CALENDAR_SCOPE_KEYS: readonly string[] = ["calendars"]

/** The events Google returns per page; the call's own `limit` may be smaller. */
const PAGE_SIZE = 100
/** The most Google pages one call reads; the cursor carries on from there. */
const PAGES = 5
/** The fields of one event: what a meeting needs, and nothing else. */
const EVENT_FIELDS =
  "nextPageToken,nextSyncToken,items(id,status,summary,description,location,start,end,updated,htmlLink,organizer(email,displayName),attendees(email,displayName,self))"

/**
 * Where a listing stands: the sync token of the last completed sync (`""`
 * during a full sync), the full sync's window start (`w`), the last event's
 * time (`t`, where a 410 restarts from), the page token to resume at when one
 * was used (`p`), and how many of that page's entries are already read (`n`).
 */
interface Sync {
  readonly y: string
  readonly w: number
  readonly t: number
  readonly p?: string
  readonly n: number
}

type Data = Record<string, unknown>

const record = (value: unknown): Data => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Data) : {})
const list = (value: unknown): Data[] => (Array.isArray(value) ? value.map(record) : [])

/** A digest of the calendar's id, so a cursor from another calendar is refused. */
const digest = (calendar: string) => createHash("sha256").update(calendar).digest("hex").slice(0, 16)

/** The cursor binding: the plugin, the source, the account and the calendar the call named. */
const binding = (account: string, named: string) => ({ plugin: CURSOR_PLUGIN, source: CALENDAR_SOURCE, account, scope: { calendars: [named] } })

/** The state a cursor holds, when this source, account and calendar issued it. */
function stateOf(cursor: string, account: string, named: string, calendar: string): Sync {
  const decoded = decodeBoundCursor(binding(account, named), cursor)
  const state = decoded.ok ? decoded.state : undefined
  const refuse = () => new GwsError("CURSOR_INVALID", `the cursor was not issued by events_list for account '${account}' and this calendar`)
  if (!state || state["a"] !== account || state["o"] !== digest(calendar)) throw refuse()
  const { y, w, t, n, p } = state
  if (typeof y !== "string" || y.length > 512) throw refuse()
  if (typeof t !== "number" || !Number.isSafeInteger(t) || t < 0) throw refuse()
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0) throw refuse()
  if (typeof w !== "number" || !Number.isSafeInteger(w) || w < 0) throw refuse()
  if (p !== undefined && (typeof p !== "string" || p.length === 0 || p.length > 512)) throw refuse()
  return { y, w, t, ...(typeof p === "string" ? { p } : {}), n }
}

/**
 * The calendar a call reads: `primary`, or the account's own primary calendar id. Anything else is refused, so the
 * source can never be pointed at another person's calendar by a call.
 */
function calendarOf(request: EventsListRequest, primary: string): string {
  const named = request.scope?.["calendars"] ?? ["primary"]
  const ids = typeof named === "string" ? [named] : named
  if (ids.length !== 1) {
    throw new GwsError("INPUT_INVALID", "events_list reads one calendar at a time", { next: 'Pass one id under scope.calendars, such as "primary".' })
  }
  const id = ids[0]!
  if (id !== "primary" && id !== primary) {
    throw new GwsError("INPUT_INVALID", "the calendar named is not this account's primary calendar, the only one events_list reads", { next: 'Pass scope { "calendars": ["primary"] }, or omit scope.' })
  }
  return id
}

/** When the event happens: its start, or for an all-day event its date at UTC midnight; a cancellation is when it was cancelled. */
function occurred(item: Data): number | undefined {
  const start = record(item["start"])
  const dateTime = typeof start["dateTime"] === "string" ? start["dateTime"] : typeof start["date"] === "string" ? `${start["date"]}T00:00:00Z` : undefined
  const updated = typeof item["updated"] === "string" ? item["updated"] : undefined
  const time = Date.parse((item["status"] === "cancelled" ? (updated ?? dateTime) : (dateTime ?? updated)) ?? "")
  return Number.isFinite(time) ? time : undefined
}

/** One meeting; a cancelled one keeps its id and title, with the cancelled label and no text or actors. */
function toEvent(item: Data, account: string): SourceEvent | undefined {
  const id = typeof item["id"] === "string" ? item["id"] : undefined
  const time = occurred(item)
  if (!id || time === undefined) return undefined
  const title = typeof item["summary"] === "string" ? item["summary"] : ""
  const url = typeof item["htmlLink"] === "string" ? item["htmlLink"] : null
  const status = typeof item["status"] === "string" ? item["status"] : "confirmed"
  if (status === "cancelled") {
    return makeEvent({ source: CALENDAR_SOURCE, account, external_id: id, kind: "meeting", occurred_at: time, thread: null, actors: [], title, text: "", url, labels: ["cancelled"] })
  }
  const organizer = record(item["organizer"])
  const organizerEmail = typeof organizer["email"] === "string" ? organizer["email"] : undefined
  const actors = [
    ...(organizerEmail ? [{ role: "organizer", id: `mailto:${organizerEmail}`, ...(typeof organizer["displayName"] === "string" ? { name: organizer["displayName"] } : {}) }] : []),
    ...list(item["attendees"]).flatMap((attendee) => {
      const email = typeof attendee["email"] === "string" ? attendee["email"] : undefined
      if (!email) return []
      return [{ role: "attendee", id: `mailto:${email}`, ...(typeof attendee["displayName"] === "string" ? { name: attendee["displayName"] } : {}) }]
    }),
  ]
  const text = [typeof item["description"] === "string" ? item["description"] : "", typeof item["location"] === "string" ? item["location"] : ""].filter((part) => part.length > 0).join("\n\n")
  return makeEvent({ source: CALENDAR_SOURCE, account, external_id: id, kind: "meeting", occurred_at: time, thread: null, actors, title, text, url, labels: [status] })
}

/**
 * Lists the events of `account`'s primary calendar after the request's
 * cursor, or since its `since`. `runtime.read` runs each read under the
 * plugin's read policy; `ctx` cancels them.
 */
export async function calendarEvents(runtime: Pick<Runtime, "read">, account: string, request: EventsListRequest, ctx: CallContext, now = Date.now()): Promise<EventsListResult> {
  const read = async (operation: string, params: Data, fields: string): Promise<Data> => record((await runtime.read({ account, operation, params, fields }, ctx)).data)

  // The primary calendar names the account: a Calendar-only sign-in has no Gmail profile to read.
  const primary = await read("calendar.calendarList.get", { calendarId: "primary" }, "id,summary")
  const calendar = typeof primary["id"] === "string" ? primary["id"].trim() : ""
  if (!calendar) throw new GwsError("GWS_API_ERROR", "the primary calendar answered without an id")
  const owner = { id: `mailto:${calendar}`, label: typeof primary["summary"] === "string" && primary["summary"] !== "" ? primary["summary"] : calendar }
  const named = calendarOf(request, calendar)
  const start = startTime(request, now)
  let state: Sync = request.cursor === undefined ? { y: "", w: start, t: start, n: 0 } : stateOf(request.cursor, account, named, calendar)
  let gap: EventsGap | undefined
  // Everything the walk met, in order: an event to carry, or one refused for good.
  const walked: Array<{ event: SourceEvent; after: Sync; refused?: RefusedEvent }> = []
  let resynced = false
  let pages = 0
  const carriable = () => walked.filter((item) => item.refused === undefined).length
  while (carriable() < request.limit && pages < PAGES) {
    throwIfCancelled(ctx.signal)
    // A full sync reads from its window; a sync token reads what changed, and takes no window.
    const window = state.y === "" ? { timeMin: new Date(state.w).toISOString() } : { syncToken: state.y }
    const params: Data = { calendarId: "primary", showDeleted: true, singleEvents: true, maxResults: Math.min(PAGE_SIZE, request.limit), ...window, ...(state.p ? { pageToken: state.p } : {}) }
    let data: Data
    try {
      data = await read("calendar.events.list", params, EVENT_FIELDS)
    } catch (error) {
      // An expired sync token: start the full sync again from the last event listed. Google never expires a page token.
      if (state.y !== "" && GwsError.from(error)?.status === 410 && !resynced) {
        resynced = true
        gap = { reason: "expired", since: new Date(state.t).toISOString() }
        state = { y: "", w: state.t, t: state.t, n: 0 }
        continue
      }
      throw error
    }
    pages += 1
    const nextPage = typeof data["nextPageToken"] === "string" && data["nextPageToken"] !== "" ? data["nextPageToken"] : undefined
    const nextSync = typeof data["nextSyncToken"] === "string" && data["nextSyncToken"] !== "" ? data["nextSyncToken"] : undefined
    const pageToken = state.p
    // Google does not promise a page's order, and a sync token forbids orderBy: sort the page's events, so the
    // cursor's entry index names a stable place in a stable page.
    const events = list(data["items"])
      .flatMap((item) => {
        const event = toEvent(item, account)
        return event === undefined ? [] : [event]
      })
      .map((event, index) => ({ event, index, time: Date.parse(event.occurred_at) }))
      .sort((a, b) => a.time - b.time || a.index - b.index)
    let time = state.t
    for (let index = state.n; index < events.length; index++) {
      const event = events[index]!.event
      time = Math.max(time, events[index]!.time)
      // Where the listing stands after this event: within the page it was read from, never the new sync token yet.
      const after: Sync = { y: state.y, w: state.w, ...(pageToken ? { p: pageToken } : {}), n: index + 1, t: time }
      const screened = screenEvents([event])
      walked.push({ event, after, ...(screened.refused[0] === undefined ? {} : { refused: screened.refused[0] }) })
    }
    // The whole page is read (an API page is never larger than the call's limit), so a last page's sync token is adopted now.
    state = nextSync ? { y: nextSync, w: 0, t: time, n: 0 } : { y: state.y, w: state.w, ...(nextPage ? { p: nextPage } : {}), n: 0, t: time }
    // The sync token is only on the last page, so that page ends the walk.
    if (nextSync) break
  }

  const listed = walked.filter((item) => item.refused === undefined)
  const kept = fitPage(
    listed.map((item) => item.event),
    request.limit,
    PAGE_MAX_BYTES,
  )
  let more = state.p !== undefined
  // A refusal after the last event this page carries is not final yet: the next page meets it again.
  let reach = walked.length
  if (kept < listed.length) {
    // The page cap trimmed the result: resume after the last event this page carries, inside its page.
    state = listed[kept - 1]!.after
    reach = walked.indexOf(listed[kept - 1]!)
    more = true
  }
  const refused = walked.slice(0, reach).flatMap((item) => (item.refused === undefined ? [] : [item.refused]))
  return eventsListResult(
    { source: CALENDAR_SOURCE, account, owner },
    oldestFirst(listed.slice(0, kept).map((item) => item.event)),
    encodeBoundCursor(binding(account, named), { a: account, o: digest(calendar), ...state }),
    more,
    {
      scope: { calendars: [named] },
      plugin: PLUGIN_PACKAGE,
      asOf: new Date(now).toISOString(),
      refused,
      ...(gap === undefined ? {} : { gap }),
    },
  )
}
