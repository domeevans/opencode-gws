import { readFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { CALENDAR_MAX_BYTES, CALENDAR_MAX_EVENTS, EVENT_FIELDS, UNTITLED, calendarAccount, dayKey, httpsLink, todayBounds, todayEvents } from "../src/domain/calendar.js"
import { loadConfig } from "../src/domain/config.js"
import { GwsError } from "../src/domain/errors.js"
import { PACKAGE_NAME } from "../src/domain/version.js"
import { FRESH_MS, READ_DEADLINE_MS, TODAY_INPUT, TODAY_OUTPUT, calendarToday } from "../src/host/calendar.js"
import { registerJellyRpc } from "../src/host/jelly-rpc.js"
import type { Runtime } from "../src/runtime/index.js"
import { account, accountDir, testRuntime } from "./support/config.js"

/**
 * calendar.today, the read Jelly's native calendar makes (hey-jelly docs/architecture/plugin-native-data.md): today
 * in the calendar's own time zone, Google's events cut to Jelly's shape, one account, and a kept answer that comes
 * back stale when a later read fails. Every Google answer here is fake; nothing reaches the network.
 */

const root = new URL("../", import.meta.url)
const pkg = JSON.parse(readFileSync(new URL("package.json", root), "utf8"))
const ms = (value: string) => Date.parse(value)

describe("the account that answers", () => {
  const config = (accounts: Record<string, unknown>) => loadConfig({ accounts })
  it("is the implicit default account, which enables calendar", () => {
    expect(calendarAccount(loadConfig({}))).toBe("default")
  })
  it("is otherwise the first account that enables calendar, interactive before headless", () => {
    const headless = { mode: "access_token", tokenEnv: "TOKEN", enabledServices: ["calendar"] }
    expect(calendarAccount(config({ mail: account({ services: ["gmail"] }), bot: headless, work: account({ services: ["calendar"] }) }))).toBe("work")
    expect(calendarAccount(config({ bot: headless }))).toBe("bot")
    expect(calendarAccount(config({ mail: account({ services: ["gmail"] }) }))).toBeUndefined()
  })
})

describe("today's bounds, in the calendar's own time zone", () => {
  it("is midnight to midnight there, not on this machine", () => {
    const now = ms("2026-11-12T20:00:00Z")
    expect(todayBounds(now, "Asia/Kolkata")).toEqual({ start: ms("2026-11-12T18:30:00Z"), end: ms("2026-11-13T18:30:00Z") })
    expect(todayBounds(now, "Pacific/Kiritimati")).toEqual({ start: ms("2026-11-12T10:00:00Z"), end: ms("2026-11-13T10:00:00Z") })
    expect(todayBounds(now, "America/Los_Angeles")).toEqual({ start: ms("2026-11-12T08:00:00Z"), end: ms("2026-11-13T08:00:00Z") })
    expect(dayKey(now, "Pacific/Kiritimati")).toBe("2026-11-13")
  })
  it("is 25 hours on the day clocks go back and 23 on the day they go forward", () => {
    expect(todayBounds(ms("2026-11-01T12:00:00Z"), "America/New_York")).toEqual({ start: ms("2026-11-01T04:00:00Z"), end: ms("2026-11-02T05:00:00Z") })
    expect(todayBounds(ms("2026-03-08T12:00:00Z"), "America/New_York")).toEqual({ start: ms("2026-03-08T05:00:00Z"), end: ms("2026-03-09T04:00:00Z") })
  })
  it("starts at the first instant of the day where a clock change skips midnight", () => {
    // Santiago goes from 23:59:59 on 5 September to 01:00 on 6 September 2026.
    expect(todayBounds(ms("2026-09-06T15:00:00Z"), "America/Santiago")).toEqual({ start: ms("2026-09-06T04:00:00Z"), end: ms("2026-09-07T03:00:00Z") })
  })
})

const NOW = ms("2026-11-12T15:00:00Z")
const ZONE = "Europe/London"
const timed = (id: string, start: string, end: string, extra: Record<string, unknown> = {}) => ({ id, summary: id, start: { dateTime: start }, end: { dateTime: end }, ...extra })

describe("Google's events as Jelly reads them", () => {
  it("keeps today's entries not yet ended, in UTC, earliest first, with only the fields Jelly reads", () => {
    const events = todayEvents(
      [
        timed("later", "2026-11-12T17:00:00+01:00", "2026-11-12T18:00:00+01:00", {
          location: "  Room\n4 ",
          htmlLink: "https://www.google.com/calendar/event?eid=x",
          hangoutLink: "https://meet.google.com/abc-defg-hij",
          description: "never sent",
          attendees: [{ email: "a@example.com", self: true, responseStatus: "accepted" }],
        }),
        timed("now", "2026-11-12T14:30:00Z", "2026-11-12T15:30:00Z", {
          conferenceData: { entryPoints: [{ entryPointType: "phone", uri: "tel:+1-555" }, { entryPointType: "video", uri: "https://zoom.example/j/1" }] },
        }),
        timed("ended", "2026-11-12T09:00:00Z", "2026-11-12T10:00:00Z"),
        timed("tomorrow", "2026-11-13T09:00:00Z", "2026-11-13T10:00:00Z"),
        timed("yesterday-overnight", "2026-11-11T23:00:00Z", "2026-11-12T16:00:00Z"),
      ],
      ZONE,
      NOW,
    )
    expect(events).toEqual([
      { id: "yesterday-overnight", title: "yesterday-overnight", start: "2026-11-11T23:00:00Z", end: "2026-11-12T16:00:00Z" },
      { id: "now", title: "now", start: "2026-11-12T14:30:00Z", end: "2026-11-12T15:30:00Z", joinUrl: "https://zoom.example/j/1" },
      {
        id: "later",
        title: "later",
        start: "2026-11-12T16:00:00Z",
        end: "2026-11-12T17:00:00Z",
        location: "Room 4",
        url: "https://www.google.com/calendar/event?eid=x",
        joinUrl: "https://meet.google.com/abc-defg-hij",
      },
    ])
  })

  it("marks an all-day entry, from the calendar's midnight to the next", () => {
    const events = todayEvents([{ id: "holiday", summary: "Holiday", start: { date: "2026-11-12" }, end: { date: "2026-11-13" } }], "Asia/Tokyo", ms("2026-11-12T03:00:00Z"))
    expect(events).toEqual([{ id: "holiday", title: "Holiday", start: "2026-11-11T15:00:00Z", end: "2026-11-12T15:00:00Z", allDay: true }])
  })

  it("leaves out cancelled, declined and working-location entries, and items it cannot read", () => {
    const today = (id: string, extra: Record<string, unknown> = {}) => timed(id, "2026-11-12T16:00:00Z", "2026-11-12T17:00:00Z", extra)
    const events = todayEvents(
      [
        today("cancelled", { status: "cancelled" }),
        today("declined", { attendees: [{ self: true, responseStatus: "declined" }] }),
        today("office", { eventType: "workingLocation" }),
        { ...today("no-id"), id: undefined },
        { ...today("no-end"), end: undefined },
        today("backwards", { end: { dateTime: "2026-11-12T15:30:00Z" } }),
        today("local-time", { start: { dateTime: "2026-11-12T16:00:00" } }),
        today("bad-date", { start: { date: "2026-02-30" }, end: { date: "2026-03-01" } }),
        today("mixed", { start: { date: "2026-11-12" } }),
        "not an event",
        null,
        today("kept"),
      ],
      ZONE,
      NOW,
    )
    expect(events.map((event) => event.id)).toEqual(["kept"])
    expect(todayEvents(undefined, ZONE, NOW)).toEqual([])
  })

  it("names an untitled entry as Google does and cuts long text without splitting a character", () => {
    const [untitled, long] = todayEvents(
      [
        timed("untitled", "2026-11-12T16:00:00Z", "2026-11-12T17:00:00Z", { summary: "   " }),
        timed("long", "2026-11-12T16:30:00Z", "2026-11-12T17:00:00Z", { summary: "😀".repeat(150), location: "x".repeat(500) }),
      ],
      ZONE,
      NOW,
    )
    expect(untitled?.title).toBe(UNTITLED)
    expect(long?.title.length).toBeLessThanOrEqual(200)
    expect(long?.title.endsWith("😀…")).toBe(true)
    expect(long?.location).toHaveLength(200)
  })

  it("gives an id longer than Jelly reads as a stable digest", () => {
    const id = "a".repeat(300)
    const [first] = todayEvents([timed(id, "2026-11-12T16:00:00Z", "2026-11-12T17:00:00Z")], ZONE, NOW)
    const [again] = todayEvents([timed(id, "2026-11-12T16:00:00Z", "2026-11-12T17:00:00Z")], ZONE, NOW)
    expect(first?.id).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(again?.id).toBe(first?.id)
  })

  it("keeps only https links without credentials", () => {
    expect(httpsLink("https://meet.google.com/x")).toBe("https://meet.google.com/x")
    for (const bad of ["http://meet.google.com/x", "javascript:alert(1)", "https://user:pw@example.com/", "not a url", `https://e.com/${"x".repeat(2100)}`, 42])
      expect(httpsLink(bad), String(bad)).toBeUndefined()
    const [event] = todayEvents(
      [timed("links", "2026-11-12T16:00:00Z", "2026-11-12T17:00:00Z", { htmlLink: "http://insecure.example/", hangoutLink: "javascript:alert(1)", conferenceData: { entryPoints: [{ entryPointType: "video", uri: "https://a:b@zoom.example/" }] } })],
      ZONE,
      NOW,
    )
    expect(event).toEqual({ id: "links", title: "links", start: "2026-11-12T16:00:00Z", end: "2026-11-12T17:00:00Z" })
  })

  it("returns at most 50, the earliest", () => {
    const items = Array.from({ length: 80 }, (_, index) => {
      const start = NOW + (80 - index) * 60_000
      return timed(`e${80 - index}`, new Date(start).toISOString(), new Date(start + 30 * 60_000).toISOString())
    })
    const events = todayEvents(items, ZONE, NOW)
    expect(events).toHaveLength(CALENDAR_MAX_EVENTS)
    expect(events[0]?.id).toBe("e1")
    expect(events.at(-1)?.id).toBe("e50")
  })
})

/** An answer that never comes, whatever the signal says. */
const NEVER = Symbol("never")

/** A fake read path: answers by operation id, or throws what it is given. */
function fakeReader(accounts: Record<string, unknown> = { work: account({ services: ["calendar"] }) }) {
  const answers: Record<string, unknown> = {}
  const calls: { account?: string; operation: string; params?: Record<string, unknown> }[] = []
  const audited: Record<string, unknown>[] = []
  const reader = {
    audit: { emit: (event: Record<string, unknown>) => audited.push(event) },
    wait: <T>(start: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal) => start(signal ?? new AbortController().signal),
    config: loadConfig({ accounts }),
    read: async (request: { account?: string; operation: string; params?: Record<string, unknown> }) => {
      calls.push(request)
      const answer = answers[request.operation]
      if (answer instanceof Error) throw answer
      if (answer === NEVER) return new Promise(() => {})
      return { ok: true, operation: request.operation, category: "read", data: answer, truncated: false, trust: { workspaceContent: "untrusted" } }
    },
  } as unknown as Pick<Runtime, "config" | "read">
  return { reader, answers, calls, audited }
}

describe("calendar.today's answer", () => {
  it("reads the primary calendar's time zone, then today's events in its bounds", async () => {
    const { reader, answers, calls } = fakeReader()
    answers["calendar.calendars.get"] = { timeZone: "Asia/Kolkata" }
    answers["calendar.events.list"] = { items: [timed("standup", "2026-11-12T20:30:00+05:30", "2026-11-12T21:00:00+05:30")] }
    const today = calendarToday(reader, () => NOW)
    expect(await today()).toEqual({
      account: "work",
      at: "2026-11-12T15:00:00Z",
      state: "ready",
      events: [{ id: "standup", title: "standup", start: "2026-11-12T15:00:00Z", end: "2026-11-12T15:30:00Z" }],
    })
    expect(calls).toEqual([
      { account: "work", operation: "calendar.calendars.get", params: { calendarId: "primary", fields: "timeZone" } },
      expect.objectContaining({
        account: "work",
        operation: "calendar.events.list",
        params: expect.objectContaining({ calendarId: "primary", timeMin: "2026-11-11T18:30:00Z", timeMax: "2026-11-12T18:30:00Z", singleEvents: true, orderBy: "startTime" }),
      }),
    ])
  })

  it("answers from the kept reading for a minute, then reads again", async () => {
    let now = NOW
    const { reader, answers, calls } = fakeReader()
    answers["calendar.calendars.get"] = { timeZone: ZONE }
    answers["calendar.events.list"] = { items: [] }
    const today = calendarToday(reader, () => now)
    await today()
    now += FRESH_MS - 1
    expect((await today()).at).toBe("2026-11-12T15:00:00Z")
    expect(calls).toHaveLength(2)
    now += 1
    expect((await today()).at).toBe("2026-11-12T15:01:00Z")
    expect(calls).toHaveLength(4)
  })

  it("answers stale with the kept events when a later read fails, and drops events that ended meanwhile", async () => {
    let now = NOW
    const { reader, answers } = fakeReader()
    answers["calendar.calendars.get"] = { timeZone: ZONE }
    answers["calendar.events.list"] = { items: [timed("soon", "2026-11-12T15:10:00Z", "2026-11-12T15:20:00Z"), timed("later", "2026-11-12T17:00:00Z", "2026-11-12T18:00:00Z")] }
    const today = calendarToday(reader, () => now)
    await today()
    now += 30 * 60_000
    answers["calendar.events.list"] = new GwsError("TIMEOUT", "gws did not finish")
    expect(await today()).toEqual({
      account: "work",
      at: "2026-11-12T15:00:00Z",
      state: "stale",
      events: [{ id: "later", title: "later", start: "2026-11-12T17:00:00Z", end: "2026-11-12T18:00:00Z" }],
    })
  })

  it("fails with the read's code when nothing of today is kept", async () => {
    let now = NOW
    const { reader, answers } = fakeReader()
    answers["calendar.calendars.get"] = new GwsError("GWS_API_ERROR", "Google answered 503")
    const today = calendarToday(reader, () => now)
    await expect(today()).rejects.toThrow(/^GWS_API_ERROR: /)
    // A reading from yesterday is not today's, so it is not shown as stale either.
    answers["calendar.calendars.get"] = { timeZone: ZONE }
    answers["calendar.events.list"] = { items: [] }
    await today()
    now += 24 * 3_600_000
    answers["calendar.events.list"] = new GwsError("TIMEOUT", "gws did not finish")
    await expect(today()).rejects.toThrow(/^TIMEOUT: /)
  })

  it.each(["AUTH_REQUIRED", "AUTH_SCOPE_MISSING"])("fails with %s when the account must sign in, and forgets what it kept", async (code) => {
    let now = NOW
    const { reader, answers } = fakeReader()
    answers["calendar.calendars.get"] = { timeZone: ZONE }
    answers["calendar.events.list"] = { items: [timed("later", "2026-11-12T17:00:00Z", "2026-11-12T18:00:00Z")] }
    const today = calendarToday(reader, () => now)
    await today()
    now += FRESH_MS
    answers["calendar.calendars.get"] = new Error(`${code}: The sign-in for 'work' cannot read it. Next step: Sign in.`)
    await expect(today()).rejects.toThrow(new RegExp(`^${code}: `))
    // A later failure of another kind would answer stale from a kept reading; there is none left.
    answers["calendar.calendars.get"] = new GwsError("TIMEOUT", "gws did not finish")
    await expect(today()).rejects.toThrow(/^TIMEOUT: /)
  })

  describe("several accounts", () => {
    /** A read path whose answers depend on the account, and whose events.list waits until the test releases that account. */
    function perAccount() {
      const gates = new Map<string, () => void>()
      const calls: string[] = []
      const reader = {
        wait: <T>(start: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal) => start(signal ?? new AbortController().signal),
        config: loadConfig({ accounts: { work: account({ services: ["calendar"] }), home: account({ services: ["calendar"] }) } }),
        read: async (request: { account: string; operation: string }) => {
          calls.push(`${request.account}:${request.operation}`)
          if (request.operation === "calendar.calendars.get") return { ok: true, operation: request.operation, category: "read", data: { timeZone: ZONE }, truncated: false }
          await new Promise<void>((resolve) => gates.set(request.account, resolve))
          const items = [timed(`${request.account}-meeting`, "2026-11-12T17:00:00Z", "2026-11-12T18:00:00Z")]
          return { ok: true, operation: request.operation, category: "read", data: { items }, truncated: false }
        },
      } as unknown as Pick<Runtime, "config" | "read">
      const release = async (alias: string) => {
        for (let tries = 0; !gates.has(alias) && tries < 100; tries++) await new Promise((resolve) => setTimeout(resolve, 1))
        gates.get(alias)?.()
        gates.delete(alias)
      }
      return { reader, calls, release }
    }

    it("reads each account on its own when two reads overlap, and labels each answer with the account it read", async () => {
      const { reader, calls, release } = perAccount()
      const today = calendarToday(reader, () => NOW)
      const work = today(undefined, "work")
      const home = today(undefined, "home")
      await release("home")
      await release("work")
      const [forWork, forHome] = await Promise.all([work, home])
      expect(forWork).toMatchObject({ account: "work", events: [{ id: "work-meeting" }] })
      expect(forHome).toMatchObject({ account: "home", events: [{ id: "home-meeting" }] })
      expect(calls.filter((call) => call.endsWith("calendar.events.list")).sort()).toEqual(["home:calendar.events.list", "work:calendar.events.list"])
    })

    it("never answers one account from another's kept reading", async () => {
      const { reader, calls, release } = perAccount()
      const today = calendarToday(reader, () => NOW)
      const work = today(undefined, "work")
      await release("work")
      expect(await work).toMatchObject({ account: "work", events: [{ id: "work-meeting" }] })
      // Within the minute work's reading is kept, and home still reads its own calendar.
      const home = today(undefined, "home")
      await release("home")
      expect(await home).toMatchObject({ account: "home", events: [{ id: "home-meeting" }] })
      expect(calls.filter((call) => call.startsWith("home:"))).toHaveLength(2)
      // Each kept reading still answers its own account.
      expect(await today(undefined, "work")).toMatchObject({ account: "work", events: [{ id: "work-meeting" }] })
      expect(await today(undefined, "home")).toMatchObject({ account: "home", events: [{ id: "home-meeting" }] })
      expect(calls).toHaveLength(4)
    })
  })

  describe("the read's own deadline", () => {
    afterEach(() => {
      vi.useRealTimers()
    })

    it("answers stale with the kept events when a read never finishes, at the deadline and not before", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
      let now = NOW
      const { reader, answers } = fakeReader()
      answers["calendar.calendars.get"] = { timeZone: ZONE }
      answers["calendar.events.list"] = { items: [timed("later", "2026-11-12T17:00:00Z", "2026-11-12T18:00:00Z")] }
      const today = calendarToday(reader, () => now)
      await today()
      now += FRESH_MS
      answers["calendar.events.list"] = NEVER
      let settled: unknown
      const pending = today().then((value) => {
        settled = value
      })
      await vi.advanceTimersByTimeAsync(READ_DEADLINE_MS - 1)
      expect(settled).toBeUndefined()
      await vi.advanceTimersByTimeAsync(1)
      await pending
      expect(settled).toEqual({
        account: "work",
        at: "2026-11-12T15:00:00Z",
        state: "stale",
        events: [{ id: "later", title: "later", start: "2026-11-12T17:00:00Z", end: "2026-11-12T18:00:00Z" }],
      })
    })

    it("fails with the declared error when a read never finishes and nothing is kept", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
      const { reader, answers } = fakeReader()
      answers["calendar.calendars.get"] = NEVER
      let handler: ((input: unknown, context: unknown) => Promise<unknown>) | undefined
      const ctx = {
        rpc: {
          register: async (_contract: unknown, handlers: Record<string, typeof handler>) => {
            handler = handlers["calendar.today"]
            return { dispose: async () => {} }
          },
        },
      }
      await registerJellyRpc(ctx as never, reader as unknown as Runtime)
      const context = { signal: new AbortController().signal, error: (type: string, message: string, data: unknown) => ({ type, message, data }) }
      const answer = handler!({}, context)
      await vi.advanceTimersByTimeAsync(READ_DEADLINE_MS)
      expect(await answer).toEqual({ type: "failed", message: expect.stringMatching(/^TIMEOUT: The calendar read did not finish within 8 seconds\. Next step: /), data: { code: "TIMEOUT", next: expect.any(String) } })
    })
  })

  it("leaves out the latest-starting events, whole, until the answer fits 60 KB, and audits how many", async () => {
    const { reader, answers, audited } = fakeReader()
    const cjk = "会議室の予定".repeat(100)
    const link = (host: string) => `https://${host}/${"a".repeat(2000)}`
    answers["calendar.calendars.get"] = { timeZone: ZONE }
    answers["calendar.events.list"] = {
      items: Array.from({ length: 50 }, (_, index) =>
        timed(`e${String(index).padStart(2, "0")}`, new Date(NOW + (index + 1) * 60_000).toISOString(), new Date(NOW + (index + 2) * 60_000).toISOString(), {
          summary: cjk,
          location: cjk,
          htmlLink: link("www.google.com"),
          hangoutLink: link("meet.google.com"),
        }),
      ),
    }
    const full = todayEvents((answers["calendar.events.list"] as { items: unknown[] }).items, ZONE, NOW)
    expect(full).toHaveLength(50)
    const today = calendarToday(reader, () => NOW)
    for (const answer of [await today(), await today()]) {
      expect(Buffer.byteLength(JSON.stringify(answer), "utf8")).toBeLessThanOrEqual(CALENDAR_MAX_BYTES)
      expect(answer.events.length).toBeGreaterThan(0)
      expect(answer.events.length).toBeLessThan(50)
      // The earliest events, each exactly as the field caps left it.
      expect(answer.events).toEqual(full.slice(0, answer.events.length))
      expect(answer.events[0]?.title).toHaveLength(200)
    }
    const kept = (await today()).events.length
    expect(audited).toEqual(Array(3).fill({ event: "calendar.today", outcome: "success", account: "work", category: "read", omitted: 50 - kept }))
  })

  it("fails with CALENDAR_UNAVAILABLE when no account enables calendar, or Google names no time zone", async () => {
    const none = fakeReader({ mail: account({ services: ["gmail"] }) })
    await expect(calendarToday(none.reader, () => NOW)()).rejects.toThrow(/^CALENDAR_UNAVAILABLE: No configured account enables calendar/)
    const { reader, answers, calls } = fakeReader()
    answers["calendar.calendars.get"] = { timeZone: "Mars/Olympus" }
    await expect(calendarToday(reader, () => NOW)()).rejects.toThrow(/^CALENDAR_UNAVAILABLE: /)
    expect(calls.map((call) => call.operation)).toEqual(["calendar.calendars.get"])
  })
})

describe("calendar.today through the plugin's own read path, with a fake gws", () => {
  const runtimes: Runtime[] = []
  afterEach(async () => {
    delete process.env["FAKE_GWS_RESPONSES"]
    for (const runtime of runtimes.splice(0)) await runtime.close()
  })

  it("runs two reads as the account, with a field mask, and nothing else", async () => {
    const runtime = await testRuntime({ accounts: { personal: account({ services: ["calendar"] }) } })
    runtimes.push(runtime)
    process.env["FAKE_GWS_RESPONSES"] = JSON.stringify({
      "calendar.calendars.get": { timeZone: "UTC" },
      "calendar.events.list": { items: [timed("review", "2026-11-12T16:00:00Z", "2026-11-12T17:00:00Z"), timed("next-year", "2027-11-12T16:00:00Z", "2027-11-12T17:00:00Z")] },
    })
    // The fake answers the same events whatever the window, so the plugin's own filter decides what is today.
    expect(await calendarToday(runtime, () => NOW)()).toEqual({
      account: "personal",
      at: "2026-11-12T15:00:00Z",
      state: "ready",
      events: [{ id: "review", title: "review", start: "2026-11-12T16:00:00Z", end: "2026-11-12T17:00:00Z" }],
    })
    const argv = readFileSync(join(accountDir(runtime.paths), "invocations.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[])
    expect(argv.map((call) => call.slice(0, 3))).toEqual([
      ["calendar", "calendars", "get"],
      ["calendar", "events", "list"],
    ])
    const params = (call: string[]) => JSON.parse(call[call.indexOf("--params") + 1]!)
    expect(params(argv[0]!)).toEqual({ calendarId: "primary", fields: "timeZone" })
    expect(params(argv[1]!)).toMatchObject({ calendarId: "primary", timeMin: "2026-11-12T00:00:00Z", timeMax: "2026-11-13T00:00:00Z", fields: EVENT_FIELDS })
    expect(argv.flat()).not.toContain("--dry-run")
  })

  it("fails with AUTH_REQUIRED, before gws runs, when the account has no sign-in", async () => {
    const runtime = await testRuntime({ accounts: { personal: account({ services: ["calendar"] }) } }, { tokenProvider: async () => undefined })
    runtimes.push(runtime)
    await expect(calendarToday(runtime)()).rejects.toThrow(/^AUTH_REQUIRED: /)
  })
})

describe("the jelly declaration of calendar.today", () => {
  const jelly = pkg.jelly as {
    tools: { permission: string; readOnly?: boolean }[]
    rpc: { name: string; permission: string; readOnly: boolean; input: unknown; output: unknown }[]
    views: { id: string; page?: string; grants: string[]; rpc?: string[] }[]
    nativeData: { v: number; capability: string; view: string; read: string; source?: string }[]
  }
  const sources = (pkg as unknown as { sources: { items: { id: string; kind: string; tool: string; output?: string }[] } }).sources

  it("is registered under the package's own name, which Jelly calls a view's methods on", () => {
    expect(PACKAGE_NAME).toBe(pkg.name)
  })

  it("declares the schemas the method registers", () => {
    const method = jelly.rpc.find((entry) => entry.name === "calendar.today")
    expect(method?.input).toEqual(TODAY_INPUT)
    expect(method?.output).toEqual(TODAY_OUTPUT)
    // OpenCode 2.2.7 fails every call to a method whose schema uses `pattern` (Jelly's plugin authors' guide).
    expect(JSON.stringify(TODAY_OUTPUT)).not.toContain("pattern")
  })

  // Jelly's own rules (hey-jelly protocol/contracts/src/plugin-views.ts viewIssues, plugin-native-data.ts
  // nativeDataIssues): a read-only method under a declared tool permission, named by a page view with the rpc grant.
  it("follows Jelly's native data rules", () => {
    const [hint] = jelly.nativeData
    expect(jelly.nativeData).toEqual([{ v: 1, capability: "calendar", view: "calendar-native", read: "calendar.today", source: "gws.calendar.today" }])
    // D202: while Jelly's source setting is on, Home reads the source the hint names, the agenda snapshot on the tools RPC.
    expect(sources.items.find((item) => item.id === hint?.source)).toMatchObject({ kind: "snapshot", tool: "calendar_today", output: "agenda" })
    const view = jelly.views.find((entry) => entry.id === hint?.view)
    expect(view?.page).toBe("views/calendar.html")
    expect(view?.grants).toEqual(["rpc"])
    expect(view?.rpc).toEqual(["calendar.today"])
    const method = jelly.rpc.find((entry) => entry.name === hint?.read)
    expect(method?.readOnly).toBe(true)
    expect(jelly.tools.find((tool) => tool.permission === method?.permission)).toMatchObject({ permission: "gws.read", readOnly: true })
    expect(pkg.files).toContain("views/calendar.html")
  })
})

type Agenda = { account: string; stale: boolean; rows: { title: string; allDay: boolean; start: string; end: string; location: string }[] } | null

describe("the Today view", () => {
  const page = readFileSync(new URL("views/calendar.html", root), "utf8")
  const helper = readFileSync(new URL("views/jelly-view.js", root), "utf8").trimEnd()
  const agendaOf = new Function(`const STALE_MS = 15 * 60 * 1000; ${/function agendaOf[\s\S]*?\n}\n/.exec(page)![0]}; return agendaOf`)() as (answer: unknown, now: number) => Agenda

  it("carries Jelly's helper inline, loads nothing by URL and writes no HTML", () => {
    expect(page).toContain(helper)
    expect(page).not.toMatch(/<script[^>]+src=|<link\b|\bfetch\(|\bimport\(|url\(|XMLHttpRequest|WebSocket|localStorage/)
    expect(page).not.toMatch(/innerHTML|insertAdjacentHTML|document\.write/)
  })

  it("shows all-day entries first, then by start, and leaves out ended ones", () => {
    const answer = {
      account: "work",
      at: "2026-11-12T15:00:00Z",
      state: "ready",
      events: [
        { id: "b", title: "B", start: "2026-11-12T17:00:00Z", end: "2026-11-12T18:00:00Z" },
        { id: "a", title: "A", start: "2026-11-12T16:00:00Z", end: "2026-11-12T16:30:00Z", location: "Room" },
        { id: "day", title: "Holiday", start: "2026-11-12T00:00:00Z", end: "2026-11-13T00:00:00Z", allDay: true },
        { id: "gone", title: "Gone", start: "2026-11-12T09:00:00Z", end: "2026-11-12T10:00:00Z" },
      ],
    }
    expect(agendaOf(answer, NOW)?.rows.map((row) => row.title)).toEqual(["Holiday", "A", "B"])
    expect(agendaOf(answer, NOW)?.stale).toBe(false)
  })

  it("says stale when the answer says so or is more than 15 minutes old", () => {
    const answer = { account: "work", at: "2026-11-12T15:00:00Z", state: "ready", events: [] }
    expect(agendaOf({ ...answer, state: "stale" }, NOW)?.stale).toBe(true)
    expect(agendaOf(answer, NOW + 15 * 60_000 + 1)?.stale).toBe(true)
  })

  it("reads a missing or malformed answer as not available, never as an empty day", () => {
    const answer = { account: "work", at: "2026-11-12T15:00:00Z", state: "ready", events: [] }
    for (const bad of [null, [], {}, { ...answer, state: "unavailable" }, { ...answer, account: "" }, { ...answer, at: "soon" }, { ...answer, events: "none" }, { ...answer, events: Array(51).fill({}) }])
      expect(agendaOf(bad, NOW), JSON.stringify(bad)).toBeNull()
    expect(agendaOf(answer, NOW)).toEqual({ account: "work", stale: false, rows: [] })
  })
})
