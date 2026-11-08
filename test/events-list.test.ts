import { describe, expect, it } from "vitest"
import {
  assertEventsListConformance, cut, decodeCursor, encodeCursor, eventHash, eventProblems, eventsListConformance, eventsListResult, fitPage, makeEvent,
  MAX_PAGE_BYTES, oldestFirst, PAGE, parseEventsListInput, resultProblems, sinceTime, startTime, type EventsListInput, type SourceEvent,
} from "../src/host/events-list.js"

// The shared events_list module (src/host/events-list.ts), tested on its own: its parser, cursor, event helpers and
// checks, and the conformance check against a reference source and broken ones.

const T0 = Date.parse("2026-11-01T09:00:00Z")

const event = (index: number, extra: Partial<Parameters<typeof makeEvent>[0]> = {}): SourceEvent =>
  makeEvent({ source: "demo", account: "work", external_id: `item-${index}`, kind: "message", occurred_at: T0 + index * 60_000, title: `Item ${index}`, text: `Text ${index}`, ...extra })

/** A correct in-memory source over `items`, and switches that break one rule each. */
function source(items: readonly SourceEvent[], broken: { skip?: boolean; anyCursor?: boolean; noLimit?: boolean; newestFirst?: boolean } = {}) {
  return async (input: EventsListInput) => {
    const parsed = parseEventsListInput(input)
    if (!parsed.ok && !(broken.noLimit && parsed.problems.every(problem => problem.startsWith('"limit"')))) throw new Error(parsed.ok ? "" : parsed.problems.join("; "))
    const request = parsed.ok ? parsed.value : { limit: 1_000, ...(input.cursor ? { cursor: input.cursor } : {}) }
    let from = 0
    if (request.cursor !== undefined) {
      const state = decodeCursor("demo", request.cursor)
      if (!state || typeof state["n"] !== "number") {
        if (!broken.anyCursor) throw new Error("CURSOR_INVALID")
      } else from = state["n"]
    } else {
      const since = startTime(request, T0 + 3_600_000)
      from = items.findIndex(item => Date.parse(item.occurred_at) >= since)
      if (from === -1) from = items.length
    }
    const page = items.slice(from, from + request.limit)
    const next = from + page.length + (broken.skip && page.length > 0 ? 1 : 0)
    return eventsListResult({ id: "mailto:sam@example.com", label: "sam@example.com" }, broken.newestFirst ? [...page].reverse() : page, encodeCursor("demo", { n: next }), next < items.length)
  }
}

describe("input", () => {
  it("defaults the limit and reads since as epoch milliseconds", () => {
    expect(parseEventsListInput({})).toEqual({ ok: true, value: { limit: PAGE.default } })
    expect(parseEventsListInput(undefined)).toEqual({ ok: true, value: { limit: PAGE.default } })
    expect(parseEventsListInput({ since: "2026-11-01", cursor: "abc", limit: 7, account: "work" })).toEqual({ ok: true, value: { since: Date.parse("2026-11-01T00:00:00Z"), cursor: "abc", limit: 7, account: "work" } })
    expect(sinceTime("2026-11-01T10:00+01:00")).toBe(Date.parse("2026-11-01T09:00:00Z"))
  })

  it("refuses unknown fields, a since without a zone or not a real time, and limits out of range, naming fields only", () => {
    const problems = (input: unknown) => (parseEventsListInput(input) as { problems?: string[] }).problems
    expect(problems({ query: "x" })).toEqual(['"query" is not an input of events_list'])
    expect(problems({ since: "2026-11-01T10:00" })).toHaveLength(1)
    expect(problems({ since: "2026-13-01" })).toHaveLength(1)
    for (const limit of [0, 501, 1.5, "10"]) expect(problems({ limit }), String(limit)).toEqual(['"limit" must be an integer from 1 to 500'])
    expect(problems({ cursor: "" })).toHaveLength(1)
    expect(problems({ account: "" })).toHaveLength(1)
    expect(problems([])).toEqual(["the input must be an object"])
    expect(JSON.stringify(problems({ since: "secret-value" }))).not.toContain("secret-value")
  })

  it("starts 24 hours back without since", () => {
    expect(startTime({}, T0)).toBe(T0 - 24 * 3_600_000)
    expect(startTime({ since: 5 }, T0)).toBe(5)
  })
})

describe("cursor", () => {
  it("holds a source's state, and refuses another source's or a malformed one", () => {
    const cursor = encodeCursor("demo", { n: 3, id: "x" })
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(decodeCursor("demo", cursor)).toEqual({ n: 3, id: "x" })
    expect(decodeCursor("other", cursor)).toBeUndefined()
    for (const bad of ["", "not a cursor", "bm90LWpzb24", Buffer.from(JSON.stringify({ v: 2, s: "demo" })).toString("base64url")]) expect(decodeCursor("demo", bad), bad).toBeUndefined()
    expect(() => encodeCursor("demo", { pad: "x".repeat(1_000) })).toThrow(/over 1024/)
  })
})

describe("events", () => {
  it("normalises a draft: one-line title, cut text, UTC time, unique actors and labels, https urls only, and its hash", () => {
    const made = makeEvent({
      source: "demo", account: "work", external_id: "id-1", kind: "message", occurred_at: "2026-11-01T10:00:00+01:00",
      title: "  Re:\n  the   plan ", text: `  ${"x".repeat(5_000)}`, url: "http://example.com/x", thread: "",
      actors: [{ role: "From", id: "mailto:a@example.com", name: " Ama " }, { role: "from", id: "mailto:a@example.com" }, { role: "to", id: "", name: "x" }, ...Array.from({ length: 30 }, (_, index) => ({ role: "cc", id: `mailto:p${index}@example.com`, name: null }))],
      labels: ["inbox", "inbox", "has space", ""],
    })
    expect(made).toMatchObject({ occurred_at: "2026-11-01T09:00:00.000Z", title: "Re: the plan", url: null, thread: null, labels: ["inbox", "has-space"] })
    expect(made.text).toHaveLength(4_096)
    expect(made.text.endsWith("…")).toBe(true)
    expect(made.actors).toHaveLength(20)
    expect(made.actors[0]).toEqual({ role: "from", id: "mailto:a@example.com", name: "Ama" })
    expect(made.actors[1]).toEqual({ role: "cc", id: "mailto:p0@example.com" })
    const { hash, ...rest } = made
    expect(hash).toBe(eventHash(rest))
    expect(eventProblems(made)).toEqual([])
    expect(() => makeEvent({ source: "demo", account: "work", external_id: "x", kind: "doc", occurred_at: "not a time" })).toThrow()
  })

  it("cuts without splitting a surrogate pair", () => {
    expect(cut("ab😀cd", 4)).toBe("ab…")
    expect(cut("abc", 3)).toBe("abc")
  })

  it("finds each way an event breaks the contract", () => {
    const good = event(1)
    const problems = (change: Record<string, unknown>) => eventProblems({ ...good, ...change })
    expect(problems({ extra: 1 })).toContain('event has the field "extra", which the contract does not define')
    expect(problems({ kind: "tweet" })).toEqual([expect.stringContaining("kind")])
    expect(problems({ occurred_at: "2026-11-01 09:00:00" })).toEqual([expect.stringContaining("occurred_at")])
    expect(problems({ text: "x".repeat(4_097) })).toEqual([expect.stringContaining("text")])
    expect(problems({ title: "a\nb" })).toEqual([expect.stringContaining("title")])
    expect(problems({ url: "http://example.com" })).toEqual([expect.stringContaining("url")])
    expect(problems({ actors: [{ role: "from", id: "ama@example.com" }] })).toEqual([expect.stringContaining("scheme-qualified")])
    expect(problems({ source: "Gmail" })).toEqual([expect.stringContaining("source")])
    expect(problems({ title: "Changed" })).toEqual(["event.hash is not the eventHash of its fields"])
    const { hash: _hash, ...unhashed } = good
    expect(eventProblems(unhashed)).toEqual(['event has no "hash"', expect.stringContaining("hash")])
  })

  it("finds each way a result breaks the contract", () => {
    const owner = { id: "mailto:sam@example.com", label: "sam@example.com" }
    expect(resultProblems(eventsListResult(owner, [event(1), event(2)], "c", false))).toEqual([])
    expect(resultProblems(eventsListResult(owner, [event(2), event(1)], "c", false))).toEqual(["the result's events are not oldest first"])
    expect(resultProblems(eventsListResult(owner, [event(1), event(1)], "c", false))).toEqual(["the result lists one event twice"])
    expect(resultProblems(eventsListResult(owner, [event(1), event(2)], "c", false), 1)).toEqual(["the result has 2 events, over the limit of 1"])
    expect(resultProblems({ owner, events: [], cursor: "", more: false, trust: "trusted", extra: true })).toEqual([
      'the result has the field "extra", which the contract does not define', expect.stringContaining("cursor"), expect.stringContaining("trust"),
    ])
  })

  it("orders oldest first, keeping ties in order, and fits a page under the byte cap", () => {
    expect(oldestFirst([event(3), event(1), event(2, { external_id: "tie" }), event(2)]).map(e => e.external_id)).toEqual(["item-1", "tie", "item-2", "item-3"])
    const big = Array.from({ length: 400 }, (_, index) => event(index, { text: "y".repeat(4_096) }))
    const fits = fitPage(big, 500)
    expect(fits).toBeGreaterThan(100)
    expect(fits).toBeLessThan(400)
    expect(Buffer.byteLength(JSON.stringify(eventsListResult({ id: "x:y", label: "y" }, big.slice(0, fits), "c", true)))).toBeLessThanOrEqual(MAX_PAGE_BYTES)
    expect(fitPage(big, 3)).toBe(3)
    expect(fitPage([], 3)).toBe(0)
  })
})

describe("conformance", () => {
  const items = Array.from({ length: 5 }, (_, index) => event(index))
  const fixtures = { source: "demo", account: "work", owner: { id: "mailto:sam@example.com", label: "sam@example.com" }, since: "2026-11-01T08:00:00Z", expected: items.map(item => item.external_id) }

  it("passes a source that keeps the contract", async () => {
    await assertEventsListConformance(source(items), fixtures)
    await assertEventsListConformance(source(items), { ...fixtures, pageSize: 1 })
    await assertEventsListConformance(source(items), { ...fixtures, pageSize: 5 })
  })

  it("catches a source that skips, ignores the limit, accepts any cursor, or lists newest first", async () => {
    expect(await eventsListConformance(source(items, { skip: true }), fixtures)).toContainEqual(expect.stringMatching(/^the pages of 2 list \[item-0, item-1, item-3/))
    expect(await eventsListConformance(source(items, { noLimit: true }), fixtures)).toEqual(["a limit of 501 was not refused", "a limit of 0 was not refused"])
    expect(await eventsListConformance(source(items, { anyCursor: true }), fixtures)).toEqual(["a malformed cursor was not refused", "another source's cursor was not refused"])
    expect(await eventsListConformance(source(items, { newestFirst: true }), fixtures)).toContainEqual(expect.stringContaining("not oldest first"))
    await expect(assertEventsListConformance(source(items, { skip: true }), fixtures)).rejects.toThrow(/^events_list breaks the contract:\n- /)
  })

  it("catches events from before since, another source or account, and a changing owner", async () => {
    expect(await eventsListConformance(source(items), { ...fixtures, since: "2026-11-01T09:02:00Z", expected: fixtures.expected.slice(2) })).toEqual([])
    expect(await eventsListConformance(source(items), { ...fixtures, source: "other" })).toContainEqual(expect.stringContaining("names the source demo, not other"))
    expect(await eventsListConformance(source(items), { ...fixtures, account: "home" })).toContainEqual(expect.stringContaining("names the account work, not home"))
    expect(await eventsListConformance(source(items), { ...fixtures, owner: { id: "mailto:x@example.com", label: "x" } })).toContainEqual(expect.stringContaining("not the fixture's owner"))
  })
})
