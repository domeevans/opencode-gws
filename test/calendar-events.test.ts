import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { encodeBoundCursor } from "@we-the-rebel-alliance/source-contract/cursor"
import type { EventsListRequest, SourceEvent } from "@we-the-rebel-alliance/source-contract/events"
import { describe, expect, it } from "vitest"
import { calendarEvents } from "../src/host/calendar-events.js"
import type { CallContext } from "../src/runtime/accounts.js"
import type { Runtime } from "../src/runtime/index.js"

/**
 * `gws.calendar`'s horizon: the source lists only the meeting instances that start no later than seven days ahead, so
 * a recurring series is never expanded far into the future, and an instance enters the listing when time reaches it,
 * with no change at Google. The source is read at its own seam here (`calendarEvents`), with the Google answer stubbed
 * in process: the stub over-answers past `timeMax` on purpose, so the source's own horizon is what the tests hold,
 * and the request's `timeMax` is asserted too. Every read runs under the plugin's policy in the real runtime; the
 * script-level path through the tools RPC is covered by test/sources.test.ts and test/source-conformance.test.ts.
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

const timeOf = (value: Item["start"]): number | undefined => {
  const at = typeof value?.dateTime === "string" ? value.dateTime : typeof value?.date === "string" ? `${value.date}T00:00:00Z` : undefined
  const parsed = Date.parse(at ?? "")
  return Number.isFinite(parsed) ? parsed : undefined
}

/**
 * Google's answer, stubbed: `calendar.calendarList.get`, then `calendar.events.list` filtered only by `timeMin` (the
 * lower bound on an event's end). It never applies `timeMax`, so an item past the horizon is still answered and only
 * the source's own horizon keeps it out. Each call's params are recorded.
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
    const answered = page === 0 ? items.filter((item) => (timeOf(item.end) ?? Number.NEGATIVE_INFINITY) > from) : []
    return { data: answered.length > 0 ? { items: answered } : {} }
  }
  return { runtime: { read } as unknown as Pick<Runtime, "read">, calls }
}

/** A weekly meeting from 2026-11-02 until 2041: the shape that filled Memory with 2,610 future instances. */
function weekly(): Item[] {
  const items: Item[] = []
  const last = Date.parse("2041-12-31T00:00:00Z")
  for (let start = Date.parse("2026-10-19T10:00:00Z"); start <= last; start += 7 * DAY) {
    items.push({
      id: `weekly_${iso(start).slice(0, 10)}`,
      status: "confirmed",
      summary: "Weekly sync",
      start: { dateTime: iso(start) },
      end: { dateTime: iso(start + HOUR) },
      updated: "2026-10-01T00:00:00Z",
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

  it("lists an instance that comes within the horizon on a later run, though nothing changed", async () => {
    const { runtime, calls } = google(weekly())
    const first = await list(runtime, { since: Date.parse("2026-11-01T00:00:00Z") }, NOW)
    expect(ids(first.events)).toEqual(["weekly_2026-11-02"])
    // Two days later the 9 November instance is inside the new horizon; the cursor names the window to read next.
    const second = await list(runtime, { cursor: first.cursor }, NOW + 2 * DAY)
    expect(ids(second.events)).toEqual(["weekly_2026-11-09"])
    expect(calls[1]).toMatchObject({ timeMin: iso(NOW + HORIZON + 1 - HOUR), timeMax: iso(NOW + 2 * DAY + HORIZON + 1) })
    // The instance already listed is not listed again by the later window.
    expect(ids(second.events)).not.toContain("weekly_2026-11-02")
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

  it("reads a v0.0.8 cursor safely: no refusal, and a window no older than the first run", async () => {
    const digest = createHash("sha256").update(CALENDAR).digest("hex").slice(0, 16)
    const binding = { plugin: "gws", source: "calendar", account: ACCOUNT, scope: { calendars: ["primary"] } }
    // 0.0.8's cursor after it adopted Google's sync token: a sync token, no window, and t naming a 2040 instance.
    const syncToken = encodeBoundCursor(binding, { a: ACCOUNT, o: digest, y: "CPDAlphabeticalSyncToken", w: 0, t: Date.parse("2040-12-31T00:00:00Z"), n: 0 })
    const { runtime, calls } = google(weekly())
    const result = await list(runtime, { cursor: syncToken }, NOW)
    expect(calls[0]).toMatchObject({ timeMin: iso(NOW - FIRST_RUN), timeMax: iso(NOW + HORIZON + 1) })
    expect(result.gap).toBeUndefined()
    expect(ids(result.events)).toEqual(["weekly_2026-11-02"])

    // 0.0.8's cursor during its full sync: its window start is kept, and the horizon still bounds the read.
    const fullSync = encodeBoundCursor(binding, { a: ACCOUNT, o: digest, y: "", w: Date.parse("2026-10-25T00:00:00Z"), t: Date.parse("2040-12-31T00:00:00Z"), n: 0 })
    const resumed = await list(runtime, { cursor: fullSync }, NOW)
    expect(calls[1]).toMatchObject({ timeMin: iso(Date.parse("2026-10-25T00:00:00Z")), timeMax: iso(NOW + HORIZON + 1) })
    expect(ids(resumed.events)).toEqual(["weekly_2026-10-26", "weekly_2026-11-02"])
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
