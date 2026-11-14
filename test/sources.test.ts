import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import type { PluginMethod, ToolCall } from "@we-the-rebel-alliance/source-contract/tools-rpc"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { deprecatedNote, markCalendarTodayCalled, resetDeprecated } from "../src/host/deprecated.js"
import type { PermissionRequest } from "../src/host/permissions.js"
import { scriptMethods } from "../src/host/script-methods.js"
import { IMAGE_DATA_URI_MAX } from "../src/host/sources.js"
import type { Runtime } from "../src/runtime/index.js"
import { account, testRuntime } from "./support/config.js"

/**
 * The source contract's reads that are tools RPC methods only, beyond what the conformance kit proves
 * (test/source-conformance.test.ts): probe's refusals and scopes, events_list's Calendar source across syncs,
 * calendar_today's and images_read's limits, and the deprecation of Jelly's old calendar.today.
 */

const CALENDAR = fileURLToPath(new URL("./fixtures/calendar-events.json", import.meta.url))
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])
const GIF = Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0])
const DRIVE_LINK = "https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUvWxYz/view"

let dir: string
const runtimes: Runtime[] = []

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "opencode-gws-sources-"))
})

afterEach(async () => {
  for (const name of ["FAKE_GWS_CALENDAR", "FAKE_GWS_RESPONSES", "FAKE_GWS_OUTPUT_FILE"]) delete process.env[name]
  for (const runtime of runtimes.splice(0)) await runtime.close()
  rmSync(dir, { recursive: true, force: true })
  resetDeprecated()
})

type Signed = { alias: string; connected: boolean; email?: string; grantedScopes?: string[] }

async function harness(services: string[], signedIn: Signed[] = [{ alias: "personal", connected: true, email: "sam.rivera@example.com", grantedScopes: [] }]) {
  const runtime = await testRuntime({ accounts: { personal: account({ services }) } })
  runtimes.push(runtime)
  const asserted: PermissionRequest[] = []
  const methods = scriptMethods({
    runtime,
    status: (async () => ({ accounts: signedIn })) as never,
    assert: async (request) => {
      asserted.push(request)
    },
  }) as PluginMethod[]
  const call = (): ToolCall => ({ sessionID: "ses_sources", agent: "build", messageID: "msg_sources", id: "call_sources", signal: new AbortController().signal, progress: async () => {} })
  const run = (name: string, input: unknown) => methods.find((method) => method.name === name)!.run(input, call()) as Promise<Record<string, unknown>>
  return { run, asserted }
}

describe("probe", () => {
  it("names the owner from the verified sign-in, with only that source's scopes, and asserts gws.probe alone", async () => {
    const { run, asserted } = await harness(["gmail", "calendar"], [
      {
        alias: "personal",
        connected: true,
        email: "sam.rivera@example.com",
        grantedScopes: ["openid", "https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/calendar.readonly", "https://www.googleapis.com/auth/calendar.events.readonly"],
      },
    ])
    expect(await run("probe", { source: "calendar" })).toEqual({
      source: "calendar",
      account: "personal",
      owner: { id: "mailto:sam.rivera@example.com", label: "sam.rivera@example.com" },
      scopes: ["https://www.googleapis.com/auth/calendar.readonly", "https://www.googleapis.com/auth/calendar.events.readonly"],
      trust: "untrusted",
    })
    expect(await run("probe", {})).toMatchObject({ source: "gmail", scopes: ["https://www.googleapis.com/auth/gmail.readonly"] })
    expect(asserted.map((request) => [request.action, request.resources])).toEqual([
      ["gws.probe", ["*"]],
      ["gws.probe", ["*"]],
    ])
  })

  it("refuses an account with no verified email, a source it does not know, any other input, and a service the account does not enable", async () => {
    const { run } = await harness(["gmail"], [{ alias: "personal", connected: true }])
    await expect(run("probe", { source: "gmail" })).rejects.toThrow(/^AUTH_REQUIRED: The account 'personal' has no verified sign-in email/)
    await expect(run("probe", { source: "drive" })).rejects.toThrow(/^SOURCE_UNKNOWN: /)
    await expect(run("probe", { source: "gmail", limit: 0 })).rejects.toThrow(/^INPUT_INVALID: "limit" is not an input of probe/)
    await expect(run("probe", { source: "calendar" })).rejects.toThrow(/^POLICY_DENIED: /)
  })
})

describe("events_list for Calendar", () => {
  it("syncs in full, then follows the sync token, with a cancellation as a meeting with the cancelled label, and refuses a cursor of another calendar", async () => {
    const calendar = join(dir, "calendar.json")
    copyFileSync(CALENDAR, calendar)
    process.env["FAKE_GWS_CALENDAR"] = calendar
    const { run, asserted } = await harness(["calendar"])
    const first = await run("events_list", { source: "calendar", since: "2026-11-01T00:00:00Z" })
    expect(first).toMatchObject({ source: "calendar", account: "personal", owner: { id: "mailto:sam.rivera@example.com", label: "Sam Rivera" }, scope: { calendars: ["primary"] }, more: false })
    const events = first["events"] as Array<{ external_id: string; labels: string[]; actors: unknown[] }>
    // A cancellation happens when it was cancelled: evt-b was cancelled before evt-a starts.
    expect(events.map((event) => event.external_id)).toEqual(["evt-b", "evt-a", "evt-c"])
    expect(events[0]).toMatchObject({ labels: ["cancelled"], actors: [] })
    expect(first["refused"]).toEqual([{ external_id: "evt-secret", reason: "secret", detail: "holds a secret (password)" }])
    expect(asserted.slice(0, 3).map((request) => [request.action, request.resources])).toEqual([
      ["gws.events_list", ["personal:calendar.events.list"]],
      ["gws.read", ["personal:calendar.calendarList.get"]],
      ["gws.read", ["personal:calendar.events.list"]],
    ])
    const next = await run("events_list", { source: "calendar", cursor: first["cursor"] })
    expect(next).toMatchObject({ events: [], more: false })
    // The same cursor read for the primary calendar named by its id is another binding.
    await expect(run("events_list", { source: "calendar", cursor: first["cursor"], scope: { calendars: ["sam.rivera@example.com"] } })).rejects.toThrow(/^CURSOR_INVALID: /)
  })
})

describe("calendar_today", () => {
  it("answers today's agenda with titles and locations cut to the output's 120 characters", async () => {
    const now = Date.now()
    process.env["FAKE_GWS_RESPONSES"] = JSON.stringify({
      "calendar.calendars.get": { timeZone: "UTC" },
      "calendar.events.list": {
        items: [{ id: "evt-long", status: "confirmed", summary: "T".repeat(180), location: "L".repeat(150), start: { dateTime: new Date(now - 60_000).toISOString() }, end: { dateTime: new Date(now + 60_000).toISOString() } }],
      },
    })
    const { run, asserted } = await harness(["calendar"])
    const answer = await run("calendar_today", { source: "calendar-today" })
    const [item] = (answer["data"] as { items: Array<{ title: string; location: string }> }).items
    expect(item?.title).toHaveLength(120)
    expect(item?.location).toHaveLength(120)
    expect(answer).toMatchObject({ account: "personal", trust: "untrusted" })
    expect(asserted.map((request) => request.action)).toEqual(["gws.calendar_today", "gws.read", "gws.read"])
    await expect(run("calendar_today", { source: "calendar" })).rejects.toThrow(/^INPUT_INVALID: "source" must be "calendar-today"/)
  })
})

describe("images_read", () => {
  it("refuses a GIF, which the image output does not take", async () => {
    const picture = join(dir, "picture.gif")
    writeFileSync(picture, GIF)
    process.env["FAKE_GWS_OUTPUT_FILE"] = picture
    process.env["FAKE_GWS_RESPONSES"] = JSON.stringify({ "drive.files.get": { mimeType: "image/gif", size: String(GIF.length) } })
    const { run } = await harness(["drive"])
    await expect(run("images_read", { url: DRIVE_LINK, account: "personal" })).rejects.toThrow(/^IMAGE_TYPE_REFUSED: /)
  })

  it("answers TOO_LARGE for a picture whose data URI is over the output's limit, rather than cutting it", async () => {
    const big = new Uint8Array(Math.ceil((IMAGE_DATA_URI_MAX * 3) / 4))
    big.set(PNG)
    const picture = join(dir, "picture.png")
    writeFileSync(picture, big)
    process.env["FAKE_GWS_OUTPUT_FILE"] = picture
    process.env["FAKE_GWS_RESPONSES"] = JSON.stringify({ "drive.files.get": { mimeType: "image/png", size: String(big.length) } })
    const { run, asserted } = await harness(["drive"])
    await expect(run("images_read", { url: DRIVE_LINK, account: "personal" })).rejects.toThrow(/^TOO_LARGE: /)
    expect(asserted.map((request) => [request.action, request.resources])).toEqual([
      ["gws.images_read", ["*"]],
      ["gws.read", ["personal:drive.files.get"]],
    ])
  })
})

describe("Jelly's calendar.today", () => {
  it("is named in status once it is called, with the method to use instead", () => {
    expect(deprecatedNote()).toBeUndefined()
    markCalendarTodayCalled()
    expect(deprecatedNote()).toBe(
      "Deprecated method called: calendar.today on @joe-broadhead/opencode-gws. Use calendar_today on google-workspace.gws.tools instead; the old method works until 0.1.0.",
    )
  })
})
