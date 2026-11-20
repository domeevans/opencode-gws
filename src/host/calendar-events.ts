import { createHash } from "node:crypto"
import { CURSOR_V2, type CursorBinding, MAX_CURSOR_LENGTH, bindingHash, decodeBoundCursor, encodeBoundCursor } from "@we-the-rebel-alliance/source-contract/cursor"
import {
  type EventsListRequest,
  type EventsListResult,
  type EventsRemoval,
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
 * - The next call reads from the last call's time less an hour, to seven
 *   days past the new now, so a meeting created, moved or cancelled after
 *   that call is listed, and a run that came late catches up. Memory drops a
 *   repeat, so the overlap is harmless.
 * - There is no sync token: a token reports changes, not the passing of
 *   time, so an unchanged instance entering the window would be missed.
 * - The cursor keeps the instance ids listed inside the window, with their
 *   starts, at most TRACKED_MAX of them and always inside the contract's
 *   cursor length. A later run that no longer sees one whose start is still
 *   inside its window answers a removal (reason `deleted`): a whole deleted
 *   recurring series sends no instance to report it under `showDeleted` and
 *   `singleEvents`. A cancelled instance Google answers without a start is
 *   a removal too, since it cannot be a meeting.
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
 *   names a Google sync token and no window this source can resume, is read
 *   as a fresh first window: never refused, and nothing older than the
 *   first run's 24 hours.
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
/** How far before the last call's time the next window starts, so a boundary instance is never lost. */
const OVERLAP_MS = 60 * 60 * 1000
/** The most instance ids the cursor tracks for removals; the cursor length trims them further. */
const TRACKED_MAX = 20
/** The fields of one event: what a meeting needs, and nothing else. */
const EVENT_FIELDS =
  "nextPageToken,items(id,status,summary,description,location,start,end,updated,htmlLink,organizer(email,displayName),attendees(email,displayName,self))"

/** One instance the cursor tracks: its event id and when it starts, in milliseconds. */
type Tracked = readonly [string, number]

/**
 * Where a listing stands. A finished window names the call that finished it
 * (`r`, so the next window starts an hour before it) and the ids it listed
 * inside that window (`k`). A window being read names its bounds (`w`, `x`),
 * the page to resume at (`p`), how many of that page's entries are already
 * read (`n`), the previous run's tracked ids (`k`), and the ids this window
 * has listed so far (`s`). A 0.0.8 cursor has none of `r`, `x` or `k`.
 */
interface CursorState {
  readonly r?: number
  readonly w?: number
  readonly x?: number
  readonly p?: string
  readonly n: number
  readonly k: readonly Tracked[]
  readonly s: readonly Tracked[]
}

/** A window being read: both ends are known. */
interface OpenWindow {
  readonly w: number
  readonly x: number
  readonly p?: string
  readonly n: number
  readonly k: readonly Tracked[]
  readonly s: readonly Tracked[]
}

type Data = Record<string, unknown>

const record = (value: unknown): Data => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Data) : {})
const list = (value: unknown): Data[] => (Array.isArray(value) ? value.map(record) : [])

/** A digest of the calendar's id, so a cursor from another calendar is refused. */
const digest = (calendar: string) => createHash("sha256").update(calendar).digest("hex").slice(0, 16)

/** The cursor binding: the plugin, the source, the account and the calendar the call named. */
const binding = (account: string, named: string) => ({ plugin: CURSOR_PLUGIN, source: CALENDAR_SOURCE, account, scope: { calendars: [named] } })

/** How many characters the cursor for this binding and state takes: the contract's own encoding, measured. */
const cursorLength = (bind: CursorBinding, state: Record<string, unknown>) =>
  Buffer.from(JSON.stringify({ v: CURSOR_V2, s: bind.source, b: bindingHash(bind), ...state }), "utf8").toString("base64url").length

/** `k`/`s` from a cursor, when every entry is one of this source's; undefined when it is not. */
function trackedOf(value: unknown): Tracked[] | undefined {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > TRACKED_MAX) return undefined
  const entries: Tracked[] = []
  for (const entry of value) {
    if (!Array.isArray(entry) || entry.length !== 2) return undefined
    const [id, start] = entry
    if (typeof id !== "string" || id.length === 0 || id.length > 512) return undefined
    if (typeof start !== "number" || !Number.isSafeInteger(start) || start < 0) return undefined
    entries.push([id, start])
  }
  return entries
}

/** The state a cursor holds, when this source, account and calendar issued it. */
function stateOf(cursor: string, account: string, named: string, calendar: string): CursorState {
  const decoded = decodeBoundCursor(binding(account, named), cursor)
  const state = decoded.ok ? decoded.state : undefined
  const refuse = () => new GwsError("CURSOR_INVALID", `the cursor was not issued by events_list for account '${account}' and this calendar`)
  if (!state || state["a"] !== account || state["o"] !== digest(calendar)) throw refuse()
  const { r, w, x, n, p } = state
  if (n !== undefined && (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0)) throw refuse()
  if (r !== undefined && (typeof r !== "number" || !Number.isSafeInteger(r) || r < 0)) throw refuse()
  if (w !== undefined && (typeof w !== "number" || !Number.isSafeInteger(w) || w < 0)) throw refuse()
  if (x !== undefined) {
    if (typeof w !== "number" || typeof x !== "number" || !Number.isSafeInteger(x) || x <= w) throw refuse()
  }
  if (p !== undefined && (typeof p !== "string" || p.length === 0 || p.length > 512)) throw refuse()
  const k = trackedOf(state["k"])
  const s = trackedOf(state["s"])
  if (k === undefined || s === undefined) throw refuse()
  return {
    ...(typeof r === "number" ? { r } : {}),
    ...(typeof w === "number" ? { w } : {}),
    ...(typeof x === "number" ? { x } : {}),
    ...(typeof p === "string" ? { p } : {}),
    n: typeof n === "number" ? n : 0,
    k,
    s,
  }
}

/**
 * The window this call reads. A cursor that names an open window resumes it
 * exactly, page token included. A cursor from a finished window starts at
 * its call time less the overlap, so a late run catches up. A cursor with
 * neither (0.0.8's) or no cursor starts at the first run's `since`/24 hours.
 * The window's start is kept strictly before its end, so a future `since`
 * reads one empty instant rather than failing at Google.
 */
function windowOf(state: CursorState | undefined, request: EventsListRequest, now: number): OpenWindow {
  const to = now + HORIZON_MS + 1
  if (state?.x !== undefined && state.w !== undefined) {
    return { w: state.w, x: state.x, ...(state.p === undefined ? {} : { p: state.p }), n: state.n, k: state.k, s: state.s }
  }
  const wanted = state?.r === undefined ? startTime(request, now) : Math.min(now, state.r) - OVERLAP_MS
  return { w: Math.max(0, Math.min(wanted, to - 1)), x: to, n: 0, k: state?.k ?? [], s: [] }
}

/**
 * The state a cursor carries, trimmed to the contract's length: the previous
 * run's tracked ids (`k`) go first, then this window's (`s`), so the set
 * that detects a removed series never makes the cursor unusable.
 */
function fitCursor(bind: CursorBinding, state: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = { ...state }
  const k = Array.isArray(next["k"]) ? ([...(next["k"] as Tracked[])] as Tracked[]) : undefined
  const s = Array.isArray(next["s"]) ? ([...(next["s"] as Tracked[])] as Tracked[]) : undefined
  if (k !== undefined) next["k"] = k
  if (s !== undefined) next["s"] = s
  while (cursorLength(bind, next) > MAX_CURSOR_LENGTH) {
    if (k !== undefined && k.length > 0) k.pop()
    else if (s !== undefined && s.length > 0) s.pop()
    else break
    if (k !== undefined && k.length === 0) delete next["k"]
    if (s !== undefined && s.length === 0) delete next["s"]
  }
  return next
}

/** The ids seen this window, as the compact list a cursor carries: nearest first, at most `TRACKED_MAX`. */
function entriesOf(seen: ReadonlyMap<string, number>): Tracked[] {
  return [...seen]
    .map(([id, start]) => [id, start] as Tracked)
    .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
    .slice(0, TRACKED_MAX)
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
 * Lists the meetings of `account`'s primary calendar from the request's
 * cursor, or since its `since`, and no further ahead than seven days. It
 * retracts an instance it listed inside the window that Google no longer
 * answers, and a cancellation Google answers without a start. `runtime.read`
 * runs each read under the plugin's read policy; `ctx` cancels them.
 */
export async function calendarEvents(runtime: Pick<Runtime, "read">, account: string, request: EventsListRequest, ctx: CallContext, now = Date.now()): Promise<EventsListResult> {
  const read = async (operation: string, params: Data, fields: string): Promise<Data> => record((await runtime.read({ account, operation, params, fields }, ctx)).data)

  // The primary calendar names the account: a Calendar-only sign-in has no Gmail profile to read.
  const primary = await read("calendar.calendarList.get", { calendarId: "primary" }, "id,summary")
  const calendar = typeof primary["id"] === "string" ? primary["id"].trim() : ""
  if (!calendar) throw new GwsError("GWS_API_ERROR", "the primary calendar answered without an id")
  const owner = { id: `mailto:${calendar}`, label: typeof primary["summary"] === "string" && primary["summary"] !== "" ? primary["summary"] : calendar }
  const named = calendarOf(request, calendar)
  const bind = binding(account, named)
  const horizon = now + HORIZON_MS
  const at = new Date(now).toISOString()
  let state = windowOf(request.cursor === undefined ? undefined : stateOf(request.cursor, account, named, calendar), request, now)
  // Every instance this window answered (carried while the window spans pages), and the ids Google answered with no start.
  const seen = new Map<string, number>(state.s)
  const tombstones = new Set<string>()
  const removals = new Map<string, EventsRemoval>()
  // Everything the walk met, in order: an event to carry, or one refused for good.
  const walked: Array<{ event: SourceEvent; after: { w: number; x: number; p?: string; n: number }; refused?: RefusedEvent }> = []
  let pages = 0
  let complete = false
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
    const rows: SourceEvent[] = []
    for (const item of list(data["items"])) {
      const id = typeof item["id"] === "string" ? item["id"] : undefined
      if (!id) continue
      const start = begins(item)
      if (start === undefined) {
        // A cancellation Google answers without a start cannot be a meeting; retract its id.
        if (item["status"] === "cancelled") {
          tombstones.add(id)
          removals.set(id, { external_id: id, at, reason: "deleted" })
        }
        continue
      }
      if (start > horizon) continue
      seen.set(id, start)
      const event = toEvent(item, account)
      if (event !== undefined) rows.push(event)
    }
    // Google orders a window by start (orderBy startTime); the sort keeps a resumed page's entry index stable.
    const events = rows.map((event, index) => ({ event, index, time: Date.parse(event.occurred_at) })).sort((a, b) => a.time - b.time || a.index - b.index)
    for (let index = state.n; index < events.length; index++) {
      const event = events[index]!.event
      // Where the listing stands after this event: within the page it was read from, never the next page yet.
      const after = { w: state.w, x: state.x, ...(pageToken ? { p: pageToken } : {}), n: index + 1 }
      const screened = screenEvents([event])
      walked.push({ event, after, ...(screened.refused[0] === undefined ? {} : { refused: screened.refused[0] }) })
    }
    if (nextPage) {
      state = { w: state.w, x: state.x, p: nextPage, n: 0, k: state.k, s: entriesOf(seen) }
      continue
    }
    complete = true
    break
  }

  // The window is read through. Anything this source listed inside it that Google no longer answers is retracted.
  if (complete) {
    for (const [id, start] of state.k) {
      if (start < state.w || start > horizon) continue
      if (seen.has(id) || tombstones.has(id)) continue
      removals.set(id, { external_id: id, at, reason: "deleted" })
    }
  }

  const listed = walked.filter((item) => item.refused === undefined)
  const kept = fitPage(
    listed.map((item) => item.event),
    request.limit,
    PAGE_MAX_BYTES,
  )
  // A page or item cap left part of the window unread: resume at that place, inside that window.
  const trimmed = kept < listed.length
  // A completed window's removals were answered by this page; the page that returns the rest of its events must not repeat them.
  const cursor = trimmed
    ? fitCursor(bind, { a: account, o: digest(calendar), ...listed[kept - 1]!.after, k: complete ? [] : state.k, s: entriesOf(seen) })
    : complete
      ? fitCursor(bind, { a: account, o: digest(calendar), r: now, k: entriesOf(new Map([...seen].filter(([, start]) => start >= state.w && start <= horizon))) })
      : fitCursor(bind, { a: account, o: digest(calendar), w: state.w, x: state.x, ...(state.p === undefined ? {} : { p: state.p }), n: state.n, k: state.k, s: entriesOf(seen) })
  const reach = trimmed ? walked.indexOf(listed[kept - 1]!) : walked.length
  const refused = walked.slice(0, reach).flatMap((item) => (item.refused === undefined ? [] : [item.refused]))
  return eventsListResult(
    { source: CALENDAR_SOURCE, account, owner },
    oldestFirst(listed.slice(0, kept).map((item) => item.event)),
    encodeBoundCursor(bind, cursor),
    trimmed || !complete,
    {
      scope: { calendars: [named] },
      plugin: PLUGIN_PACKAGE,
      asOf: at,
      refused,
      ...(removals.size === 0 ? {} : { removals: [...removals.values()] }),
    },
  )
}
