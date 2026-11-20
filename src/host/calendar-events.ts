import { createHash } from "node:crypto"
import { decodeBoundCursor, encodeBoundCursor } from "@we-the-rebel-alliance/source-contract/cursor"
import {
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
 * events_list for Calendar, the source `gws.calendar`: the meetings of the
 * account's primary calendar, as the source contract's events. Every call is
 * plain reads through the runtime, so each one passes the plugin's policy
 * and audit like a gws_read; the tool asserts gws.events_list on
 * `calendar.events.list`, then gws.read on it and on the primary calendar's
 * read, before any of them runs.
 *
 * - A listing reads one bounded window: `timeMin`, and `timeMax` at seven
 *   days ahead. Google bounds `timeMin` by an event's end and `timeMax` by
 *   its start, so a recurring series is expanded only into the window, never
 *   years ahead; the source also drops an instance that starts past the
 *   horizon, whatever Google answers.
 * - The next call reads the window that follows the one before it: from the
 *   previous window's end less an hour, to seven days past the new now. An
 *   instance that comes within the horizon without changing at Google is
 *   listed because its start enters that window. Memory drops a repeat, so
 *   the overlap is harmless.
 * - There is no sync token: a token reports changes, not the passing of
 *   time, so an unchanged instance entering the window would be missed.
 * - `showDeleted: true` and `singleEvents: true` are set on every call, so a
 *   cancelled instance inside the window is listed with Google's `cancelled`
 *   status: one meeting with the same external_id (the event id), the
 *   `cancelled` label, and no text or actors.
 * - An event holding a secret is refused for good (`refused[]`, reason
 *   `secret`). A page is one `events.list` answer, so no single event can
 *   fail on its own: the source never answers `failed[]`.
 * - The scope is one calendar: `primary`, or the primary calendar's own id.
 *   The cursor is the contract's version 2, bound to (gws, calendar,
 *   account, scope), and names a digest of the calendar's id, so a cursor
 *   from another account or calendar is refused. A cursor from 0.0.8, which
 *   names a Google sync token and no window end, is read as a fresh first
 *   window: never refused, and nothing older than the first run's 24 hours.
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
/** How far ahead a meeting is listed: only instances starting no later than this are emitted. */
const HORIZON_MS = 7 * 24 * 60 * 60 * 1000
/** How far before the previous window's end the next window starts, so a boundary instance is never lost. */
const OVERLAP_MS = 60 * 60 * 1000
/** The fields of one event: what a meeting needs, and nothing else. */
const EVENT_FIELDS =
  "nextPageToken,items(id,status,summary,description,location,start,end,updated,htmlLink,organizer(email,displayName),attendees(email,displayName,self))"

/**
 * Where a listing stands: the window it reads (`w` its start, `x` its end,
 * both milliseconds; `x` is absent once a window is finished and `w` names
 * the next window's start), the page token to resume at when one was used
 * (`p`), and how many of that page's entries are already read (`n`).
 */
interface CursorState {
  readonly w: number
  readonly x?: number
  readonly p?: string
  readonly n: number
}

/** A window being read: both ends are known. */
interface OpenWindow {
  readonly w: number
  readonly x: number
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
function stateOf(cursor: string, account: string, named: string, calendar: string): CursorState {
  const decoded = decodeBoundCursor(binding(account, named), cursor)
  const state = decoded.ok ? decoded.state : undefined
  const refuse = () => new GwsError("CURSOR_INVALID", `the cursor was not issued by events_list for account '${account}' and this calendar`)
  if (!state || state["a"] !== account || state["o"] !== digest(calendar)) throw refuse()
  const { w, x, n, p } = state
  if (typeof w !== "number" || !Number.isSafeInteger(w) || w < 0) throw refuse()
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0) throw refuse()
  if (x !== undefined && (typeof x !== "number" || !Number.isSafeInteger(x) || x < w)) throw refuse()
  if (p !== undefined && (typeof p !== "string" || p.length === 0 || p.length > 512)) throw refuse()
  return { w, ...(typeof x === "number" ? { x } : {}), ...(typeof p === "string" ? { p } : {}), n }
}

/**
 * The window this call reads. A cursor that names an open window resumes it
 * exactly, page token included. Otherwise a fresh window starts at the
 * cursor's window start (the previous window's end less the overlap), or at
 * the first run's `since`/24 hours when the cursor has none (0.0.8's sync
 * token) or there is no cursor; either way it ends seven days past `now`.
 */
function windowOf(state: CursorState | undefined, request: EventsListRequest, now: number): OpenWindow {
  if (state?.x !== undefined) return { w: state.w, x: state.x, ...(state.p === undefined ? {} : { p: state.p }), n: state.n }
  const from = state === undefined || state.w === 0 ? startTime(request, now) : state.w
  return { w: from, x: now + HORIZON_MS + 1, n: 0 }
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

/** When an instance begins: its start, or for an all-day event its date at UTC midnight. */
function begins(item: Data): number | undefined {
  const start = record(item["start"])
  const at = typeof start["dateTime"] === "string" ? start["dateTime"] : typeof start["date"] === "string" ? `${start["date"]}T00:00:00Z` : undefined
  const time = Date.parse(at ?? "")
  return Number.isFinite(time) ? time : undefined
}

/** When the event happens: its start, or for an all-day event its date at UTC midnight; a cancellation is when it was cancelled. */
function occurred(item: Data): number | undefined {
  const start = record(item["start"])
  const dateTime = typeof start["dateTime"] === "string" ? start["dateTime"] : typeof start["date"] === "string" ? `${start["date"]}T00:00:00Z` : undefined
  const updated = typeof item["updated"] === "string" ? item["updated"] : undefined
  const time = Date.parse((item["status"] === "cancelled" ? (updated ?? dateTime) : (dateTime ?? updated)) ?? "")
  return Number.isFinite(time) ? time : undefined
}

/**
 * One meeting that begins no later than the horizon; a cancelled one keeps
 * its id and title, with the cancelled label and no text or actors. An
 * instance outside the horizon is not emitted, whatever Google answered.
 */
function toEvent(item: Data, account: string, horizon: number): SourceEvent | undefined {
  const id = typeof item["id"] === "string" ? item["id"] : undefined
  const start = begins(item)
  const time = occurred(item)
  if (!id || start === undefined || start > horizon || time === undefined) return undefined
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
 * Lists the meetings of `account`'s primary calendar from the request's
 * cursor, or since its `since`, and no further ahead than seven days.
 * `runtime.read` runs each read under the plugin's read policy; `ctx`
 * cancels them.
 */
export async function calendarEvents(runtime: Pick<Runtime, "read">, account: string, request: EventsListRequest, ctx: CallContext, now = Date.now()): Promise<EventsListResult> {
  const read = async (operation: string, params: Data, fields: string): Promise<Data> => record((await runtime.read({ account, operation, params, fields }, ctx)).data)

  // The primary calendar names the account: a Calendar-only sign-in has no Gmail profile to read.
  const primary = await read("calendar.calendarList.get", { calendarId: "primary" }, "id,summary")
  const calendar = typeof primary["id"] === "string" ? primary["id"].trim() : ""
  if (!calendar) throw new GwsError("GWS_API_ERROR", "the primary calendar answered without an id")
  const owner = { id: `mailto:${calendar}`, label: typeof primary["summary"] === "string" && primary["summary"] !== "" ? primary["summary"] : calendar }
  const named = calendarOf(request, calendar)
  const horizon = now + HORIZON_MS
  let state = windowOf(request.cursor === undefined ? undefined : stateOf(request.cursor, account, named, calendar), request, now)
  // Everything the walk met, in order: an event to carry, or one refused for good.
  const walked: Array<{ event: SourceEvent; after: CursorState; refused?: RefusedEvent }> = []
  let pages = 0
  let next: number | undefined
  const carriable = () => walked.filter((item) => item.refused === undefined).length
  while (carriable() < request.limit && pages < PAGES) {
    throwIfCancelled(ctx.signal)
    const params: Data = {
      calendarId: "primary",
      showDeleted: true,
      singleEvents: true,
      orderBy: "startTime",
      timeMin: new Date(state.w).toISOString(),
      timeMax: new Date(state.x).toISOString(),
      maxResults: Math.min(PAGE_SIZE, request.limit),
      ...(state.p ? { pageToken: state.p } : {}),
    }
    const data = await read("calendar.events.list", params, EVENT_FIELDS)
    pages += 1
    const nextPage = typeof data["nextPageToken"] === "string" && data["nextPageToken"] !== "" ? data["nextPageToken"] : undefined
    const pageToken = state.p
    // Google orders a window by start (orderBy startTime); the sort keeps a resumed page's entry index stable.
    const events = list(data["items"])
      .flatMap((item) => {
        const event = toEvent(item, account, horizon)
        return event === undefined ? [] : [event]
      })
      .map((event, index) => ({ event, index, time: Date.parse(event.occurred_at) }))
      .sort((a, b) => a.time - b.time || a.index - b.index)
    for (let index = state.n; index < events.length; index++) {
      const event = events[index]!.event
      // Where the listing stands after this event: within the page it was read from, never the next page yet.
      const after: CursorState = { w: state.w, x: state.x, ...(pageToken ? { p: pageToken } : {}), n: index + 1 }
      const screened = screenEvents([event])
      walked.push({ event, after, ...(screened.refused[0] === undefined ? {} : { refused: screened.refused[0] }) })
    }
    if (nextPage) {
      state = { w: state.w, x: state.x, p: nextPage, n: 0 }
      continue
    }
    // The window is read through: the next call reads from its end, less the overlap.
    next = Math.max(0, state.x - OVERLAP_MS)
    break
  }

  const listed = walked.filter((item) => item.refused === undefined)
  const kept = fitPage(
    listed.map((item) => item.event),
    request.limit,
    PAGE_MAX_BYTES,
  )
  // A page or item cap left part of the window unread: resume at that place, inside that window.
  const trimmed = kept < listed.length
  const cursor: CursorState = trimmed ? listed[kept - 1]!.after : next === undefined ? state : { w: next, n: 0 }
  const reach = trimmed ? walked.indexOf(listed[kept - 1]!) : walked.length
  const refused = walked.slice(0, reach).flatMap((item) => (item.refused === undefined ? [] : [item.refused]))
  return eventsListResult(
    { source: CALENDAR_SOURCE, account, owner },
    oldestFirst(listed.slice(0, kept).map((item) => item.event)),
    encodeBoundCursor(binding(account, named), { a: account, o: digest(calendar), ...cursor }),
    trimmed || next === undefined,
    {
      scope: { calendars: [named] },
      plugin: PLUGIN_PACKAGE,
      asOf: new Date(now).toISOString(),
      refused,
    },
  )
}
