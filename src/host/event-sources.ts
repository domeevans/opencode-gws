import { type EventsListRequest, type EventsListResult, SOURCE_PATTERN, parseEventsListInput } from "@we-the-rebel-alliance/source-contract/events"
import { GwsError } from "../domain/errors.js"
import type { CallContext } from "../runtime/accounts.js"
import type { Runtime } from "../runtime/index.js"
import { CALENDAR_FOLLOW, CALENDAR_READS, CALENDAR_SCOPE_KEYS, CALENDAR_SOURCE, calendarEvents } from "./calendar-events.js"
import { GMAIL_FOLLOW, GMAIL_READS, GMAIL_SOURCE, gmailEvents } from "./gmail-events.js"

/**
 * The sources `events_list` serves, one module each: Gmail's messages and Calendar's events, as `package.json`
 * `sources` declares them (`gws.gmail`, `gws.calendar`). The page, the event, the screening and the cursor are the
 * source contract's (`@we-the-rebel-alliance/source-contract`, bundled into dist/index.js); a source names the reads it
 * makes, the operation `gws.events_list` is asserted on, its scope keys, and the function that lists it, so the tool
 * asserts exactly a source's operations and nothing wider.
 */

/** One source of `events_list`. */
export interface EventSource {
  /** The `source` value that names it. */
  readonly id: string
  /** Every operation it reads; the tool asserts gws.read on each before any runs. */
  readonly reads: readonly string[]
  /** The operation `gws.events_list` is asserted on: the one the listing follows. */
  readonly follow: string
  /** The scope keys it declares; none for a source that reads the whole account. */
  readonly scopeKeys: readonly string[]
  /** Lists the source for `account`, as the source contract describes. */
  readonly run: (runtime: Pick<Runtime, "read">, account: string, request: EventsListRequest, ctx: CallContext, now?: number) => Promise<EventsListResult>
}

const SOURCES: readonly EventSource[] = [
  { id: GMAIL_SOURCE, reads: GMAIL_READS, follow: GMAIL_FOLLOW, scopeKeys: [], run: gmailEvents },
  { id: CALENDAR_SOURCE, reads: CALENDAR_READS, follow: CALENDAR_FOLLOW, scopeKeys: CALENDAR_SCOPE_KEYS, run: calendarEvents },
]

/** The sources events_list serves; the first is the one a call without `source` lists. */
export const EVENT_SOURCES: readonly string[] = SOURCES.map((source) => source.id)

/**
 * The source a call names and its parsed request. An unknown source is SOURCE_UNKNOWN, and a malformed input,
 * including a scope key the source does not declare, is INPUT_INVALID: the contract's two input refusals.
 */
export function eventsRequest(input: unknown): { source: EventSource; request: EventsListRequest } {
  const named = typeof input === "object" && input !== null && !Array.isArray(input) ? (input as Record<string, unknown>)["source"] : undefined
  const source = named === undefined ? SOURCES[0]! : SOURCES.find((candidate) => candidate.id === named)
  if (source === undefined) {
    const known = EVENT_SOURCES.map((id) => `"${id}"`).join(" or ")
    const what = typeof named === "string" && named.length <= 64 && SOURCE_PATTERN.test(named) ? `the source '${named}'` : "the source named"
    throw new GwsError("SOURCE_UNKNOWN", `${what} is not one events_list serves`, { next: `Call events_list without source, or with source ${known}.` })
  }
  const parsed = parseEventsListInput(input, { scopeKeys: source.scopeKeys })
  if (!parsed.ok) throw new GwsError("INPUT_INVALID", parsed.problems.join("; "))
  return { source, request: parsed.value }
}
