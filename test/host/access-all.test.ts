import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { defaultRules } from "../../src/host/agents.js"
import { startHost, type Harness } from "./harness.js"
import { asked, create, expectBlock, gwsCalls, list, run, writes } from "./access.js"

/**
 * The default `access: "all"`: every rule in the block allows, so the tools
 * RPC runs a read and a commit with no permission prompt. The commit still
 * takes the `planId` its plan returned.
 */

let host: Harness
let sessionID: string

beforeAll(async () => {
  host = await startHost()
  sessionID = (await host.opencode.sessions.create({ location: host.location, agent: "build" })).id
}, 120_000)

afterAll(async () => {
  await host?.close()
})

describe("access: all", () => {
  it("inserts an all-allow block, the namespace and the commits included", async () => {
    expect(defaultRules("all").every((rule) => rule.effect === "allow")).toBe(true)
    await expectBlock(host, defaultRules("all"))
  })

  it("reads and plans; the commit is not a method, so a script cannot run it and no gws call is made for it", async () => {
    const before = gwsCalls(host).length
    expect((await run(host, sessionID, "read", list)).value).toMatchObject({ ok: true, category: "read" })
    const planned = await run(host, sessionID, "plan", create)
    expect(planned.value, planned.message).toMatchObject({ ok: true, category: "write", planId: expect.any(String) })
    const prompts = asked(host).length
    const commits = writes(host).length
    expect((await run(host, sessionID, "write", { planId: planned.value.planId })).value).toBeUndefined()
    expect(writes(host).length).toBe(commits)
    expect(asked(host).length).toBe(prompts)
    expect(gwsCalls(host).length).toBeGreaterThan(before)
  })
})
