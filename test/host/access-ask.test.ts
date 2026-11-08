import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { defaultRules } from "../../src/host/agents.js"
import { startHost, type Harness } from "./harness.js"
import { asked, create, expectBlock, list, run, writes } from "./access.js"

/**
 * `access: "ask-changes"`: the reads run, and each commit asks, so the tools
 * RPC refuses it before dispatch: no gws call and no prompt left waiting.
 */

let host: Harness
let sessionID: string

beforeAll(async () => {
  host = await startHost({ options: { access: "ask-changes" } })
  sessionID = (await host.opencode.sessions.create({ location: host.location, agent: "build" })).id
}, 120_000)

afterAll(async () => {
  await host?.close()
})

describe("access: ask-changes", () => {
  it("inserts the block that asks for each commit and allows every read", async () => {
    const block = defaultRules("ask-changes")
    expect(block.filter((rule) => rule.effect === "ask").map((rule) => rule.action)).toEqual(["gws.*", "gws.write", "gws.export", "gws.send", "gws.share", "gws.delete", "gws.admin"])
    await expectBlock(host, block)
  })

  it("reads, and refuses a commit at once with no gws call and no prompt", async () => {
    expect((await run(host, sessionID, "read", list)).value).toMatchObject({ ok: true, category: "read" })
    const planned = await run(host, sessionID, "plan", create)
    expect(planned.value, planned.message).toMatchObject({ ok: true, category: "write", planId: expect.any(String) })
    const commits = writes(host).length
    const prompts = asked(host).length
    const started = Date.now()
    const refused = await run(host, sessionID, "write", { planId: planned.value.planId })
    expect(refused).toMatchObject({ type: "failed", code: "PERMISSION_DENIED" })
    expect(refused.message).toMatch(/would ask/)
    expect(Date.now() - started).toBeLessThan(5000)
    expect(writes(host).length).toBe(commits)
    expect(asked(host).length).toBe(prompts)
  })
})
