import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { helperAdapter } from "../src/domain/helpers.js"
import { loadManifest, resolveHelper } from "../src/domain/manifest.js"
import type { Runtime } from "../src/runtime/index.js"
import { testRuntime } from "./support/config.js"
import { request as requestFor } from "./support/requests.js"

const request = requestFor("gmail.send", { input: {} })

/** Manifest helpers that have an adapter, sorted. */
function adaptedHelpers(): string[] {
  return loadManifest().services.flatMap((service) => service.helpers).map((helper) => helper.id).filter((id) => helperAdapter(id) !== undefined).sort()
}

const NEW_HELPER_IDS = [
  "calendar.agenda",
  "sheets.read",
  "workflow.meeting-prep",
  "workflow.standup-report",
  "workflow.weekly-digest",
]

interface BuildCase {
  id: string
  input: Record<string, unknown>
  argv: string[]
  category: string
}

const buildCases: BuildCase[] = [
  {
    id: "calendar.agenda",
    input: { week: true, calendar: "Work", timezone: "America/New_York", format: "table" },
    argv: ["calendar", "+agenda", "--week", "--calendar", "Work", "--timezone", "America/New_York", "--format", "table"],
    category: "read",
  },
  {
    id: "sheets.read",
    input: { spreadsheet: "sheet-1", range: "Sheet1!A1:B2" },
    argv: ["sheets", "+read", "--spreadsheet", "sheet-1", "--range", "Sheet1!A1:B2"],
    category: "read",
  },
  {
    id: "workflow.meeting-prep",
    input: { calendar: "Work", format: "table" },
    argv: ["workflow", "+meeting-prep", "--calendar", "Work", "--format", "table"],
    category: "read",
  },
  {
    id: "workflow.standup-report",
    input: { format: "table" },
    argv: ["workflow", "+standup-report", "--format", "table"],
    category: "read",
  },
  {
    id: "workflow.weekly-digest",
    input: {},
    argv: ["workflow", "+weekly-digest"],
    category: "read",
  },
]

const invalidCases: Array<{ id: string; input: Record<string, unknown>; message: RegExp }> = [
  { id: "calendar.agenda", input: { days: 0 }, message: /days/ },
  { id: "sheets.read", input: { spreadsheet: "sheet-1" }, message: /range/ },
  { id: "workflow.meeting-prep", input: { calendar: 42 }, message: /calendar/ },
  { id: "workflow.standup-report", input: { extra: true }, message: /extra/ },
  { id: "workflow.weekly-digest", input: { format: "xml" }, message: /format/ },
]

describe("gws helpers", () => {
  it("builds the real +send command", () => {
    const built = helperAdapter("gmail.send")!.build(
      { to: "alice@example.com", subject: "Hello", body: "Hi", cc: "bob@example.com" },
      request,
    )
    expect(built.argv).toEqual([
      "gmail",
      "+send",
      "--to",
      "alice@example.com",
      "--subject",
      "Hello",
      "--body",
      "Hi",
      "--cc",
      "bob@example.com",
    ])
    expect(built.category).toBe("send")
    expect(built.preview.recipients).toEqual(["alice@example.com", "bob@example.com"])
  })

  it("builds +read with headers", () => {
    const built = helperAdapter("gmail.read")!.build({ id: "abc", headers: true }, request)
    expect(built.argv).toEqual(["gmail", "+read", "--id", "abc", "--headers"])
  })

  it("builds +reply with a draft flag", () => {
    const built = helperAdapter("gmail.reply")!.build({ messageId: "m1", body: "thanks", draft: true }, request)
    expect(built.argv).toEqual(["gmail", "+reply", "--message-id", "m1", "--body", "thanks", "--draft"])
  })

  it("has no adapter for a cataloged but unimplemented helper", () => {
    expect(helperAdapter("gmail.watch")).toBeUndefined()
  })
})

describe("helper adapter coverage", () => {
  it("exposes exactly the implemented helper ids", () => {
    expect(adaptedHelpers()).toEqual([...NEW_HELPER_IDS, "gmail.forward", "gmail.read", "gmail.reply", "gmail.reply-all", "gmail.send", "gmail.triage"].sort())
  })

  it("leaves reserved and unsupported helpers failing closed", () => {
    for (const id of ["gmail.watch", "events.subscribe", "events.renew", "script.push", "drive.upload", "modelarmor.sanitize-prompt"]) {
      expect(helperAdapter(id), id).toBeUndefined()
    }
  })

  it("matches the manifest service and category for every adapter", () => {
    for (const id of adaptedHelpers()) {
      const adapter = helperAdapter(id)!
      const entry = resolveHelper(id)
      expect(entry, id).toBeDefined()
      expect(adapter.service, id).toBe(entry!.service)
      expect(adapter.category, id).toBe(entry!.category)
    }
  })
})

describe("new helper adapters", () => {
  for (const testCase of buildCases) {
    it(`${testCase.id} builds argv and declares ${testCase.category}`, () => {
      const adapter = helperAdapter(testCase.id)
      expect(adapter, testCase.id).toBeDefined()
      const built = adapter!.build(testCase.input, requestFor(testCase.id, { input: testCase.input }))
      expect(built.argv).toEqual(testCase.argv)
      expect(built.category).toBe(testCase.category)
      expect(adapter!.category).toBe(testCase.category)
      expect(built.preview.category).toBe(testCase.category)
      expect(built.preview.account).toBe("personal")
    })
  }

  for (const testCase of invalidCases) {
    it(`${testCase.id} rejects invalid input`, () => {
      expect(() => helperAdapter(testCase.id)!.build(testCase.input, request)).toThrow(testCase.message)
    })
  }
})

describe("helper input edge cases", () => {
  it("stages gmail attachments and refuses relative attachment paths", () => {
    expect(() =>
      helperAdapter("gmail.send")!.build({ to: "a@example.com", subject: "s", body: "b", attachments: ["notes.txt"] }, request),
    ).toThrow(/path must be absolute/)
    const built = helperAdapter("gmail.send")!.build(
      { to: "a@example.com", subject: "s", body: "b", attachments: ["/data/a/notes.txt", "/data/b/notes.txt"] },
      request,
    )
    expect(built.argv.join(" ")).toContain("-a in/0/notes.txt -a in/1/notes.txt")
    expect(built.argv.join(" ")).not.toContain("/data/")
    expect(built.files!.inputs.map((file) => file.source)).toEqual(["/data/a/notes.txt", "/data/b/notes.txt"])
  })
})

describe("helper preview redaction", () => {
  const cases: Array<{ id: string; input: Record<string, unknown>; secret: string }> = [
    { id: "gmail.send", input: { to: "a@example.com", subject: "s", body: "confidential mail body" }, secret: "confidential mail body" },
    { id: "gmail.reply", input: { messageId: "m1", body: "confidential reply" }, secret: "confidential reply" },
    { id: "gmail.reply-all", input: { messageId: "m1", body: "confidential reply all" }, secret: "confidential reply all" },
    { id: "gmail.forward", input: { messageId: "m1", to: "b@example.com", body: "confidential note" }, secret: "confidential note" },
  ]

  for (const testCase of cases) {
    it(`${testCase.id} does not put body content in the preview`, () => {
      const built = helperAdapter(testCase.id)!.build(testCase.input, request)
      expect(JSON.stringify(built.preview)).not.toContain(testCase.secret)
      expect(built.preview.bodySummary).toMatch(/^\d+ bytes$/)
    })
  }
})

describe("helper planning", () => {
  // One valid input per non-read adapter: a new mutating adapter needs a case here.
  const samples: Record<string, Record<string, unknown>> = {
    "gmail.forward": { messageId: "m1", to: "bob@example.com" },
    "gmail.reply": { messageId: "m1", body: "thanks" },
    "gmail.reply-all": { messageId: "m1", body: "thanks" },
    "gmail.send": { to: "alice@example.com", subject: "s", body: "b" },
  }
  const call = { sessionId: "ses_1", agentId: "build" }
  // The fake gws lives under the repo: binary trust rejects world-writable ancestors such as /tmp.
  let dir: string
  let log: string
  let runtime: Runtime | undefined

  beforeAll(async () => {
    dir = mkdtempSync(join(process.cwd(), ".helpers-test-"))
    log = join(dir, "argv.log")
    const binary = join(dir, "gws")
    writeFileSync(binary, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "gws 0.22.5"; exit 0; fi\nprintf '%s\\n' "$*" >> '${log}'\nprintf '{"dryRun":true}'\n`)
    chmodSync(binary, 0o755)
    runtime = await testRuntime({ binary: { path: binary } })
  })

  afterAll(async () => {
    await runtime?.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it("refuses invalid helper input with GWS_VALIDATION_ERROR before gws runs", async () => {
    writeFileSync(log, "")
    await expect(runtime!.read(requestFor("gmail.read", { input: {} }), call)).rejects.toThrow(
      /^GWS_VALIDATION_ERROR: 'gmail\.read' input: id: .+ Next step: Fix the input; gws_schema with operation "gmail\.read" shows its flags\.$/,
    )
    expect(() => runtime!.inspect(requestFor("gmail.forward", { input: { messageId: "m1" } }), "plan")).toThrow(/^GWS_VALIDATION_ERROR: 'gmail\.forward' input: to: /)
    await expect(runtime!.plan(requestFor("gmail.send", { input: { to: "alice@example.com", extra: true } }), call)).rejects.toThrow(/^GWS_VALIDATION_ERROR: 'gmail\.send' input: /)
    expect(readFileSync(log, "utf8")).toBe("")
  })

  it("plans every non-read adapter with --dry-run and stores the commit argv without it", async () => {
    const mutating = adaptedHelpers().filter((id) => helperAdapter(id)!.category !== "read")
    expect(mutating).toEqual(Object.keys(samples).sort())
    for (const id of mutating) {
      writeFileSync(log, "")
      const planned = await runtime!.plan(requestFor(id, { input: samples[id] }), call)
      const ran = readFileSync(log, "utf8").split("\n").filter(Boolean)
      expect(ran, id).toHaveLength(1)
      expect(ran[0]!.endsWith(" --dry-run"), id).toBe(true)
      const plan = runtime!.inspectPlan(planned.category, { planId: planned.planId }, call)
      expect(plan.argv, id).not.toContain("--dry-run")
      expect([...plan.argv, "--dry-run"].join(" "), id).toBe(ran[0])
    }
  })
})
