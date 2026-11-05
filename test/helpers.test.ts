import { execFileSync } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { helperAdapter } from "../src/domain/helpers.js"
import { loadManifest, resolveHelper } from "../src/domain/manifest.js"
import { resolvePackagedBinary } from "../src/process/binary.js"
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
      const lines = readFileSync(log, "utf8").split("\n").filter(Boolean)
      // A reply also reads the message it answers, to show and check its recipients.
      const ran = lines.filter((line) => line.split(" ")[1]?.startsWith("+"))
      expect(lines.some((line) => line.startsWith("gmail users messages get ")), id).toBe(id.startsWith("gmail.reply"))
      expect(ran, id).toHaveLength(1)
      expect(ran[0]!.endsWith(" --dry-run"), id).toBe(true)
      const plan = runtime!.inspectPlan(planned.category, { planId: planned.planId }, call)
      expect(plan.argv, id).not.toContain("--dry-run")
      expect([...plan.argv, "--dry-run"].join(" "), id).toBe(ran[0])
    }
  })
})

describe("helper adapters match gws's own flags", () => {
  /** Flags the plugin sets itself or never offers: --dry-run (plans), --format on sends (JSON receipts), --sanitize (Model Armor), --help. */
  const PLUGIN_OWNED = new Set(["dry-run", "sanitize", "help"])
  const SEND_HELPERS = new Set(["gmail.send", "gmail.reply", "gmail.reply-all", "gmail.forward"])
  /** Adapter keys that are not the flag's camelCase. */
  const RENAMED: Record<string, string> = { attach: "attachments" }

  /** A proxy nothing listens on: a gws that reaches for the network fails at once instead of depending on Google. */
  const NO_NETWORK = Object.fromEntries(["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy", "ALL_PROXY"].map((key) => [key, "http://127.0.0.1:9"]))
  /** The Discovery version gws loads for each helper service; the workflow helpers load none. */
  const DISCOVERY: Record<string, string> = { gmail: "v1", calendar: "v3", sheets: "v4" }

  /**
   * gws reads Discovery from `<config dir>/cache/<service>_<version>.json`
   * while the file is fresh, and a helper's flags are gws's own code, so an
   * empty document gives the same --help as Google's. Written now, it is fresh.
   */
  function offlineConfig(home: string): string {
    const dir = join(home, "gws")
    mkdirSync(join(dir, "cache"), { recursive: true })
    for (const [name, version] of Object.entries(DISCOVERY)) {
      const doc = { kind: "discovery#restDescription", name, version, rootUrl: `https://${name}.googleapis.com/`, servicePath: "", resources: {} }
      writeFileSync(join(dir, "cache", `${name}_${version}.json`), JSON.stringify(doc))
    }
    return dir
  }

  it.each(adaptedHelpers())("%s takes every flag gws 0.22.5 has for it", (id) => {
    const [service, name] = id.split(".") as [string, string]
    const home = mkdtempSync(join(tmpdir(), "gws-help-"))
    try {
      const env = { HOME: home, PATH: "", GOOGLE_WORKSPACE_CLI_CONFIG_DIR: offlineConfig(home), ...NO_NETWORK }
      const help = execFileSync(resolvePackagedBinary(), [service, `+${name}`, "--help"], { env, encoding: "utf8" })
      // Option lines only: the flag, its value name, then its description after two or more spaces.
      const flags = [...new Set([...help.matchAll(/^\s+(?:-\w, )?--([a-z-]+)(?: <[^>]+>)? {2,}\S/gm)].map((match) => match[1]!))]
      const expected = flags
        .filter((flag) => !PLUGIN_OWNED.has(flag) && !(flag === "format" && SEND_HELPERS.has(id)))
        .map((flag) => RENAMED[flag] ?? flag.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase()))
      const shape = (helperAdapter(id)!.inputSchema as unknown as { shape: Record<string, unknown> }).shape
      expect(Object.keys(shape).sort()).toEqual(expected.sort())
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
