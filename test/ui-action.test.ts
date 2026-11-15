import { generateKeyPairSync, randomBytes, sign } from "node:crypto"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import * as z from "zod"
import { Audit } from "../src/domain/audit.js"
import { previewText, UI_CHANGE_INPUT, UI_CHANGE_OUTPUT, UI_PREVIEW_MAX_CHARS, UI_PREVIEW_OUTPUT, uiChange } from "../src/domain/ui-action.js"
import { PACKAGE_NAME } from "../src/domain/version.js"
import { ACTION_KEY_SYMBOL, type ActionPublicKey, actionInputDigest, publishedActionKey } from "../src/host/action-grant.js"
import { JellyRpc, registerJellyRpc } from "../src/host/jelly-rpc.js"
import { uiAction } from "../src/host/ui-action.js"
import type { Runtime } from "../src/runtime/index.js"
import { account, testConfig, testRuntime } from "./support/config.js"

/**
 * Jelly's `commit` action: the one change a person may approve from a UI an agent made (a Sheets value update), with
 * gws's own plan as its every-time preview (hey-jelly `protocol/contracts/src/plugin-actions.ts`,
 * `backend/opencode/src/action-grant.ts`, `backend/host/src/plugin-actions/service.ts`). Each refusal below is one
 * guard: remove it and its test fails.
 */

const OPERATION = "sheets.spreadsheets.values.update"
const CHANGE = {
  account: "personal",
  operation: OPERATION,
  params: { spreadsheetId: "sheet-1", range: "Invoices!D2:D3", valueInputOption: "RAW" },
  body: { values: [["Paid"], ["Paid"]] },
}
const ANSWER = { spreadsheetId: "sheet-1", updatedRange: "Invoices!D2:D3", updatedRows: 2, updatedColumns: 1, updatedCells: 2 }

/** Jelly's host action key, as a test holds it: the public half for the plugin, the private half to sign grants. */
function hostKey() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519")
  const jwk = publicKey.export({ format: "jwk" }) as { x: string }
  const key: ActionPublicKey = { kid: "host-key-1", jwk: { kty: "OKP", crv: "Ed25519", x: jwk.x } }
  const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url")
  /** A grant as Jelly's host signs one (`backend/host/src/plugin-actions/key.ts`), with any claim overridden. */
  const grant = (input: unknown, claims: Record<string, unknown> = {}) => {
    const iat = Math.floor(Date.now() / 1000)
    const head = b64({ alg: "EdDSA", typ: "jelly-act+jwt", kid: key.kid })
    const body = b64({
      iss: "host-1",
      aud: `${PACKAGE_NAME}#engine`,
      act: "commit",
      in: actionInputDigest(input),
      dev: "dev_1",
      mbr: "acc_person1",
      cls: "local",
      cfm: "always",
      iat,
      exp: iat + 60,
      jti: randomBytes(16).toString("base64url"),
      ...claims,
    })
    return `${head}.${body}.${sign(null, Buffer.from(`${head}.${body}`), privateKey).toString("base64url")}`
  }
  return { key, grant }
}

const runtimes: Runtime[] = []
const dirs: string[] = []
afterEach(async () => {
  delete process.env["FAKE_GWS_RESPONSES"]
  delete process.env["FAKE_GWS_LOG"]
  for (const runtime of runtimes.splice(0)) await runtime.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "gws-ui-action-"))
  dirs.push(dir)
  return dir
}

async function setup(overrides: Record<string, unknown> = {}) {
  const dir = scratch()
  const auditPath = join(dir, "audit.jsonl")
  const log = join(dir, "argv.jsonl")
  writeFileSync(log, "")
  process.env["FAKE_GWS_LOG"] = log
  process.env["FAKE_GWS_RESPONSES"] = JSON.stringify({ [OPERATION]: ANSWER })
  const runtime = await testRuntime({
    accounts: { personal: account({ services: ["sheets"], access: "write" }) },
    uiActions: [OPERATION],
    audit: { enabled: true, path: auditPath },
    ...overrides,
  })
  runtimes.push(runtime)
  const host = hostKey()
  const planned: string[] = []
  const ui = uiAction(runtime, { key: () => host.key, planned: (text) => planned.push(text) })
  const ran = () =>
    readFileSync(log, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string[])
      .filter((argv) => argv[0] === "sheets")
  const audited = async (count: number) => {
    await vi.waitFor(() => expect(readFileSync(auditPath, "utf8").trim().split("\n").filter(Boolean).length).toBeGreaterThanOrEqual(count), { timeout: 5000 })
    return readFileSync(auditPath, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>)
  }
  return { runtime, host, ui, planned, ran, audited }
}

describe("the option", () => {
  it("is empty by default, takes only the Sheets value update, and refuses any other operation id", () => {
    expect(testConfig().uiActions).toEqual([])
    expect(testConfig({ uiActions: [OPERATION] }).uiActions).toEqual([OPERATION])
    expect(() => testConfig({ uiActions: ["gmail.users.messages.send"] })).toThrow(/^OPTIONS_INVALID: .*uiActions/)
    expect(() => testConfig({ uiActions: true })).toThrow(/^OPTIONS_INVALID: .*uiActions/)
  })

  it("off (the default): the preview and the commit are refused, and nothing runs", async () => {
    const { host, ui, ran, audited } = await setup({ uiActions: undefined })
    await expect(ui.preview(CHANGE)).rejects.toThrow(/^UI_ACTION_OFF: /)
    await expect(ui.commit({ input: CHANGE, grant: host.grant(CHANGE) })).rejects.toThrow(/^UI_ACTION_OFF: /)
    expect(ran()).toEqual([])
    expect((await audited(1)).at(-1)).toMatchObject({ event: "ui.act", outcome: "denied", errorCode: "UI_ACTION_OFF", caller: "person", member: "acc_person1" })
  })
})

describe("access", () => {
  it("read-only: the preview and the commit are refused, whichever surface asks", async () => {
    const { host, ui, ran } = await setup({ access: "read-only" })
    await expect(ui.preview(CHANGE)).rejects.toThrow(/^UI_ACTION_REFUSED: Access is read-only/)
    await expect(ui.commit({ input: CHANGE, grant: host.grant(CHANGE) })).rejects.toThrow(/^UI_ACTION_REFUSED: Access is read-only/)
    expect(ran()).toEqual([])
  })

  it("ask-changes: the person's every-time confirmation is the ask, so the change runs", async () => {
    const { host, ui } = await setup({ access: "ask-changes" })
    await expect(ui.commit({ input: CHANGE, grant: host.grant(CHANGE) })).resolves.toMatchObject({ updatedCells: 2 })
  })
})

describe("the grant", () => {
  it("a grant for a different input is refused, and nothing runs", async () => {
    const { host, ui, ran } = await setup()
    const other = { ...CHANGE, params: { ...CHANGE.params, spreadsheetId: "attacker-sheet" } }
    await expect(ui.commit({ input: other, grant: host.grant(CHANGE) })).rejects.toThrow(/^UI_GRANT_REFUSED: The grant is for another input\./)
    expect(ran()).toEqual([])
  })

  it("a grant is used once", async () => {
    const { host, ui, ran } = await setup()
    const grant = host.grant(CHANGE)
    await ui.commit({ input: CHANGE, grant })
    const commits = ran().filter((argv) => !argv.includes("--dry-run")).length
    await expect(ui.commit({ input: CHANGE, grant })).rejects.toThrow(/^UI_GRANT_REFUSED: The grant was used already\./)
    expect(ran().filter((argv) => !argv.includes("--dry-run")).length).toBe(commits)
  })

  it("no grant, no Jelly key, another key, another action or plugin, a paired device's class, or an expired grant: refused", async () => {
    const { host, ui, runtime } = await setup()
    await expect(ui.commit({ input: CHANGE })).rejects.toThrow(/^UI_GRANT_REFUSED: The call carries no grant\./)
    await expect(ui.commit({ input: CHANGE, grant: hostKey().grant(CHANGE) })).rejects.toThrow(/^UI_GRANT_REFUSED: The grant's signature is not the host's\./)
    await expect(ui.commit({ input: CHANGE, grant: host.grant(CHANGE, { act: "other" }) })).rejects.toThrow(/another action/)
    await expect(ui.commit({ input: CHANGE, grant: host.grant(CHANGE, { aud: "@someone/else#engine" }) })).rejects.toThrow(/another plugin/)
    await expect(ui.commit({ input: CHANGE, grant: host.grant(CHANGE, { cls: "chat" }) })).rejects.toThrow(/^UI_GRANT_REFUSED: The grant is not from an owner device\./)
    const old = Math.floor(Date.now() / 1000) - 600
    await expect(ui.commit({ input: CHANGE, grant: host.grant(CHANGE, { iat: old, exp: old + 60 }) })).rejects.toThrow(/expired/)
    // Stock OpenCode, a script or an agent: no key Jelly published in this engine, so nothing acts.
    expect(publishedActionKey({})).toBeUndefined()
    const bare = uiAction(runtime)
    expect((globalThis as Record<symbol, unknown>)[ACTION_KEY_SYMBOL]).toBeUndefined()
    await expect(bare.commit({ input: CHANGE, grant: host.grant(CHANGE) })).rejects.toThrow(/^UI_GRANT_REFUSED: Jelly handed this engine no action key\./)
  })

  it("a grant whose confirmation (cfm) is not always is refused before any Google call", async () => {
    const { host, ui, ran } = await setup()
    for (const cfm of [undefined, "never", "session"]) {
      await expect(ui.commit({ input: CHANGE, grant: host.grant(CHANGE, { cfm }) })).rejects.toThrow(/^UI_GRANT_REFUSED: The grant does not say the person confirmed this change\./)
    }
    await expect(ui.commit({ input: CHANGE, grant: host.grant(CHANGE, { cfm: "twice" }) })).rejects.toThrow(/^UI_GRANT_REFUSED: The grant's confirmation is not one\./)
    expect(ran()).toEqual([])
    await expect(ui.commit({ input: CHANGE, grant: host.grant(CHANGE, { cfm: "always" }) })).resolves.toMatchObject({ updatedCells: 2 })
  })
})

describe("what a UI may ask for", () => {
  it("any operation but a Sheets value update is refused, even with a valid grant for it", async () => {
    const { host, ui, ran } = await setup()
    for (const operation of ["sheets.spreadsheets.values.clear", "gmail.users.messages.send", "drive.permissions.create", "sheets.spreadsheets.values.batchUpdate"]) {
      const input = { ...CHANGE, operation }
      await expect(ui.preview(input)).rejects.toThrow(/^UI_ACTION_REFUSED: A UI may ask only for a Sheets value update/)
      await expect(ui.commit({ input, grant: host.grant(input) })).rejects.toThrow(/^UI_ACTION_REFUSED: A UI may ask only for a Sheets value update/)
    }
    expect(ran()).toEqual([])
  })

  it("formulas (USER_ENTERED), extra fields and oversized changes are refused", async () => {
    const { host, ui } = await setup()
    const entered = { ...CHANGE, params: { ...CHANGE.params, valueInputOption: "USER_ENTERED" } }
    await expect(ui.commit({ input: entered, grant: host.grant(entered) })).rejects.toThrow(/^UI_ACTION_REFUSED: The change is not the shape/)
    const extra = { ...CHANGE, params: { ...CHANGE.params, includeValuesInResponse: true } }
    await expect(ui.preview(extra)).rejects.toThrow(/^UI_ACTION_REFUSED: The change is not the shape/)
    const noAccount = { operation: OPERATION, params: CHANGE.params, body: CHANGE.body }
    await expect(ui.preview(noAccount)).rejects.toThrow(/^UI_ACTION_REFUSED: The change is not the shape/)
    // Fits the shape, but its words would not fit Jelly's confirmation: refused, never cut short.
    const wide = { ...CHANGE, body: { values: Array.from({ length: 100 }, () => Array.from({ length: 2 }, () => "x".repeat(40))) } }
    await expect(ui.preview(wide)).rejects.toThrow(/^UI_ACTION_REFUSED: The preview of this change is \d+ characters, more than the 4000/)
    await expect(ui.commit({ input: wide, grant: host.grant(wide) })).rejects.toThrow(/^UI_ACTION_REFUSED: The preview of this change/)
  })

  it("gws's own policy still decides: a deny rule refuses the change", async () => {
    const { host, ui, ran } = await setup({ policy: { rules: [{ id: "no-sheet-writes", effect: "deny", services: ["sheets"], categories: ["write"] }] } })
    await expect(ui.preview(CHANGE)).rejects.toThrow(/^POLICY_DENIED: /)
    await expect(ui.commit({ input: CHANGE, grant: host.grant(CHANGE) })).rejects.toThrow(/^POLICY_DENIED: /)
    expect(ran().filter((argv) => !argv.includes("--dry-run"))).toEqual([])
  })
})

describe("the preview and the commit", () => {
  it("the preview is the plan the commit then runs, and the commit answers what Google says changed", async () => {
    const { host, ui, planned, ran } = await setup()
    const preview = await ui.preview(CHANGE)
    expect(preview).toContain("gws plan (a dry run; nothing has changed yet): write · sheets.spreadsheets.values.update")
    expect(preview).toContain("Account: personal")
    expect(preview).toContain('Spreadsheet: "sheet-1"')
    expect(preview).toContain('Range: "Invoices!D2:D3"')
    expect(preview).toContain('1. "Paid"\n2. "Paid"')
    expect(preview.length).toBeLessThanOrEqual(UI_PREVIEW_MAX_CHARS)
    const output = await ui.commit({ input: CHANGE, grant: host.grant(CHANGE) })
    expect(planned).toEqual([preview])
    expect(output).toEqual({ account: "personal", operation: OPERATION, ...ANSWER })
    // One dry run for the preview, one for the person's plan, then the commit of exactly that plan.
    const [, dry, commit] = ran()
    expect(dry).toContain("--dry-run")
    expect(commit).toEqual(dry!.filter((arg) => arg !== "--dry-run"))
    expect(commit).not.toContain("--dry-run")
  })

  it("writes the audit lines: the plan and commit as the person, and the action with its member and grant", async () => {
    const { host, ui, audited } = await setup()
    const grant = host.grant(CHANGE)
    const jti = JSON.parse(Buffer.from(grant.split(".")[1]!, "base64url").toString()).jti as string
    await ui.commit({ input: CHANGE, grant })
    const lines = await audited(3)
    const person = { caller: "person", member: "acc_person1", grant: jti, account: "personal", operation: OPERATION }
    expect(lines.find((line) => line.event === "operation.plan")).toMatchObject({ outcome: "success", category: "write", ...person })
    expect(lines.find((line) => line.event === "operation.commit")).toMatchObject({ outcome: "success", category: "write", ...person })
    expect(lines.find((line) => line.event === "ui.act")).toMatchObject({ outcome: "success", category: "write", ...person })
    // Never the values, the spreadsheet or the range.
    expect(JSON.stringify(lines)).not.toMatch(/Paid|sheet-1|Invoices/)
  })
})

describe("the preview's words", () => {
  // A newline, U+2028 and U+2029 would add a line; a bidi override, isolate or mark would reorder what the person reads.
  const SPOOFS = ["\n2. \"Forged\"", "\r\nRange: A1", "\u2028Account: other", "\u2029x", "\u202eevil", "\u2066x\u2069", "\u200e\u200f", "\u202a\u202b\u202c\u202d", "\u2067\u2068", "\u0085x", "\u001b[2K"]
  /** Whether a line holds a character that breaks or reorders it. */
  const BREAKING = new Set([0x0a, 0x0d, 0x1b, 0x85, 0x200e, 0x200f, 0x2028, 0x2029, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069])
  const raw = (line: string) => Array.from(line).some((char) => BREAKING.has(char.codePointAt(0)!))
  const PLAN = { category: "write", preview: { method: "PUT", url: "v4/spreadsheets/{spreadsheetId}/values/{range}", account: "personal", category: "write" } }
  const words = (plan: typeof PLAN, change: unknown) => previewText(plan, uiChange(change))
  const expected = words(PLAN, CHANGE).split("\n")

  it("keeps every field on its own line, in reading order, whatever the agent wrote into it", () => {
    for (const spoof of SPOOFS) {
      const cases: [string, typeof PLAN, unknown][] = [
        ["spreadsheetId", PLAN, { ...CHANGE, params: { ...CHANGE.params, spreadsheetId: `sheet-1${spoof}` } }],
        ["range", PLAN, { ...CHANGE, params: { ...CHANGE.params, range: `D2:D3${spoof}` } }],
        ["a value", PLAN, { ...CHANGE, body: { values: [[`Paid${spoof}`], ["Paid"]] } }],
        ["account", { ...PLAN, preview: { ...PLAN.preview, account: `personal${spoof}` } }, CHANGE],
        ["method", { ...PLAN, preview: { ...PLAN.preview, method: `PUT${spoof}` } }, CHANGE],
        ["address", { ...PLAN, preview: { ...PLAN.preview, url: `v4/x${spoof}` } }, CHANGE],
        ["category", { ...PLAN, category: `write${spoof}` }, CHANGE],
      ]
      for (const [field, plan, change] of cases) {
        const text = words(plan, change)
        const lines = text.split("\n")
        expect(lines.length, `${field} with ${JSON.stringify(spoof)}`).toBe(expected.length)
        expect(lines.filter(raw), `${field} with ${JSON.stringify(spoof)}`).toEqual([])
        // Each line still says what it said, in the same order; only the field that carried the spoof differs.
        expect(lines.map((line) => line.split(":")[0]!.split(" ")[0])).toEqual(expected.map((line) => line.split(":")[0]!.split(" ")[0]))
      }
    }
  })

  it("quotes the spreadsheet and the range, and shows a hidden character as a visible escape", () => {
    const text = words(PLAN, { ...CHANGE, params: { ...CHANGE.params, spreadsheetId: "a\u202eb", range: "A1\nRange: Z9" } })
    expect(text).toContain('Spreadsheet: "a\\u202eb"')
    expect(text).toContain('Range: "A1\\nRange: Z9"')
    expect(text.split("\n").filter((line) => line.startsWith("Range:"))).toHaveLength(1)
  })
})

describe("on the package's RPC", () => {
  it("registers act.commit and plan.preview beside Jelly's reads, and answers a refusal as the declared error", async () => {
    const { runtime } = await setup()
    const handlers: Record<string, (input: unknown, context: unknown) => Promise<unknown>> = {}
    const ctx = {
      rpc: {
        register: async (_contract: unknown, given: typeof handlers) => {
          Object.assign(handlers, given)
          return { dispose: async () => {} }
        },
      },
    }
    // No `ui.key`: the key Jelly publishes in the engine, and there is none here.
    await registerJellyRpc(ctx as never, runtime)
    const context = { signal: new AbortController().signal, error: (type: string, message: string, data: unknown) => ({ type, message, data }) }
    expect(await handlers["act.commit"]!({ input: CHANGE, grant: hostKey().grant(CHANGE) }, context)).toEqual({
      type: "failed",
      message: expect.stringMatching(/^UI_GRANT_REFUSED: Jelly handed this engine no action key\./),
      data: { code: "UI_GRANT_REFUSED", next: expect.any(String) },
    })
    expect(await handlers["plan.preview"]!(CHANGE, context)).toEqual(expect.stringContaining('Range: "Invoices!D2:D3"'))
  })
})

describe("the audit sink", () => {
  it("keeps a member and a grant id only for a person's call", async () => {
    const lines: string[] = []
    const sink = new Audit({ enabled: true, path: "unused" }, "test", async (line) => {
      lines.push(line)
    })
    const grant = "g".repeat(22)
    sink.emit({ event: "ui.act", outcome: "success", caller: "person", member: "acc_1", grant })
    sink.emit({ event: "operation.commit", outcome: "success", caller: "rpc", member: "acc_1", grant })
    sink.emit({ event: "ui.act", outcome: "denied", caller: "person", member: "not a member!", grant: "short" })
    await vi.waitFor(() => expect(lines).toHaveLength(3), { timeout: 5000 })
    const [person, script, bad] = lines.map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(person).toMatchObject({ event: "ui.act", caller: "person", member: "acc_1", grant })
    expect(script).toMatchObject({ caller: "rpc" })
    expect(script).not.toHaveProperty("member")
    expect(bad).not.toHaveProperty("member")
    expect(bad).not.toHaveProperty("grant")
  })
})

describe("the declaration", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    files: string[]
    jelly: {
      tools: { name: string; permission: string; readOnly?: boolean }[]
      rpc: { name: string; permission: string; readOnly?: boolean; input: unknown; output: unknown }[]
      views: { id: string; page?: string; grants: string[] }[]
      actions: Record<string, unknown>[]
    }
  }
  const jelly = pkg.jelly
  const action = jelly.actions[0] as {
    name: string
    preview: string
    summary: string[]
    views: string[]
    tool: string
    input: { properties: Record<string, unknown> }
    output: unknown
  }

  it("declares one plan-shaped action: a person's, from an owner device, confirmed every time with gws's preview", () => {
    expect(jelly.actions).toHaveLength(1)
    expect(action).toMatchObject({
      name: "commit",
      label: "update cells in your Google Sheets",
      target: "engine",
      class: "local",
      confirm: "always",
      preview: "plan.preview",
      summary: ["account", "params"],
      views: ["ui-changes"],
      ui: true,
      tool: "gws.write",
    })
    // Jelly's `{count}` is the rows picked, not the cells changed: no `done`, so the receipt says the label.
    expect(action).not.toHaveProperty("done")
    expect(action).not.toHaveProperty("personOnly")
    expect(action.input).toEqual(UI_CHANGE_INPUT)
    expect(action.output).toEqual(UI_CHANGE_OUTPUT)
    expect(jelly.rpc.find((method) => method.name === "plan.preview")).toEqual({
      name: "plan.preview",
      label: "preview a change you approve",
      permission: "gws.plan",
      readOnly: true,
      input: UI_CHANGE_INPUT,
      output: UI_PREVIEW_OUTPUT,
    })
  })

  it("registers the schemas it declares, with no pattern (OpenCode refuses every call to one)", () => {
    const methods = JellyRpc.methods as Record<string, { input: unknown; output: unknown }>
    expect(methods["plan.preview"]).toMatchObject({ input: UI_CHANGE_INPUT, output: UI_PREVIEW_OUTPUT })
    expect(methods["act.commit"]?.output).toEqual(UI_CHANGE_OUTPUT)
    expect(JSON.stringify([UI_CHANGE_INPUT, UI_CHANGE_OUTPUT, UI_PREVIEW_OUTPUT])).not.toContain('"pattern"')
  })

  it("passes Jelly's action rules (hey-jelly plugin-actions.light.ts actionIssues and plugin-contract.ts, ported)", () => {
    const id = /^[a-zA-Z][a-zA-Z0-9._-]{0,127}$/
    const pages = new Set(jelly.views.filter((view) => view.page !== undefined).map((view) => view.id))
    const preview = jelly.rpc.find((method) => method.name === action.preview)
    expect(id.test(action.name)).toBe(true)
    expect(preview?.readOnly).toBe(true)
    expect(action.summary.length).toBeLessThanOrEqual(4)
    for (const field of action.summary) expect(Object.keys(action.input.properties)).toContain(field)
    expect(action.views.length).toBeGreaterThanOrEqual(1)
    for (const view of action.views) expect(pages.has(view)).toBe(true)
    expect(jelly.tools.map((tool) => tool.name)).toContain(action.tool)
    expect(jelly.rpc.filter((method) => method.name.startsWith("act."))).toEqual([])
    // The preview reads under a declared tool permission.
    expect(jelly.tools.map((tool) => tool.permission)).toContain(preview?.permission)
    // Jelly checks inputs with zod's fromJSONSchema (hey-jelly protocol/contracts/src/json-schema.ts).
    const check = z.fromJSONSchema(UI_CHANGE_INPUT as never)
    expect(check.safeParse(CHANGE).success).toBe(true)
    expect(check.safeParse({ ...CHANGE, operation: "gmail.users.messages.send" }).success).toBe(false)
    expect(check.safeParse({ ...CHANGE, params: { ...CHANGE.params, valueInputOption: "USER_ENTERED" } }).success).toBe(false)
    expect(z.fromJSONSchema(UI_CHANGE_OUTPUT as never).safeParse({ account: "personal", operation: OPERATION, ...ANSWER }).success).toBe(true)
  })

  it("its page is a minimal one with no grants, shipped in the package, that never calls the action", () => {
    const view = jelly.views.find((each) => each.id === "ui-changes")
    expect(view).toEqual({ v: 1, id: "ui-changes", place: "settings-section", title: "Changes from agent UIs", page: "views/ui-changes.html", grants: [] })
    expect(pkg.files).toContain("views/ui-changes.html")
    const page = readFileSync(new URL("../views/ui-changes.html", import.meta.url), "utf8")
    const helper = readFileSync(new URL("../views/jelly-view.js", import.meta.url), "utf8").trimEnd()
    expect(page).toContain(helper)
    expect(page).not.toMatch(/act\.call|view\.call\(|<script[^>]+src=|<link\b|\bfetch\(|\bimport\(|url\(|XMLHttpRequest|WebSocket|localStorage|innerHTML/)
  })
})
