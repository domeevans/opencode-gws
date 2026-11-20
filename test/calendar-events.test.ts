import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { decodeBoundCursor, encodeBoundCursor } from "@we-the-rebel-alliance/source-contract/cursor"
import type { EventsListRequest, SourceEvent } from "@we-the-rebel-alliance/source-contract/events"
import { describe, expect, it } from "vitest"
import { calendarEvents } from "../src/host/calendar-events.js"
import type { CallContext } from "../src/runtime/accounts.js"
import type { Runtime } from "../src/runtime/index.js"

/**
 * `gws.calendar`'s horizon and its removals. The source lists only the meeting instances that start no later than
 * seven days ahead, and re-reads from the last run's time less an hour, so a meeting created, moved or cancelled after
 * the last run arrives; a late run catches up. It also retracts what it listed inside that window when a whole series
 * vanishes, and a cancellation Google answers without a start. The source is read at its own seam (`calendarEvents`),
 * with the Google answer stubbed in process. The stub over-answers past `timeMax` on purpose: the source's own horizon
 * is what the tests hold, and the request's `timeMax` is asserted too.
 */

const ACCOUNT = "personal"
const CALENDAR = "sam.rivera@example.com"
const DAY = 24 * 60 * 60 * 1000
const HOUR = 60 * 60 * 1000
/** The horizon the source promises: seven days from the read's own now. */
const HORIZON = 7 * DAY
/** The contract's first-run window. */
const FIRST_RUN = 24 * HOUR
const NOW = Date.parse("2026-11-01T00:00:00Z")
const iso = (ms: number) => new Date(ms).toISOString()
const ctx: CallContext = { sessionId: "ses_calendar_horizon", agentId: "build", signal: new AbortController().signal }

interface Item {
  readonly id: string
  readonly status?: string
  readonly summary?: string
  readonly start?: { readonly dateTime?: string; readonly date?: string }
  readonly end?: { readonly dateTime?: string; readonly date?: string }
  readonly updated?: string
  readonly htmlLink?: string
}

/** One confirmed meeting, an hour long, from its start. */
function meeting(id: string, start: string, extra: Partial<Item> = {}): Item {
  return { id, status: "confirmed", summary: id, start: { dateTime: start }, end: { dateTime: iso(Date.parse(start) + HOUR) }, updated: "2026-10-31T00:00:00Z", ...extra }
}

const timeOf = (value: Item["start"]): number | undefined => {
  const at = typeof value?.dateTime === "string" ? value.dateTime : typeof value?.date === "string" ? `${value.date}T00:00:00Z` : undefined
  const parsed = Date.parse(at ?? "")
  return Number.isFinite(parsed) ? parsed : undefined
}

/**
 * Google's answer, stubbed: `calendar.calendarList.get`, then `calendar.events.list` filtered only by `timeMin` (the
 * lower bound on an event's end). It never applies `timeMax`, so an item past the horizon is still answered and only
 * the source's own horizon keeps it out. An item with neither a start nor an end is a tombstone and is always answered.
 * The item list is held by reference, so a test changes what Google has between calls. Each call's params are recorded.
 */
function google(items: readonly Item[]) {
  const calls: Array<Record<string, unknown>> = []
  const read = async (request: { operation: string; params?: Record<string, unknown> }) => {
    if (request.operation === "calendar.calendarList.get") return { data: { id: CALENDAR, summary: "Sam Rivera" } }
    const params = request.params ?? {}
    calls.push(params)
    const from = Date.parse(String(params["timeMin"] ?? "invalid"))
    const page = Number(params["pageToken"] ?? 0)
    if (!Number.isInteger(page) || page < 0) throw new Error(`the stub has no page ${String(params["pageToken"])}`)
    // One page holds everything; a pageToken is only ever the empty second page.
    const answered =
      page === 0
        ? items.filter((item) => {
            const start = timeOf(item.start)
            const end = timeOf(item.end)
            if (start === undefined && end === undefined) return true
            return (end ?? Number.NEGATIVE_INFINITY) > from
          })
        : []
    return { data: answered.length > 0 ? { items: answered } : {} }
  }
  return { runtime: { read } as unknown as Pick<Runtime, "read">, calls }
}

/** A weekly meeting from 2026-10-19 until 2041: the shape that filled Memory with 2,610 future instances. */
function weekly(): Item[] {
  const items: Item[] = []
  const last = Date.parse("2041-12-31T00:00:00Z")
  for (let start = Date.parse("2026-10-19T10:00:00Z"); start <= last; start += 7 * DAY) {
    items.push({
      ...meeting(`weekly_${iso(start).slice(0, 10)}`, iso(start)),
      htmlLink: `https://www.google.com/calendar/event?eid=${iso(start).slice(0, 10)}`,
    })
  }
  return items
}

const list = (runtime: Pick<Runtime, "read">, request: Partial<EventsListRequest>, now: number) =>
  calendarEvents(runtime, ACCOUNT, { source: "calendar", ...request, limit: request.limit ?? 500 }, ctx, now)

const ids = (events: readonly SourceEvent[]) => events.map((event) => event.external_id)

describe("the calendar horizon", () => {
  it("never yields an instance a weekly series would place beyond now + 7 days", async () => {
    const items = weekly()
    expect(items.length).toBeGreaterThan(700)
    const { runtime, calls } = google(items)
    const result = await list(runtime, { since: Date.parse("2026-11-01T00:00:00Z") }, NOW)
    // Only the first instance is inside the window: the series continues past 2041 at Google.
    expect(ids(result.events)).toEqual(["weekly_2026-11-02"])
    expect(result.events.every((event) => Date.parse(event.occurred_at) <= NOW + HORIZON)).toBe(true)
    expect(calls[0]).toMatchObject({ showDeleted: true, singleEvents: true, timeMin: iso(Date.parse("2026-11-01T00:00:00Z")), timeMax: iso(NOW + HORIZON + 1) })
  })

  it("re-reads from the last run's time, so an instance entering the horizon arrives and a late run catches up", async () => {
    const { runtime, calls } = google(weekly())
    const first = await list(runtime, { since: Date.parse("2026-11-01T00:00:00Z") }, NOW)
    expect(ids(first.events)).toEqual(["weekly_2026-11-02"])
    // Two days later the 9 November instance is inside the new horizon; the window still covers the 2nd.
    const second = await list(runtime, { cursor: first.cursor }, NOW + 2 * DAY)
    expect(ids(second.events)).toEqual(["weekly_2026-11-02", "weekly_2026-11-09"])
    expect(calls[1]).toMatchObject({ timeMin: iso(NOW - HOUR), timeMax: iso(NOW + 2 * DAY + HORIZON + 1) })
  })

  it("keeps a cancellation inside the window, as a cancelled meeting", async () => {
    const { runtime, calls } = google([
      {
        id: "evt-cancelled",
        status: "cancelled",
        summary: "Cancelled standup",
        start: { dateTime: "2026-11-05T09:00:00Z" },
        end: { dateTime: "2026-11-05T09:30:00Z" },
        updated: "2026-11-01T08:00:00Z",
      },
      {
        id: "evt-cancelled-far",
        status: "cancelled",
        summary: "Cancelled in 2027",
        start: { dateTime: "2027-01-07T09:00:00Z" },
        end: { dateTime: "2027-01-07T09:30:00Z" },
        updated: "2026-11-01T08:00:00Z",
      },
    ])
    const result = await list(runtime, {}, NOW)
    expect(calls[0]).toMatchObject({ showDeleted: true, timeMax: iso(NOW + HORIZON + 1) })
    expect(result.events).toHaveLength(1)
    expect(result.events[0]).toMatchObject({ external_id: "evt-cancelled", occurred_at: "2026-11-01T08:00:00.000Z", kind: "meeting", labels: ["cancelled"], actors: [], text: "" })
  })

  it("reads a v0.0.8 cursor safely: no refusal, and a fresh window no older than the first run", async () => {
    const digest = createHash("sha256").update(CALENDAR).digest("hex").slice(0, 16)
    const binding = { plugin: "gws", source: "calendar", account: ACCOUNT, scope: { calendars: ["primary"] } }
    // 0.0.8's cursor after it adopted Google's sync token: a sync token, no window, and t naming a 2040 instance.
    const syncToken = encodeBoundCursor(binding, { a: ACCOUNT, o: digest, y: "CPDAlphabeticalSyncToken", w: 0, t: Date.parse("2040-12-31T00:00:00Z"), n: 0 })
    const { runtime, calls } = google(weekly())
    const result = await list(runtime, { cursor: syncToken }, NOW)
    expect(calls[0]).toMatchObject({ timeMin: iso(NOW - FIRST_RUN), timeMax: iso(NOW + HORIZON + 1) })
    expect(result.gap).toBeUndefined()
    expect(ids(result.events)).toEqual(["weekly_2026-11-02"])

    // 0.0.8's cursor during its full sync: it names a window this cursor cannot resume, so the read starts fresh too.
    const fullSync = encodeBoundCursor(binding, { a: ACCOUNT, o: digest, y: "", w: Date.parse("2026-10-25T00:00:00Z"), t: Date.parse("2040-12-31T00:00:00Z"), n: 0 })
    const resumed = await list(runtime, { cursor: fullSync }, NOW)
    expect(calls[1]).toMatchObject({ timeMin: iso(NOW - FIRST_RUN), timeMax: iso(NOW + HORIZON + 1) })
    expect(ids(resumed.events)).toEqual(["weekly_2026-11-02"])
  })

  it("emits only kinds the declaration's reads name", async () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      sources: { items: Array<{ id: string; reads: string | string[] }> }
    }
    const declared = pkg.sources.items.find((item) => item.id === "gws.calendar")
    expect(declared?.reads).toBe("meeting")
    const reads = typeof declared?.reads === "string" ? [declared.reads] : (declared?.reads ?? [])
    const { runtime } = google([
      { id: "evt-confirmed", summary: "Plan", start: { dateTime: "2026-11-02T10:00:00Z" }, end: { dateTime: "2026-11-02T11:00:00Z" }, updated: "2026-10-28T09:00:00Z" },
      { id: "evt-cancelled", status: "cancelled", summary: "Lunch", start: { dateTime: "2026-11-03T12:00:00Z" }, end: { dateTime: "2026-11-03T13:00:00Z" }, updated: "2026-11-01T09:00:00Z" },
    ])
    const result = await list(runtime, {}, NOW)
    expect(result.events).toHaveLength(2)
    for (const event of result.events) expect(reads).toContain(event.kind)
  })
})

describe("a change after the last run", () => {
  it("lists a meeting created later for tomorrow", async () => {
    const items: Item[] = []
    const { runtime, calls } = google(items)
    const first = await list(runtime, { since: Date.parse("2026-11-01T00:00:00Z") }, NOW)
    expect(first.events).toEqual([])
    items.push(meeting("evt-created", "2026-11-02T10:00:00Z"))
    const second = await list(runtime, { cursor: first.cursor }, NOW + 2 * HOUR)
    expect(calls[1]).toMatchObject({ timeMin: iso(NOW - HOUR), timeMax: iso(NOW + 2 * HOUR + HORIZON + 1) })
    expect(ids(second.events)).toEqual(["evt-created"])
  })

  it("lists a meeting moved in from 2040", async () => {
    const items: Item[] = [meeting("evt-moved", "2040-12-31T10:00:00Z")]
    const { runtime } = google(items)
    const first = await list(runtime, { since: Date.parse("2026-11-01T00:00:00Z") }, NOW)
    expect(first.events).toEqual([])
    items[0] = meeting("evt-moved", "2026-11-02T10:00:00Z")
    const second = await list(runtime, { cursor: first.cursor }, NOW + HOUR)
    expect(ids(second.events)).toEqual(["evt-moved"])
  })

  it("lists a meeting cancelled after it was listed", async () => {
    const items: Item[] = [meeting("evt-later-cancelled", "2026-11-02T10:00:00Z")]
    const { runtime } = google(items)
    const first = await list(runtime, { since: Date.parse("2026-11-01T00:00:00Z") }, NOW)
    expect(first.events).toEqual([expect.objectContaining({ external_id: "evt-later-cancelled", labels: ["confirmed"] })])
    items[0] = meeting("evt-later-cancelled", "2026-11-02T10:00:00Z", { status: "cancelled", updated: "2026-11-01T12:00:00Z" })
    const second = await list(runtime, { cursor: first.cursor }, NOW + HOUR)
    expect(second.events).toEqual([expect.objectContaining({ external_id: "evt-later-cancelled", occurred_at: "2026-11-01T12:00:00.000Z", labels: ["cancelled"] })])
    expect(second.removals).toBeUndefined()
  })

  it("catches up after a late run, including a meeting created in the gap", async () => {
    const items: Item[] = []
    const { runtime, calls } = google(items)
    const first = await list(runtime, { since: Date.parse("2026-11-01T00:00:00Z") }, NOW)
    items.push(meeting("evt-gap", "2026-11-02T10:00:00Z"))
    const late = await list(runtime, { cursor: first.cursor }, NOW + 3 * DAY)
    expect(calls[1]).toMatchObject({ timeMin: iso(NOW - HOUR), timeMax: iso(NOW + 3 * DAY + HORIZON + 1) })
    expect(ids(late.events)).toEqual(["evt-gap"])
  })
})

describe("removals", () => {
  it("does not retract a whole recurring series that vanishes", async () => {
    const items: Item[] = [
      meeting("series_early", iso(NOW - 30 * 60 * 1000)),
      meeting("series_1", iso(NOW + 2 * HOUR)),
      meeting("series_2", iso(NOW + 2 * DAY)),
      meeting("series_3", iso(NOW + 5 * DAY)),
    ]
    const { runtime } = google(items)
    const first = await list(runtime, { since: NOW - HOUR }, NOW)
    expect(ids(first.events)).toEqual(["series_early", "series_1", "series_2", "series_3"])
    expect(first.removals).toBeUndefined()
    items.length = 0
    // A deleted series sends no instance under showDeleted and singleEvents; the gap is documented, not guessed at.
    const second = await list(runtime, { cursor: first.cursor }, NOW + 2 * HOUR)
    expect(second.events).toEqual([])
    expect(second.removals).toBeUndefined()
  })

  it("does not retract a meeting moved beyond seven days", async () => {
    const items: Item[] = [meeting("evt-moved-out", "2026-11-02T10:00:00Z")]
    const { runtime } = google(items)
    const first = await list(runtime, { since: Date.parse("2026-11-01T00:00:00Z") }, NOW)
    expect(ids(first.events)).toEqual(["evt-moved-out"])
    items[0] = meeting("evt-moved-out", "2040-12-31T10:00:00Z")
    const second = await list(runtime, { cursor: first.cursor }, NOW + HOUR)
    expect(second.events).toEqual([])
    // Absent from the window is not deleted: Memory must keep the meeting, not lose it for up to a week.
    expect(second.removals).toBeUndefined()
  })

  it("retracts a cancelled event Google answers without a start", async () => {
    const { runtime } = google([{ id: "evt-no-start", status: "cancelled", summary: "Gone", updated: "2026-11-01T10:00:00Z" }])
    const result = await list(runtime, {}, NOW)
    expect(result.events).toEqual([])
    expect(result.removals).toEqual([{ external_id: "evt-no-start", at: iso(NOW), reason: "deleted" }])
  })
})

describe("the window", () => {
  it("returns no events and a valid cursor for a window with no meetings", async () => {
    const { runtime, calls } = google([])
    const first = await list(runtime, {}, NOW)
    expect(first.events).toEqual([])
    expect(first.more).toBe(false)
    expect(first.cursor.length).toBeLessThan(200)
    const second = await list(runtime, { cursor: first.cursor }, NOW + HOUR)
    expect(second.events).toEqual([])
    expect(second.more).toBe(false)
    expect(calls).toHaveLength(2)
  })

  it("treats a since in the future as now, not a one-millisecond window", async () => {
    const { runtime, calls } = google([])
    const result = await list(runtime, { since: Date.parse("2027-06-01T00:00:00Z") }, NOW)
    expect(calls[0]).toMatchObject({ timeMin: iso(NOW), timeMax: iso(NOW + HORIZON + 1) })
    expect(result.events).toEqual([])
  })

  it("keeps the cursor small with many meetings in the window", async () => {
    const items = Array.from({ length: 60 }, (_, index) =>
      meeting(`evt_many_${String(index).padStart(2, "0")}_20261120T100000Z`, iso(NOW + (index + 1) * HOUR)),
    )
    const { runtime } = google(items)
    const first = await list(runtime, { since: NOW - HOUR }, NOW)
    expect(first.events).toHaveLength(60)
    expect(first.cursor.length).toBeLessThan(200)
    expect(first.cursor.length).toBeLessThanOrEqual(1024)
    const decoded = decodeBoundCursor({ plugin: "gws", source: "calendar", account: ACCOUNT, scope: { calendars: ["primary"] } }, first.cursor)
    expect(decoded.ok).toBe(true)
    // The cursor is the window state only: no list of ids for a removal guess.
    if (decoded.ok) expect(decoded.state["k"]).toBeUndefined()
    // It still resumes: the next run reads the same window and lists every meeting.
    const second = await list(runtime, { cursor: first.cursor }, NOW + HOUR)
    expect(second.events).toHaveLength(60)
    expect(second.cursor.length).toBeLessThan(200)
  })
})
