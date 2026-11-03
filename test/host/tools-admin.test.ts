import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { request } from "../support/requests.js"
import { commits, driver, plan, turn, type Driver } from "./tools-driver.js"

/**
 * admin runs here with the default gate (admin.enabled defaults to true),
 * an approved ask, and a reason; without a reason it is refused
 * (tools.test.ts). Its own file so its host is a separate process from the
 * other tool hosts. See tools-driver.ts.
 */

describe("admin", () => {
  let d: Driver
  beforeAll(async () => {
    d = await driver({
      policy: { rules: [] },
    })
  })
  afterAll(async () => {
    await d?.host.close()
  })

  it("plans with a reason and commits with gws_admin after approval", async () => {
    const planned = await plan(d, request("drive.files.generateCseToken", { reason: "host test" }))
    expect(planned).toMatchObject({ category: "admin", preview: { reason: "host test" } })
    const committed = await turn(d, { tool: "gws_admin", input: { planId: planned["planId"] } })
    expect(committed.asked.map((ask) => ask.action)).toContain("gws.admin")
    expect(JSON.parse(committed.result)).toMatchObject({ ok: true, category: "admin", operation: "drive.files.generateCseToken" })
  })

  it("runs nothing when the admin prompt is rejected", async () => {
    const planned = await plan(d, request("drive.files.generateCseToken", { reason: "host test" }))
    const before = commits(d.host).length
    await turn(d, { tool: "gws_admin", input: { planId: planned["planId"] } }, () => "reject")
    expect(commits(d.host).length).toBe(before)
  })
})
