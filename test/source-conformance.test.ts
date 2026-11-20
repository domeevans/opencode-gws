import { createHash } from "node:crypto"
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { type ConformanceReport, type SourceConformanceOptions, assertDeclaration, sourceConformance } from "@we-the-rebel-alliance/source-contract/conformance"
import { encodeBoundCursor } from "@we-the-rebel-alliance/source-contract/cursor"
import { readInstalledDescriptor } from "@we-the-rebel-alliance/source-contract/descriptor"
import { acceptAnswer } from "@we-the-rebel-alliance/source-contract/read"
import { SOURCES_SCHEMA } from "@we-the-rebel-alliance/source-contract/schema"
import { IMAGE_DATA_URI_MAX as REGISTRY_IMAGE_DATA_URI_MAX } from "@we-the-rebel-alliance/source-contract/registry"
import type { PluginMethod, ToolCall } from "@we-the-rebel-alliance/source-contract/tools-rpc"
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest"
import type { PermissionRequest } from "../src/host/permissions.js"
import { scriptMethods } from "../src/host/script-methods.js"
import { SHEET_OUTPUT_SCHEMA, SHEETS_MAX_BYTES } from "../src/host/sheets.js"
import { IMAGE_DATA_URI_MAX } from "../src/host/sources.js"
import type { Runtime } from "../src/runtime/index.js"
import { account, testRuntime } from "./support/config.js"

/**
 * The source contract's conformance kit (`@we-the-rebel-alliance/source-contract` v0.2.0, `conformance`) over the
 * declaration this package ships (`package.json` `sources`) and the plugin's real reads: each kit call runs the tools RPC
 * method a consumer calls (`events_list`, `probe`, `calendar_today`, `images_read`, `sheets_read`) through `scriptMethods`, with the
 * kit's recording permission as the host's assert, so declared equals asserted is proven on the code. Google is the
 * fake gws answering from recorded, synthetic fixtures (test/fixtures/gmail-mailbox.json, calendar-events.json and the
 * responses below); nothing reaches the network and no fixture holds account data.
 *
 * Every snapshot answer is also passed through the contract's `read.acceptAnswer`, as a consumer accepts it: the
 * output schema (`agenda`, `image`, and `gws.sheets`' inline `x-gws/sheet`), `asOf`, the account, `trust` and `maxBytes`. The kit's report for every source is
 * written to reports/conformance-report.json, the file a release attaches.
 */

const ROOT = fileURLToPath(new URL("../", import.meta.url))
const REPORT = join(ROOT, "reports", "conformance-report.json")
const MAILBOX = fileURLToPath(new URL("./fixtures/gmail-mailbox.json", import.meta.url))
const CALENDAR = fileURLToPath(new URL("./fixtures/calendar-events.json", import.meta.url))
const ACCOUNT = "personal"
const ADDRESS = "sam.rivera@example.com"
const SINCE = "2026-11-01T00:00:00Z"
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
const DRIVE_LINK = "https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUvWxYz/view"

const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { name: string; version: string; sources: { items: Array<{ id: string }> } }
const contract = JSON.parse(readFileSync(join(ROOT, "node_modules/@we-the-rebel-alliance/source-contract/package.json"), "utf8")) as { version: string }

type Assert = SourceConformanceOptions["calls"]["probe"] extends (input: never, context: infer C) => unknown ? C : never

let dir: string
const runtimes: Runtime[] = []
const reports: ConformanceReport[] = []

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "opencode-gws-conformance-"))
})

afterEach(async () => {
  for (const name of ["FAKE_GWS_MAILBOX", "FAKE_GWS_CALENDAR", "FAKE_GWS_RESPONSES", "FAKE_GWS_OUTPUT_FILE"]) delete process.env[name]
  for (const runtime of runtimes.splice(0)) await runtime.close()
  rmSync(dir, { recursive: true, force: true })
})

afterAll(() => {
  if (reports.length === 0) return
  mkdirSync(join(ROOT, "reports"), { recursive: true })
  const ok = reports.length === pkg.sources.items.length && reports.every((report) => report.ok)
  writeFileSync(REPORT, `${JSON.stringify({ plugin: pkg.name, version: pkg.version, contract: contract.version, ok, sources: reports }, null, 2)}\n`)
})

/** The installed declaration, as a consumer reads it from disk: validated and hashed. */
async function installed() {
  const read = await readInstalledDescriptor(ROOT, { version: pkg.version })
  if (!read.ok) throw new Error(read.problems.join("; "))
  return read.value
}

/** A source as the consumer's `read` takes it (the descriptor's frame), and as the kit takes it (Memory's schema). */
async function sourceOf(id: string) {
  const descriptor = await installed()
  const checked = SOURCES_SCHEMA.check(descriptor.sources)
  if (!checked.ok) throw new Error(checked.problems.join("; "))
  return { frame: descriptor.sources.items.find((item) => item.id === id)!, item: checked.value.items.find((item) => item.id === id)! }
}

/** The account's sign-in, as status reports it: verified email and granted scopes. */
const status = async () => ({
  accounts: [
    {
      alias: ACCOUNT,
      connected: true,
      email: ADDRESS,
      grantedScopes: [
        "openid",
        "https://www.googleapis.com/auth/userinfo.email",
        "https://www.googleapis.com/auth/gmail.readonly",
        "https://www.googleapis.com/auth/calendar.readonly",
        "https://www.googleapis.com/auth/drive.readonly",
        "https://www.googleapis.com/auth/spreadsheets.readonly",
      ],
    },
  ],
})

/**
 * The tools RPC methods over a fresh runtime, and the kit's calls for one source: each call runs the method as a
 * consumer's `read` calls it, with the source's `input` and the account, under the kit's recording permission.
 */
async function harness(services: string[]) {
  const runtime = await testRuntime({ accounts: { [ACCOUNT]: account({ services }) } })
  runtimes.push(runtime)
  let permission: Assert["permission"] | undefined
  const methods = scriptMethods({
    runtime,
    status: status as never,
    assert: async (request: PermissionRequest) => {
      if (permission === undefined) throw new Error("an assert ran outside a kit call")
      await permission.assert({ action: request.action, resources: request.resources })
    },
  }) as PluginMethod[]
  const call = (): ToolCall => ({ sessionID: "ses_conformance", agent: "build", messageID: "msg_conformance", id: "call_conformance", signal: new AbortController().signal, progress: async () => {} })
  const run = async (name: string, input: Readonly<Record<string, unknown>>, context: Assert): Promise<unknown> => {
    permission = context.permission
    try {
      return await methods.find((method) => method.name === name)!.run(input, call())
    } finally {
      permission = undefined
    }
  }
  const tools = methods.map((method) => ({ id: method.name, readOnly: method.class === "read" }))
  return { run, tools }
}

/** The kit's report for `id`, kept for the report file. */
async function conform(options: Omit<SourceConformanceOptions, "plugin" | "sources" | "account">): Promise<ConformanceReport> {
  const descriptor = await installed()
  const report = await sourceConformance({
    plugin: pkg.name,
    account: ACCOUNT,
    sources: { rpc: descriptor.sources.rpc, probe: descriptor.sources.probe },
    describe: { id: "google-workspace.gws.tools" },
    ...options,
  })
  reports.push(report)
  return report
}

const problemsOf = (report: ConformanceReport) => ({ problems: report.problems, incomplete: report.checks.filter((check) => !check.ran && !check.notApplicable).map((check) => check.name) })

describe("the declaration", () => {
  it("validates as a consumer reads it from the installed package, and names only read tools", async () => {
    const { tools } = await harness(["gmail"])
    const descriptor = await installed()
    expect(descriptor.sources.items.map((item) => item.id)).toEqual(["gws.gmail", "gws.calendar", "gws.calendar.today", "gws.image", "gws.sheets"])
    expect(() => assertDeclaration(descriptor.sources, { tools })).not.toThrow()
    expect(descriptor.sources.rpc).toBe("google-workspace.gws.tools")
  })

  it("keeps the image output's limit equal to the contract's registry", () => {
    expect(IMAGE_DATA_URI_MAX).toBe(REGISTRY_IMAGE_DATA_URI_MAX)
  })
})

describe("the conformance kit", () => {
  it("passes for gws.gmail: a page, a refused secret, a failed message that holds the cursor, an expired history and a foreign cursor", async () => {
    const box = join(dir, "mailbox.json")
    copyFileSync(MAILBOX, box)
    process.env["FAKE_GWS_MAILBOX"] = box
    const { run, tools } = await harness(["gmail"])
    const { item: source } = await sourceOf("gws.gmail")
    const free = { permission: { assert: async () => {} } } as unknown as Assert
    // A cursor from before three more messages arrived: one holds a secret, one Google fails to answer.
    const before = (await run("events_list", { source: "gmail", account: ACCOUNT, since: SINCE }, free)) as { cursor: string }
    deliver(box, [
      { id: "18f0000000000040", at: "2026-10-30T09:00:00Z", subject: "Office wifi", body: "The guest wifi password: Ku7pLm2QzR9w" },
      { id: "18f0000000000050", at: "2026-10-30T09:01:00Z", subject: "Agenda", body: "Two items." },
      { id: "18f0000000000051", at: "2026-10-30T09:02:00Z", subject: "Minutes", body: "Both items done." },
    ])
    const mailbox = JSON.parse(readFileSync(box, "utf8")) as Record<string, unknown>
    writeFileSync(box, JSON.stringify({ ...mailbox, historyStart: "5", failIds: ["18f0000000000050"] }))
    // A cursor whose history Gmail no longer keeps (record 2, below historyStart).
    const mailboxDigest = createHash("sha256").update(ADDRESS).digest("hex").slice(0, 16)
    const expired = encodeBoundCursor({ plugin: "gws", source: "gmail", account: ACCOUNT, scope: {} }, { a: ACCOUNT, o: mailboxDigest, p: "h", h: "2", n: 0, t: Date.parse(SINCE) })
    const report = await conform({
      source,
      tools,
      calls: {
        list: (input, context) => run("events_list", { ...source.input, account: ACCOUNT, ...input }, context),
        probe: (input, context) => run("probe", input, context),
      },
      cases: [
        { name: "the first listing", input: { source: "gmail", account: ACCOUNT, since: SINCE, limit: 500 }, expect: "page" },
        { name: "a secret refused, a failed message holding the cursor back", input: { source: "gmail", account: ACCOUNT, cursor: before.cursor }, expect: "page" },
        { name: "a cursor whose history Gmail no longer keeps", input: { source: "gmail", account: ACCOUNT, cursor: expired }, expect: "expired" },
        { name: "a cursor this source did not issue", input: { source: "gmail", account: ACCOUNT, cursor: "another-plugin-cursor" }, expect: { refuses: "CURSOR_INVALID" } },
      ],
    })
    expect(problemsOf(report)).toEqual({ problems: [], incomplete: [] })
    expect(report.ok).toBe(true)
  }, 60_000)

  it("passes for gws.calendar: a window with a refused secret, a cancellation, and atomic pages", async () => {
    const calendar = join(dir, "calendar.json")
    copyFileSync(CALENDAR, calendar)
    process.env["FAKE_GWS_CALENDAR"] = calendar
    const { run, tools } = await harness(["calendar"])
    const { item: source } = await sourceOf("gws.calendar")
    const report = await conform({
      source,
      tools,
      calls: {
        list: (input, context) => run("events_list", { ...source.input, account: ACCOUNT, ...input }, context),
        probe: (input, context) => run("probe", input, context),
      },
      cases: [
        { name: "the first window", input: { source: "calendar", account: ACCOUNT, since: SINCE, limit: 500 }, expect: "page" },
        { name: "another person's calendar", input: { source: "calendar", account: ACCOUNT, scope: { calendars: ["someone.else@example.com"] } }, expect: { refuses: "INPUT_INVALID" } },
      ],
      atomicPages: { reason: "calendar.events.list answers a whole page in one provider call, so no single event can fail on its own" },
      noExpiry: { reason: "the cursor names a bounded window, never a Google sync token, so it cannot expire" },
    })
    expect(problemsOf(report)).toEqual({ problems: [], incomplete: [] })
  }, 60_000)

  it("passes for gws.calendar.today, whose answer a consumer accepts as an agenda", async () => {
    const now = Date.now()
    process.env["FAKE_GWS_RESPONSES"] = JSON.stringify({
      "calendar.calendars.get": { timeZone: "Europe/London" },
      "calendar.events.list": {
        items: [
          {
            id: "evt-standup",
            status: "confirmed",
            summary: "Standup",
            start: { dateTime: new Date(now - 60_000).toISOString() },
            end: { dateTime: new Date(now + 15 * 60_000).toISOString() },
            location: "Room 3",
            htmlLink: "https://www.google.com/calendar/event?eid=evt-standup",
            hangoutLink: "https://meet.google.com/abc-defg-hij",
          },
        ],
      },
    })
    const { run, tools } = await harness(["calendar"])
    const { item: source, frame } = await sourceOf("gws.calendar.today")
    const accepted: unknown[] = []
    const report = await conform({
      source,
      tools,
      calls: {
        probe: (input, context) => run("probe", input, context),
        snapshot: async (input, context) => {
          const answer = await run("calendar_today", { ...source.input, account: ACCOUNT, ...input }, context)
          const outcome = acceptAnswer(frame, ACCOUNT, answer)
          if (!outcome.ok) throw new Error(`${outcome.failure.code}: ${outcome.failure.message}`)
          accepted.push(outcome)
          return answer
        },
      },
      snapshotCases: [{}],
    })
    expect(problemsOf(report)).toEqual({ problems: [], incomplete: [] })
    expect(accepted).toMatchObject([{ kind: "snapshot", snapshot: { data: { items: [{ id: "evt-standup", title: "Standup", location: "Room 3", joinUrl: "https://meet.google.com/abc-defg-hij" }] }, trust: "untrusted" } }])
  }, 60_000)

  it("passes for gws.image, whose answer a consumer accepts as an image", async () => {
    const picture = join(dir, "picture.png")
    writeFileSync(picture, PNG)
    process.env["FAKE_GWS_OUTPUT_FILE"] = picture
    process.env["FAKE_GWS_RESPONSES"] = JSON.stringify({ "drive.files.get": { mimeType: "image/png", size: String(PNG.length) } })
    const { run, tools } = await harness(["drive"])
    const { item: source, frame } = await sourceOf("gws.image")
    const accepted: unknown[] = []
    const report = await conform({
      source,
      tools,
      calls: {
        probe: (input, context) => run("probe", input, context),
        snapshot: async (input, context) => {
          const answer = await run("images_read", { ...source.input, account: ACCOUNT, ...input }, context)
          const outcome = acceptAnswer(frame, ACCOUNT, answer)
          if (!outcome.ok) throw new Error(`${outcome.failure.code}: ${outcome.failure.message}`)
          accepted.push(outcome)
          return answer
        },
      },
      snapshotCases: [{ url: DRIVE_LINK }],
    })
    expect(problemsOf(report)).toEqual({ problems: [], incomplete: [] })
    expect(accepted).toMatchObject([{ kind: "snapshot", snapshot: { data: { dataUri: `data:image/png;base64,${Buffer.from(PNG).toString("base64")}` } } }])
  }, 60_000)
})

/** A spreadsheet's range as Google answers values.get. */
const SHEET_ID = "1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms"

describe("gws.sheets", () => {
  it("is not private, and its permission is values.get alone", async () => {
    const { frame } = await sourceOf("gws.sheets")
    expect(frame).toMatchObject({ kind: "snapshot", tool: "sheets_read", output: "x-gws/sheet", private: false, maxBytes: SHEETS_MAX_BYTES, permission: { tool: "gws.sheets_read", operations: ["sheets.spreadsheets.values.get"] } })
  })

  it("keeps the declared output schema equal to the one the code documents", async () => {
    const { frame } = await sourceOf("gws.sheets")
    expect((frame as { outputSchema?: unknown }).outputSchema).toEqual(SHEET_OUTPUT_SCHEMA)
  })

  it("passes the conformance kit, and a consumer accepts its answer as an x-gws/sheet", async () => {
    process.env["FAKE_GWS_RESPONSES"] = JSON.stringify({
      "sheets.spreadsheets.values.get": { range: "Budget!A1:B3", majorDimension: "ROWS", values: [["Item", "Cost"], ["Venue", "1,200.00"], ["Food", "450.00"]] },
    })
    const { run, tools } = await harness(["sheets"])
    const { item: source, frame } = await sourceOf("gws.sheets")
    const accepted: unknown[] = []
    const report = await conform({
      source,
      tools,
      calls: {
        probe: (input, context) => run("probe", input, context),
        snapshot: async (input, context) => {
          const answer = await run("sheets_read", { ...source.input, account: ACCOUNT, ...input }, context)
          const outcome = acceptAnswer(frame, ACCOUNT, answer)
          if (!outcome.ok) throw new Error(`${outcome.failure.code}: ${outcome.failure.message}`)
          accepted.push(outcome)
          return answer
        },
      },
      snapshotCases: [{ spreadsheetId: SHEET_ID, range: "Budget!A1:B3" }],
    })
    expect(problemsOf(report)).toEqual({ problems: [], incomplete: [] })
    expect(accepted).toMatchObject([{ kind: "snapshot", snapshot: { data: { range: "Budget!A1:B3", sheet: "Budget", rows: [["Item", "Cost"], ["Venue", "1,200.00"], ["Food", "450.00"]] } } }])
  }, 60_000)

  it("is refused by a consumer when its answer breaks the output schema", async () => {
    const { frame } = await sourceOf("gws.sheets")
    const outcome = acceptAnswer(frame, ACCOUNT, { data: { range: "A1", rows: [[{ formula: "=1" }]] }, asOf: new Date().toISOString(), account: ACCOUNT, trust: "untrusted" })
    expect(outcome.ok).toBe(false)
  })
})

/** Mail that arrives after a listing, as history records: one message each, with a subject and a plain body. */
function deliver(path: string, messages: Array<{ id: string; at: string; subject: string; body: string }>): void {
  const box = JSON.parse(readFileSync(path, "utf8")) as { historyId: string; messages: unknown[]; history: unknown[] }
  let next = BigInt(box.historyId)
  for (const message of messages) {
    box.messages.push({
      id: message.id,
      threadId: message.id,
      labelIds: ["INBOX"],
      snippet: message.body,
      internalDate: String(Date.parse(message.at)),
      payload: {
        mimeType: "text/plain",
        headers: [
          { name: "From", value: "Ama Mensah <ama.mensah@example.com>" },
          { name: "To", value: `Sam Rivera <${ADDRESS}>` },
          { name: "Subject", value: message.subject },
        ],
        body: { data: Buffer.from(message.body).toString("base64url") },
      },
    })
    box.history.push({ id: String(++next), messagesAdded: [{ message: { id: message.id, threadId: message.id, labelIds: ["INBOX"] } }] })
  }
  box.historyId = String(next)
  writeFileSync(path, JSON.stringify(box))
}
