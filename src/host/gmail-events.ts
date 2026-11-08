import { createHash } from "node:crypto"
import { GwsError, throwIfCancelled } from "../domain/errors.js"
import { type GmailMessage, MESSAGE_FIELDS, type MessageFacts, NOISE_QUERY, isNoise, messageFacts } from "../domain/gmail.js"
import type { CallContext } from "../runtime/accounts.js"
import type { Runtime } from "../runtime/index.js"
import {
  type EventsListRequest,
  type EventsListResult,
  type SourceEvent,
  decodeCursor,
  encodeCursor,
  eventsListResult,
  fitPage,
  makeEvent,
  oldestFirst,
  parseEventsListInput,
  startTime,
} from "./events-list.js"

/**
 * events_list for Gmail: the messages that arrived since a cursor, as the
 * funnel's events (`events-list.ts`), for Memory's collector. Every call is
 * plain reads through the runtime, so each one passes the plugin's policy
 * and audit like a gws_read; the tool asserts gws.events_list, then
 * gws.read on each operation, before any of them runs.
 *
 * - The first listing (no cursor) searches messages.list for everything
 *   after `since`, oldest first, after noting the mailbox's history id.
 *   Then it follows history.list from that id, so a message that arrives
 *   meanwhile is listed too (at worst twice; Memory drops the repeat).
 * - A history id Gmail no longer keeps (it answers 404) falls back to the
 *   search, from the last event listed.
 * - Spam, trash, drafts, Promotions and Social are left out
 *   (`NOISE_LABELS`); a message deleted after it was listed is skipped.
 * - The cursor names the account and a digest of the mailbox's address, so
 *   a cursor from another account or a changed sign-in is refused.
 */

/** The `source` of Gmail events. */
export const GMAIL_SOURCE = "gmail"

/** Every read events_list makes, the history read second. The tool asserts gws.read on `<account>:<operation>` for each before it runs any. */
export const EVENT_READS = ["gmail.users.getProfile", "gmail.users.history.list", "gmail.users.messages.list", "gmail.users.messages.get"] as const

/** Ids per messages.list or history.list page. */
const PAGE_SIZE = 500
/** The most messages.list pages the first listing reads: after that, `since` is too early. */
const SEARCH_PAGES = 20
/** The most history.list pages one call reads; the cursor carries on from there. */
const HISTORY_PAGES = 5
/** messages.get calls at once. */
const FETCHES = 4

/** The headers and snippet only, for a message whose full body is over gws's output cap. */
const METADATA_FIELDS = "id,threadId,labelIds,snippet,internalDate,payload(headers(name,value))"

/** Searching messages after `t` (epoch ms), the mailbox's history at `h0` when the search began; `l` is the last message listed. */
interface Search {
  readonly p: "s"
  readonly h0: string
  readonly t: number
  readonly l?: string
}

/** Following history from record `h`, of whose added messages the first `n` are listed; `t` is the last event's time, for a fallback. */
interface Follow {
  readonly p: "h"
  readonly h: string
  readonly n: number
  readonly t: number
}

type State = Search | Follow

/** A message to fetch, and where the listing stands once it is listed. */
interface Candidate {
  readonly id: string
  readonly after: State
}

type Data = Record<string, unknown>

const record = (value: unknown): Data => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Data) : {})
const list = (value: unknown): Data[] => (Array.isArray(value) ? value.map(record) : [])
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [])
/** A Gmail history id: a decimal string. */
const historyId = (value: unknown): string | undefined =>
  typeof value === "string" && /^\d{1,20}$/.test(value) ? BigInt(value).toString() : typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? String(value) : undefined
const step = (id: string, by: bigint) => {
  const value = BigInt(id) + by
  return (value < 0n ? 0n : value).toString()
}
const before = (a: string, b: string) => BigInt(a) < BigInt(b)

/** A request's problems as GWS_VALIDATION_ERROR, or the parsed request. */
export function eventsRequest(input: unknown): EventsListRequest {
  const parsed = parseEventsListInput(input)
  if (!parsed.ok) throw new GwsError("GWS_VALIDATION_ERROR", parsed.problems.join("; "))
  return parsed.value
}

/** The state a cursor holds, when this account's mailbox issued it. */
function stateOf(cursor: string, account: string, mailbox: string): State {
  const state = decodeCursor(GMAIL_SOURCE, cursor)
  const refuse = () => new GwsError("CURSOR_INVALID", `the cursor was not issued by events_list for account '${account}' and its mailbox`)
  if (!state || state["a"] !== account || state["o"] !== mailbox) throw refuse()
  const { p, t } = state
  if (typeof t !== "number" || !Number.isSafeInteger(t) || t < 0) throw refuse()
  if (p === "s") {
    const h0 = historyId(state["h0"])
    const l = state["l"]
    if (!h0 || (l !== undefined && typeof l !== "string")) throw refuse()
    return { p, h0, t, ...(typeof l === "string" ? { l } : {}) }
  }
  const h = historyId(state["h"])
  const n = state["n"]
  if (p !== "h" || !h || typeof n !== "number" || !Number.isSafeInteger(n) || n < 0) throw refuse()
  return { p, h, n, t }
}

/** `work` over each item, at most `limit` at once, the results in the items' order. */
async function each<T, R>(items: readonly T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const index = next++
      results[index] = await work(items[index]!)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

function toEvent(facts: MessageFacts, account: string): SourceEvent {
  const thread = facts.threadId ? encodeURIComponent(facts.threadId) : undefined
  return makeEvent({
    source: GMAIL_SOURCE,
    account,
    external_id: facts.id,
    kind: "message",
    occurred_at: facts.time,
    thread: thread ? `gmail-thread:${thread}` : null,
    actors: facts.people.map((person) => ({ role: person.role, id: `mailto:${person.address}`, ...(person.name ? { name: person.name } : {}) })),
    title: facts.subject,
    text: facts.text,
    url: thread ? `https://mail.google.com/mail/u/0/#all/${thread}` : null,
    labels: facts.labels,
  })
}

/**
 * Lists the Gmail messages of `account` after the request's cursor, or
 * since its `since`. `runtime.read` runs each read under the plugin's read
 * policy; `ctx` cancels them.
 */
export async function gmailEvents(runtime: Pick<Runtime, "read">, account: string, request: EventsListRequest, ctx: CallContext, now = Date.now()): Promise<EventsListResult> {
  const read = async (operation: string, params: Data, fields: string): Promise<Data> =>
    record((await runtime.read({ account, operation, params: { userId: "me", ...params }, fields }, ctx)).data)
  /** The status of a Google API error, such as 404 for a history id Gmail no longer keeps or a message deleted since. */
  const status = (error: unknown) => GwsError.from(error)?.status

  const profile = await read("gmail.users.getProfile", {}, "emailAddress,historyId")
  const address = typeof profile["emailAddress"] === "string" ? profile["emailAddress"].trim().toLowerCase() : ""
  const head = historyId(profile["historyId"])
  if (!address || !head) throw new GwsError("GWS_API_ERROR", "Gmail's profile answered without the account's address or history id")
  const owner = { id: `mailto:${address}`, label: address }
  const mailbox = createHash("sha256").update(address).digest("hex").slice(0, 16)

  /** Every message after `t` the search finds, oldest first. */
  const searched = new Map<number, string[]>()
  const search = async (t: number): Promise<string[]> => {
    const known = searched.get(t)
    if (known) return known
    const ids: string[] = []
    let pageToken: string | undefined
    for (let page = 0; page < SEARCH_PAGES; page++) {
      // Gmail's after: takes whole seconds; events before `t` are dropped below.
      const q = `after:${Math.max(0, Math.floor(t / 1000) - 1)} ${NOISE_QUERY}`
      const data = await read("gmail.users.messages.list", { q, maxResults: PAGE_SIZE, ...(pageToken ? { pageToken } : {}) }, "messages(id),nextPageToken")
      ids.push(...list(data["messages"]).flatMap((message) => (typeof message["id"] === "string" ? [message["id"]] : [])))
      pageToken = typeof data["nextPageToken"] === "string" ? data["nextPageToken"] : undefined
      if (!pageToken) {
        // messages.list answers newest first.
        const found = [...new Set(ids)].reverse()
        searched.set(t, found)
        return found
      }
    }
    throw new GwsError("GWS_VALIDATION_ERROR", `more than ${SEARCH_PAGES * PAGE_SIZE} messages arrived after since`, { next: "Call events_list again with a later since." })
  }

  /** History records from `from`: the added messages that are not noise, up to `room`, and where that leaves the listing. */
  const follow = async (from: Follow, room: number): Promise<{ added: Candidate[]; state: Follow; more: boolean } | "expired"> => {
    const added: Candidate[] = []
    let state = from
    let pageToken: string | undefined
    for (let page = 0; page < HISTORY_PAGES; page++) {
      let data: Data
      try {
        // startHistoryId one below `h`, so record `h` is read whether Gmail starts at the id or after it.
        const params = { startHistoryId: step(from.h, -1n), historyTypes: "messageAdded", maxResults: PAGE_SIZE, ...(pageToken ? { pageToken } : {}) }
        data = await read("gmail.users.history.list", params, "history(id,messagesAdded(message(id,labelIds))),historyId,nextPageToken")
      } catch (error) {
        if (page === 0 && status(error) === 404) return "expired"
        throw error
      }
      for (const entry of list(data["history"])) {
        const id = historyId(entry["id"])
        if (!id || before(id, state.h)) continue
        const messages = list(entry["messagesAdded"]).map((added) => record(added["message"]))
        for (let index = id === state.h ? state.n : 0; index < messages.length; index++) {
          if (added.length >= room) return { added, state, more: true }
          const message = messages[index]!
          state = { p: "h", h: id, n: index + 1, t: state.t }
          if (typeof message["id"] === "string" && !isNoise(strings(message["labelIds"]))) added.push({ id: message["id"], after: state })
        }
        state = { p: "h", h: step(id, 1n), n: 0, t: state.t }
      }
      pageToken = typeof data["nextPageToken"] === "string" ? data["nextPageToken"] : undefined
      if (!pageToken) {
        // Caught up: the next change is after the mailbox's current history id.
        const current = historyId(data["historyId"])
        if (current && before(state.h, step(current, 1n))) state = { p: "h", h: step(current, 1n), n: 0, t: state.t }
        return { added, state, more: false }
      }
    }
    return { added, state, more: true }
  }

  let state: State = request.cursor === undefined ? { p: "s", h0: head, t: startTime(request, now) } : stateOf(request.cursor, account, mailbox)
  const candidates: Candidate[] = []
  let more = false
  let fellBack = false
  while (candidates.length < request.limit) {
    throwIfCancelled(ctx.signal)
    if (state.p === "s") {
      const ids = await search(state.t)
      // A last-listed message that is gone starts the search over; Memory drops the repeats.
      const from = state.l === undefined ? 0 : ids.indexOf(state.l) + 1
      const take = ids.slice(from, from + request.limit - candidates.length)
      for (const id of take) {
        state = { ...state, l: id }
        candidates.push({ id, after: state })
      }
      if (from + take.length < ids.length) {
        more = true
        break
      }
      state = { p: "h", h: step(state.h0, 1n), n: 0, t: state.t }
      continue
    }
    const followed = await follow(state, request.limit - candidates.length)
    if (followed === "expired") {
      if (fellBack) throw new GwsError("GWS_API_ERROR", "Gmail refused a history id it had just given")
      fellBack = true
      state = { p: "s", h0: head, t: state.t }
      continue
    }
    candidates.push(...followed.added)
    state = followed.state
    more = followed.more
    break
  }

  const fetched = await each(candidates, FETCHES, async (candidate): Promise<GmailMessage | undefined> => {
    const get = (fields: string, format: string) => read("gmail.users.messages.get", { id: candidate.id, format }, fields) as Promise<GmailMessage>
    try {
      return await get(MESSAGE_FIELDS, "full")
    } catch (error) {
      const known = GwsError.from(error)
      if (known?.status === 404) return undefined
      if (known?.code === "OUTPUT_LIMIT") return get(METADATA_FIELDS, "metadata")
      throw error
    }
  })
  const listed: Array<{ event: SourceEvent; after: State }> = []
  for (const [index, message] of fetched.entries()) {
    const candidate = candidates[index]!
    const facts = message && !isNoise(message.labelIds) ? messageFacts(message) : undefined
    // The search reaches back to the second before `since`; history has no lower bound.
    if (!facts || (candidate.after.p === "s" && facts.time < candidate.after.t)) continue
    listed.push({ event: toEvent(facts, account), after: candidate.after })
  }
  const kept = fitPage(
    listed.map((item) => item.event),
    request.limit,
  )
  if (kept < listed.length) {
    more = true
    state = listed[kept - 1]!.after
  }
  const events = listed.slice(0, kept).map((item) => item.event)
  if (state.p === "h") {
    const last = Math.max(state.t, ...events.map((event) => Date.parse(event.occurred_at)))
    state = { ...state, t: last }
  }
  return eventsListResult(owner, oldestFirst(events), encodeCursor(GMAIL_SOURCE, { a: account, o: mailbox, ...state }), more)
}
