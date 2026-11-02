import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { request } from "../support/requests.js"
import { ACCOUNT } from "./harness.js"
import { call, codeMode, commits, COMMITS, driver, plan, turn, type Commit, type Driver } from "./tools-driver.js"

/**
 * All eleven tools in the real host, driven by the scripted model against
 * the fake gws. status, catalog, schema, and plan run in Code Mode; read
 * and the six commit tools are direct tools the model calls by name. Each
 * commit runs only after its permission prompts are approved, and each
 * category has a path where nothing commits. admin is refused by default
 * and runs with admin.enabled, an allow rule, and a reason (tools-admin.test.ts).
 * How a plugin error reaches the model is covered in tools-errors.test.ts.
 *
 * This file starts one host. The admin and errors describes are separate
 * files so each host gets its own process. See tools-driver.ts.
 */

let root: string
const REQUESTS: Record<Exclude<Commit, "admin">, () => ReturnType<typeof request>> = {
  write: () => request("gmail.users.labels.create", { params: { userId: "me" }, body: { name: "host-test" } }),
  send: () => request("gmail.users.messages.send", { params: { userId: "me" }, body: { raw: "aG9zdCB0ZXN0" } }),
  share: () => request("drive.permissions.create", { params: { fileId: "f-1" }, body: { role: "reader", type: "user", emailAddress: "reader@example.com" } }),
  delete: () => request("gmail.users.messages.delete", { params: { userId: "me", id: "m-fake-1" } }),
  export: () => request("drive.files.export", { params: { fileId: "f-1", mimeType: "text/plain" }, download: { path: join(root, `export-${Date.now()}.txt`) } }),
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "gws-host-tools-"))
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

describe("the eleven tools", () => {
  let d: Driver
  beforeAll(async () => {
    d = await driver()
  })
  afterAll(async () => {
    await d?.host.close()
  })

  it("offers status, catalog, schema, and plan in Code Mode, with catalog and plan pinned, and read and the commits as direct tools", async () => {
    const found = await codeMode(d, `return search({ namespace: "gws", limit: 50 })`)
    const paths = (found["items"] as Array<{ path: string }>).map((item) => item.path).sort()
    expect(paths).toEqual(["tools.gws.catalog", "tools.gws.plan", "tools.gws.schema", "tools.gws.status"])
    const offered = d.host.model.requests.at(-1)!
    expect(offered.tools).toEqual(expect.arrayContaining(["gws_read", ...COMMITS.map((category) => `gws_${category}`)]))
    expect(offered.tools).not.toEqual(expect.arrayContaining(["gws_plan", "gws_catalog"]))
    for (const name of ["catalog", "plan"]) expect(offered.system).toContain(`tools.gws.${name}(`)
  })

  it("runs status, catalog, schema, read, and plan, with only the read and the dry run reaching gws", async () => {
    const before = d.host.invocations().length
    const direct = await turn(d, { tool: "gws_read", input: { operation: "gmail.users.messages.list", params: { userId: "me" }, fields: "messages(id)" } })
    const read = JSON.parse(direct.result) as Record<string, unknown>
    const result = await codeMode(
      d,
      `
      const status = await tools.gws.status({})
      const catalog = await tools.gws.catalog({ query: "send email" })
      const schema = await tools.gws.schema({ operation: "gmail.users.getProfile" })
      const plan = await tools.gws.plan(${JSON.stringify({ operation: "gmail.users.labels.create", params: { userId: "me" }, body: { name: "x" } })})
      return { status, catalog, schema, plan }
    `,
    )
    const { status, catalog, schema, plan: planned } = result as Record<string, Record<string, unknown>>
    expect(status).toMatchObject({ accounts: [expect.objectContaining({ alias: ACCOUNT, connected: true })] })
    expect(catalog["entries"]).toEqual(expect.arrayContaining([expect.objectContaining({ id: "gmail.users.messages.send", executable: true, commitTool: "gws_send" })]))
    expect(schema).toMatchObject({ ok: true, account: ACCOUNT, schema: { id: "gmail.users.getProfile" } })
    expect(read).toMatchObject({ ok: true, operation: "gmail.users.messages.list", data: { messages: [{ id: "m-fake-1" }, { id: "m-fake-2" }] } })
    expect(planned).toMatchObject({ ok: true, category: "write", preview: { account: ACCOUNT } })
    const ran = d.host.invocations().slice(before)
    expect(ran.map((argv) => argv.includes("--dry-run"))).toEqual([false, true])
  })

  it.each(["write", "send", "share", "delete", "export"] as const)("commits a %s plan with the direct tool after approval, exactly once", async (category) => {
    const planned = await plan(d, REQUESTS[category]())
    expect(planned["category"]).toBe(category)
    const before = commits(d.host).length
    const committed = await turn(d, { tool: `gws_${category}`, input: { planId: planned["planId"] } })
    expect(committed.asked.map((ask) => ask.action)).toContain(`gws.${category}`)
    expect(JSON.parse(committed.result)).toMatchObject({ ok: true, planId: planned["planId"], category })
    expect(commits(d.host).length).toBe(before + 1)
    if (category === "export") expect(existsSync(String((JSON.parse(committed.result) as { file: { path: string } }).file.path))).toBe(true)
  })

  it.each(["write", "send", "share", "delete", "export"] as const)("runs nothing when the %s prompt is rejected, and keeps the plan", async (category) => {
    const planned = await plan(d, REQUESTS[category]())
    const before = commits(d.host).length
    const rejected = await turn(d, { tool: `gws_${category}`, input: { planId: planned["planId"] } }, () => "reject")
    expect(rejected.asked.length).toBeGreaterThan(0)
    // A rejected direct call ends the step: the model is not asked again, so it cannot retry the commit on its own.
    expect(rejected.requests).toBe(1)
    expect(commits(d.host).length).toBe(before)
    const again = await turn(d, { tool: `gws_${category}`, input: { planId: planned["planId"] } })
    expect(JSON.parse(again.result)).toMatchObject({ ok: true, category })
  })

  it("refuses an admin plan by default, before gws runs", async () => {
    const before = d.host.invocations().length
    const refused = await codeMode(d, call("plan", request("drive.files.generateCseToken", { reason: "host test" })))
    expect((refused["error"] as { message: string }).message).toMatch(/^POLICY_DENIED: Admin-disabled\. Next step: /)
    expect(d.host.invocations().length).toBe(before)
  })
})
