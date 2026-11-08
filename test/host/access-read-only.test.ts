import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { defaultRules } from "../../src/host/agents.js"
import { startHost, type Harness } from "./harness.js"
import { create, expectBlock, list, run, writes } from "./access.js"

/**
 * `access: "read-only"`: the reads run, and the six commits are denied, so
 * the tools RPC refuses a commit before dispatch and gws never runs.
 */

let host: Harness
let sessionID: string

beforeAll(async () => {
  host = await startHost({ options: { access: "read-only" } })
  sessionID = (await host.opencode.sessions.create({ location: host.location, agent: "build" })).id
}, 120_000)

afterAll(async () => {
  await host?.close()
})

describe("access: read-only", () => {
  it("inserts the block that denies each commit and allows every read", async () => {
    const block = defaultRules("read-only")
    expect(block.filter((rule) => rule.effect === "deny").map((rule) => rule.action)).toEqual(["gws.*", "gws.write", "gws.export", "gws.send", "gws.share", "gws.delete", "gws.admin"])
    await expectBlock(host, block)
  })

  it("reads, and denies a commit with no gws call", async () => {
    expect((await run(host, sessionID, "read", list)).value).toMatchObject({ ok: true, category: "read" })
    const planned = await run(host, sessionID, "plan", create)
    expect(planned.value, planned.message).toMatchObject({ ok: true, category: "write", planId: expect.any(String) })
    const commits = writes(host).length
    const refused = await run(host, sessionID, "write", { planId: planned.value.planId })
    expect(refused).toMatchObject({ type: "failed", code: "PERMISSION_DENIED" })
    expect(refused.message).toMatch(/hidden/)
    expect(writes(host).length).toBe(commits)
  })
})
