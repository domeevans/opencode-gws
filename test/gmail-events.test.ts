import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { z } from "zod"
import { EventsListInput, EventsListOutput } from "../src/domain/contract.js"
import { EVENT_LIMITS, type EventsListInput as Input, type EventsListResult, PAGE, assertEventsListConformance, encodeCursor, resultProblems } from "../src/host/events-list.js"
import { EVENT_READS, GMAIL_SOURCE } from "../src/host/gmail-events.js"
import type { PermissionRequest } from "../src/host/permissions.js"
import { type Call, parse, toolSpecs } from "../src/host/tools.js"
import type { Runtime } from "../src/runtime/index.js"
import { account, testRuntime } from "./support/config.js"

/**
 * gws_events_list, through its tool spec and the runtime, against the fake
 * gws answering from a synthetic mailbox (test/fixtures/gmail-mailbox.json):
 * the shared contract's conformance check, the event each message makes,
 * the first listing's search, history after it, a history id Gmail no
 * longer keeps, accounts, and the asserts that run before any read.
 */

const FIXTURE = fileURLToPath(new URL("./fixtures/gmail-mailbox.json", import.meta.url))
const SINCE = "2026-11-01T00:00:00Z"
const OWNER = { id: "mailto:sam.rivera@example.com", label: "sam.rivera@example.com" }
const LISTED = ["18f0000000000001", "18f0000000000002", "18f0000000000007", "18f0000000000008"]

interface Mailbox {
  emailAddress: string
  historyId: string
  historyStart?: string
  messages: Array<Record<string, unknown> & { id: string; threadId: string; labelIds: string[]; internalDate: string }>
  history: Array<{ id: string; messagesAdded: Array<{ message: { id: string; threadId: string; labelIds: string[] } }> }>
}

let dir: string
let mailboxPath: string
const runtimes: Runtime[] = []

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "opencode-gws-mailbox-"))
  mailboxPath = join(dir, "mailbox.json")
  copyFileSync(FIXTURE, mailboxPath)
  process.env["FAKE_GWS_MAILBOX"] = mailboxPath
})

afterEach(async () => {
  delete process.env["FAKE_GWS_MAILBOX"]
  delete process.env["FAKE_GWS_LOG"]
  for (const runtime of runtimes.splice(0)) await runtime.close()
  rmSync(dir, { recursive: true, force: true })
})

const mailbox = (): Mailbox => JSON.parse(readFileSync(mailboxPath, "utf8")) as Mailbox
const save = (box: Mailbox) => writeFileSync(mailboxPath, JSON.stringify(box))

/** Mail that arrives after the first listing: each message is one history record unless `together`. */
function deliver(messages: Array<{ id: string; at: string; labels?: string[]; together?: boolean }>): void {
  const box = mailbox()
  let next = BigInt(box.historyId)
  for (const message of messages) {
    const labelIds = message.labels ?? ["INBOX"]
    box.messages.push({
      id: message.id,
      threadId: message.id,
      labelIds,
      snippet: `Synthetic ${message.id}`,
      internalDate: String(Date.parse(message.at)),
      payload: { mimeType: "text/plain", headers: [{ name: "From", value: "ama.mensah@example.com" }, { name: "Subject", value: `About ${message.id}` }] },
    })
    const added = { message: { id: message.id, threadId: message.id, labelIds } }
    const last = box.history.at(-1)
    if (message.together && last) last.messagesAdded.push(added)
    else box.history.push({ id: String(++next), messagesAdded: [added] })
  }
  box.historyId = String(next)
  save(box)
}

async function harness(overrides: Record<string, unknown> = {}, assert: (request: PermissionRequest) => Promise<void> = async () => {}) {
  const runtime = await testRuntime(overrides)
  runtimes.push(runtime)
  const asserted: PermissionRequest[] = []
  const specs = toolSpecs(
    runtime,
    async (request) => {
      asserted.push(request)
      await assert(request)
    },
    async () => {
      throw new Error("events_list does not read the status")
    },
  )
  const spec = specs.find((candidate) => candidate.name === "events_list")!
  const call: Call = {
    host: { sessionID: "ses_collect", agent: "build", messageID: "msg_1", id: "call_1" },
    runtime: { sessionId: "ses_collect", agentId: "build", signal: new AbortController().signal },
  }
  /** events_list as the tool and the RPC method run it: the input schema, then the spec. */
  const list = async (input: Input): Promise<EventsListResult> => (await spec.run(parse(spec.input, input), call)).output as EventsListResult
  return { runtime, asserted, spec, list }
}

const ids = (result: EventsListResult) => result.events.map((event) => event.external_id)

describe("gws_events_list keeps the shared contract", () => {
  it("passes the conformance check over the synthetic mailbox, page by page", async () => {
    const { list } = await harness()
    await assertEventsListConformance(list, { source: GMAIL_SOURCE, account: "personal", owner: OWNER, since: SINCE, expected: LISTED })
  })

  it("passes it one event a page, with the default account", async () => {
    const { list } = await harness()
    await assertEventsListConformance(list, { source: GMAIL_SOURCE, owner: OWNER, since: SINCE, expected: LISTED, pageSize: 1 })
  })

  it("states the contract's limits in its schemas", () => {
    const input = z.toJSONSchema(EventsListInput, { io: "input" }) as { properties: Record<string, { maximum?: number; minimum?: number; maxLength?: number }> }
    expect(input.properties["limit"]).toMatchObject({ minimum: PAGE.min, maximum: PAGE.max })
    expect(input.properties["cursor"]).toMatchObject({ maxLength: EVENT_LIMITS.cursor })
    const output = z.toJSONSchema(EventsListOutput, { io: "output" }) as unknown as { properties: { events: { items: { properties: Record<string, { maxLength?: number; maxItems?: number }> } } } }
    const event = output.properties.events.items.properties
    expect(event["text"]?.maxLength).toBe(EVENT_LIMITS.text)
    expect(event["title"]?.maxLength).toBe(EVENT_LIMITS.title)
    expect(event["actors"]?.maxItems).toBe(EVENT_LIMITS.actors)
    expect(event["labels"]?.maxItems).toBe(EVENT_LIMITS.labels)
  })
})

describe("the events", () => {
  it("makes one event per message, without noise, quoted replies or signatures, and an untrusted result the host accepts", async () => {
    const { spec, list } = await harness()
    const result = await list({ since: SINCE })
    expect(resultProblems(result)).toEqual([])
    expect(spec.output.safeParse(result).success).toBe(true)
    expect(result).toMatchObject({ owner: OWNER, more: false, trust: "untrusted" })
    expect(ids(result)).toEqual(LISTED)
    const [ask, reply, build, lunch] = result.events
    expect(ask).toMatchObject({
      source: "gmail",
      account: "personal",
      kind: "message",
      occurred_at: "2026-11-01T09:00:00.000Z",
      thread: "gmail-thread:18f0000000000001",
      url: "https://mail.google.com/mail/u/0/#all/18f0000000000001",
      title: "Q4 numbers",
      text: "Hi Sam,\n\nCan you send the Q4 numbers by Friday? Finance needs them for the board pack.\n\nThanks,\nAma",
      actors: [
        { role: "from", id: "mailto:ama.mensah@example.com", name: "Ama Mensah" },
        { role: "to", id: "mailto:sam.rivera@example.com", name: "Sam Rivera" },
        { role: "cc", id: "mailto:jordan.lee@example.org", name: "Lee, Jordan" },
      ],
      labels: ["inbox", "important", "personal", "unread"],
    })
    expect(reply).toMatchObject({
      thread: "gmail-thread:18f0000000000001",
      text: "Yes, I'll send them Wednesday.",
      labels: ["sent"],
      actors: [
        { role: "from", id: "mailto:sam.rivera@example.com", name: "Sam Rivera" },
        { role: "to", id: "mailto:ama.mensah@example.com" },
        { role: "bcc", id: "mailto:records@example.com" },
      ],
    })
    expect(build).toMatchObject({ title: "Build passed", text: "The build on main passed & deployed to staging.\nDuration: 4 min", labels: ["inbox", "updates"] })
    expect(lunch).toMatchObject({ text: "Free for lunch on Thursday? I'll book a table & send the address.", labels: ["inbox", "starred"] })
    // Spam, trash, drafts, Promotions and Social never become events, and nothing from before since does.
    expect(JSON.stringify(result)).not.toMatch(/Ignore previous instructions|50% off|tagged|Not sent yet|Last week/)
  })

  it("asserts gws.events_list and gws.read on each Gmail read before any of them runs", async () => {
    const { asserted, list } = await harness()
    await list({ since: SINCE, limit: 1 })
    expect(asserted.map((request) => [request.action, request.resources])).toEqual([
      ["gws.events_list", ["personal:gmail.users.history.list"]],
      ...EVENT_READS.map((operation) => ["gws.read", [`personal:${operation}`]]),
    ])
    expect(asserted.every((request) => request.source?.type === "tool")).toBe(true)

    const log = join(dir, "argv.log")
    process.env["FAKE_GWS_LOG"] = log
    writeFileSync(log, "")
    const refused = await harness({}, async (request) => {
      if (request.action === "gws.read" && request.resources[0] === "personal:gmail.users.messages.get") throw new Error("denied by rule")
    })
    await expect(refused.list({ since: SINCE })).rejects.toThrow("denied by rule")
    expect(readFileSync(log, "utf8")).not.toContain('"gmail"')
  })
})

describe("after the first listing", () => {
  it("follows Gmail's history from where the search began, a record's messages one by one, skipping noise", async () => {
    const { list } = await harness()
    const first = await list({ since: SINCE })
    deliver([
      { id: "18f0000000000010", at: "2026-11-02T09:00:00Z" },
      { id: "18f0000000000011", at: "2026-11-02T09:05:00Z", labels: ["INBOX", "CATEGORY_PROMOTIONS"] },
      { id: "18f0000000000012", at: "2026-11-02T09:10:00Z" },
      { id: "18f0000000000013", at: "2026-11-02T09:11:00Z", together: true },
    ])
    const second = await list({ cursor: first.cursor, limit: 2 })
    expect(ids(second)).toEqual(["18f0000000000010", "18f0000000000012"])
    expect(second.more).toBe(true)
    const third = await list({ cursor: second.cursor, limit: 2 })
    expect(ids(third)).toEqual(["18f0000000000013"])
    expect(third.more).toBe(false)
    expect(await list({ cursor: third.cursor })).toMatchObject({ events: [], more: false })
    // The second cursor, used again, lists the same page again.
    expect(ids(await list({ cursor: second.cursor, limit: 2 }))).toEqual(["18f0000000000013"])
  })

  it("skips a message deleted after its history record", async () => {
    const { list } = await harness()
    const first = await list({ since: SINCE })
    deliver([{ id: "18f0000000000020", at: "2026-11-02T09:00:00Z" }, { id: "18f0000000000021", at: "2026-11-02T09:01:00Z" }])
    const box = mailbox()
    save({ ...box, messages: box.messages.filter((message) => message.id !== "18f0000000000020") })
    const next = await list({ cursor: first.cursor })
    expect(ids(next)).toEqual(["18f0000000000021"])
    expect(await list({ cursor: next.cursor })).toMatchObject({ events: [], more: false })
  })

  it("searches again from the last event when Gmail no longer keeps the history id", async () => {
    const { list } = await harness()
    const first = await list({ since: SINCE })
    deliver([{ id: "18f0000000000030", at: "2026-11-03T09:00:00Z" }])
    save({ ...mailbox(), historyStart: mailbox().historyId })
    const next = await list({ cursor: first.cursor })
    // The last event already listed may come again; Memory drops the repeat.
    expect(ids(next).filter((id) => id !== "18f0000000000008")).toEqual(["18f0000000000030"])
    expect(next.more).toBe(false)
    expect(await list({ cursor: next.cursor })).toMatchObject({ events: [], more: false })
  })
})

describe("accounts and cursors", () => {
  const two = { accounts: { personal: account(), work: account() } }

  it("needs an account when several are configured, and names it on every event", async () => {
    const { list } = await harness(two)
    await expect(list({ since: SINCE })).rejects.toThrow(/^ACCOUNT_REQUIRED:/)
    const work = await list({ since: SINCE, account: "work" })
    expect(work.events.every((event) => event.account === "work")).toBe(true)
    await expect(list({ since: SINCE, account: "home" })).rejects.toThrow(/^ACCOUNT_UNKNOWN:/)
  })

  it("refuses another account's cursor, one from another mailbox, and another source's", async () => {
    const { list } = await harness(two)
    const personal = await list({ since: SINCE, account: "personal" })
    await expect(list({ cursor: personal.cursor, account: "work" })).rejects.toThrow(/^CURSOR_INVALID:/)
    save({ ...mailbox(), emailAddress: "someone.else@example.com" })
    await expect(list({ cursor: personal.cursor, account: "personal" })).rejects.toThrow(/^CURSOR_INVALID:/)
    await expect(list({ cursor: encodeCursor("history", { a: "personal" }), account: "personal" })).rejects.toThrow(/^CURSOR_INVALID:/)
  })

  it("refuses a since without a zone or that is not a time, naming the field", async () => {
    const { list } = await harness()
    await expect(list({ since: "2026-11-01T09:00" })).rejects.toThrow(/^GWS_VALIDATION_ERROR: Since: must be an ISO date/)
    await expect(list({ since: "2026-13-01" })).rejects.toThrow(/^GWS_VALIDATION_ERROR: "since"/)
  })
})
