import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Rpc } from "@opencode/plugin/rpc"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { request } from "../support/requests.js"
import { startHost, type Harness } from "./harness.js"

/**
 * `rpcCommits: true`: a host that confirms each change on its own screen lets a script commit. The six commit tools
 * become methods, each run through its own spec as the model's commit tool runs it: the plan stays single-use and
 * bound to its session, and a commit is audited with `caller: "rpc"`. Its own file, because one embedded host per
 * process is all the SDK supports.
 */

const READS = ["status", "catalog", "schema", "read", "plan", "events_list"]
const COMMIT_CLASSES = { write: "write", send: "send", share: "send", delete: "destructive", export: "export", admin: "destructive" } as const

// The client side only names the methods: the plugin checks each input against the tool's own contract.
const open = {}
const Tools = Rpc.define({
  id: "google-workspace.gws.tools",
  methods: {
    describe: { input: open, output: open },
    ...Object.fromEntries([...READS, ...Object.keys(COMMIT_CLASSES)].map((name) => [name, { input: open, output: open, errors: { failed: open } }])),
  },
  events: {},
})

let host: Harness
let auditDir: string
let auditPath: string
const sessions: Record<string, string> = {}

beforeAll(async () => {
  auditDir = mkdtempSync(join(tmpdir(), "gws-rpc-commits-audit-"))
  auditPath = join(auditDir, "audit.jsonl")
  host = await startHost({ options: { rpcCommits: true, audit: { enabled: true, path: auditPath } } })
  const create = async () => (await host.opencode.sessions.create({ location: host.location, agent: "build" } as never)).id
  sessions.a = await create()
  sessions.b = await create()
}, 120_000)

afterAll(async () => {
  await host?.close()
  rmSync(auditDir, { recursive: true, force: true })
})

/** The method's result, or the declared error's `{ type, code, message }`. */
async function run(method: string, session: string, input: unknown): Promise<Record<string, any>> {
  const tools = host.opencode.rpc(Tools) as unknown as Record<string, (input: unknown, options: unknown) => Promise<unknown>>
  try {
    return { value: await tools[method]!({ sessionID: session, input }, { location: host.location }) }
  } catch (error) {
    const e = error as Record<string, any>
    return { type: e.type ?? e._tag, code: e.data?.code, message: String(e.message ?? e) }
  }
}

/** The gws calls that change something: not a dry run, and not the reads a reply's commit makes again to check its recipients. */
const commits = () => host.invocations().filter((argv) => !argv.includes("--dry-run") && !argv.includes("get") && !argv.includes("getProfile"))
const asked = () => host.events.filter((event) => event.type === "permission.asked")

async function plan(session: string, input: unknown): Promise<Record<string, any>> {
  const planned = await run("plan", session, input)
  expect(planned.value, planned.message).toMatchObject({ ok: true, planId: expect.any(String) })
  return planned.value
}

const reply = () => request("gmail.reply", { input: { messageId: "m-1", body: "Thanks, see you then." } })
const markRead = () => request("gmail.users.threads.modify", { params: { userId: "me", id: "t-1" }, body: { removeLabelIds: ["UNREAD"] } })
const trash = () => request("gmail.users.messages.trash", { params: { userId: "me", id: "m-1" } })
const exportFile = () => request("drive.files.export", { params: { fileId: "f-1", mimeType: "text/plain" }, download: { path: join(host.location.directory, `export-${Date.now()}.txt`) } })

describe("rpcCommits: true", () => {
  it("describes the six commit tools as methods, with their classes, beside the reads", async () => {
    const described = (await host.opencode.rpc(Tools).describe({}, { location: host.location })) as { methods: Array<{ name: string; class: string; action: string }> }
    const classes = Object.fromEntries(described.methods.map((method) => [method.name, method.class]))
    expect(Object.keys(classes).sort()).toEqual([...READS, ...Object.keys(COMMIT_CLASSES)].sort())
    for (const name of READS) expect(classes[name]).toBe("read")
    for (const [name, type] of Object.entries(COMMIT_CLASSES)) expect(classes[name], name).toBe(type)
    for (const method of described.methods) expect(method.action).toBe(`gws.${method.name}`)
  })

  for (const [name, method, category, build] of [
    ["a Gmail reply", "send", "send", reply],
    ["marking a thread read", "write", "write", markRead],
    ["trashing a message", "delete", "delete", trash],
    ["a Drive export", "export", "export", exportFile],
  ] as const) {
    it(`plans and commits ${name} through the RPC in one session, with no model turn and no prompt`, async () => {
      const planned = await plan(sessions.a!, build())
      expect(planned.category).toBe(category)
      const before = commits().length
      const requests = host.model.requests.length
      const prompts = asked().length
      const committed = await run(method, sessions.a!, { planId: planned.planId })
      expect(committed.value, committed.message).toMatchObject({ ok: true, planId: planned.planId, category })
      expect(commits().length).toBe(before + 1)
      expect(host.model.requests.length).toBe(requests)
      expect(asked().length).toBe(prompts)
      if (method === "export") expect(existsSync(committed.value.file.path)).toBe(true)
    })
  }

  it("refuses a plan committed from another session with PLAN_CALLER_MISMATCH, before gws runs", async () => {
    const planned = await plan(sessions.a!, markRead())
    const before = commits().length
    expect(await run("write", sessions.b!, { planId: planned.planId })).toMatchObject({ type: "failed", code: "PLAN_CALLER_MISMATCH" })
    expect(commits().length).toBe(before)
    // The refusal leaves the plan to the session that made it.
    expect((await run("write", sessions.a!, { planId: planned.planId })).value).toMatchObject({ ok: true })
  })

  it("commits a plan once: the second commit is PLAN_ALREADY_USED, with no second gws call", async () => {
    const planned = await plan(sessions.a!, markRead())
    expect((await run("write", sessions.a!, { planId: planned.planId })).value).toMatchObject({ ok: true })
    const before = commits().length
    expect(await run("write", sessions.a!, { planId: planned.planId })).toMatchObject({ type: "failed", code: "PLAN_ALREADY_USED" })
    expect(commits().length).toBe(before)
  })

  it("refuses a plan sent to another category's method with CATEGORY_MISMATCH, and keeps it for its own", async () => {
    const planned = await plan(sessions.a!, reply())
    const before = commits().length
    const refused = await run("write", sessions.a!, { planId: planned.planId })
    expect(refused).toMatchObject({ type: "failed", code: "CATEGORY_MISMATCH" })
    expect(refused.message).toContain("this is a send plan")
    expect(commits().length).toBe(before)
    expect((await run("send", sessions.a!, { planId: planned.planId })).value).toMatchObject({ ok: true, category: "send" })
  })

  it("audits a script's commit with caller rpc, as it does a script's read and plan", async () => {
    const planned = await plan(sessions.a!, trash())
    expect((await run("delete", sessions.a!, { planId: planned.planId })).value).toMatchObject({ ok: true })
    const lines = async () => {
      // The audit sink is nonblocking: wait for the commit's line to land.
      for (let attempt = 0; attempt < 100; attempt++) {
        const found = existsSync(auditPath) ? readFileSync(auditPath, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>) : []
        if (found.some((line) => line.event === "operation.commit" && line.category === "delete")) return found
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      throw new Error("no commit in the audit log")
    }
    const commitLines = (await lines()).filter((line) => line.event === "operation.commit")
    expect(commitLines.length).toBeGreaterThan(0)
    for (const line of commitLines) expect(line, JSON.stringify(line)).toMatchObject({ outcome: expect.any(String), caller: "rpc" })
    expect(commitLines).toContainEqual(expect.objectContaining({ outcome: "success", category: "delete", operation: "gmail.users.messages.trash", caller: "rpc" }))
  })
})
