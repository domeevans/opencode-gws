import { readFileSync } from "node:fs"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { REPO } from "./harness.js"
import { call, codeMode, driver, turn, type Driver } from "./tools-driver.js"

/**
 * How a plugin error reaches the model on 2.2.3. After a direct call the
 * model reads `{"error":{"type":"tool.execution","message": "CODE: what
 * happened. Next step: What to do."}}`. A Code Mode program catches an Error
 * whose message is that text, with no metadata; uncaught, the text is the
 * program's result. The Tool.Error metadata `{ code, next, enableUrl? }`
 * never reaches the model: a direct call's is on the session's tool part
 * and its session.tool.failed event, for clients, and a Code Mode call's
 * is dropped. So the message carries the code, the next step, and the
 * enable link itself.
 *
 * The host keeps that metadata only when it recognizes the plugin's
 * Tool.Error class. An embedded host whose SDK is the version installed in
 * this repository shares the plugin's @opencode/plugin, so it does. An
 * embedded host of another version (HOST_SDK_DIR, for example 2.2.4) does
 * not supply its own copy to the plugin: it sees a foreign class, labels
 * the error "unknown", keeps the message, and drops the metadata.
 *
 * Its own file so its host is a separate process from the other tool hosts.
 * See tools-driver.ts.
 */

describe("errors the model reads", () => {
  let d: Driver
  beforeAll(async () => {
    d = await driver()
  })
  afterAll(async () => {
    delete process.env["FAKE_GWS_FAIL"]
    await d?.host.close()
  })

  it("shows a direct call the code, what happened, and the next step", async () => {
    const failed = await turn(d, { tool: "gws_send", input: { planId: "plan_aaaaaaaaaaaaaaaaaaaaaaaa" } })
    expect(failed.result).toContain("PLAN_NOT_FOUND: Run gws_plan first. Next step: Create a plan with gws_plan, then commit its planId.")
    expect(failed.asked).toEqual([])
  })

  it("gives a Code Mode program the same message to catch, without metadata", async () => {
    const caught = await codeMode(d, call("plan", { account: "nobody", operation: "gmail.users.labels.create", params: { userId: "me" }, body: { name: "x" } }))
    expect(caught["error"]).toEqual({ message: "ACCOUNT_UNKNOWN: 'nobody' is not configured. Next step: Pass one of the configured accounts: personal.", name: "Error" })
  })

  it("carries a disabled API's enable link", async () => {
    process.env["FAKE_GWS_FAIL"] = "disabled"
    try {
      const failed = await turn(d, { tool: "gws_read", input: { operation: "gmail.users.messages.list", params: { userId: "me" }, fields: "messages(id)" } })
      expect((JSON.parse(failed.result) as { error: { message: string } }).error.message).toMatch(
        /^API_DISABLED: Gmail API has not been used in project 000000000000.*Next step: Ask the user to open https:\/\/console\.developers\.google\.com\/apis\/api\/gmail\.googleapis\.com\/overview\?project=000000000000 and enable the API for project 000000000000/,
      )
    } finally {
      delete process.env["FAKE_GWS_FAIL"]
    }
  })

  it("gives clients the code and next step of a failed direct call as metadata, not the model", async () => {
    const before = new Set(d.host.events.map((event) => event.id))
    const failed = await turn(d, { tool: "gws_delete", input: { planId: "plan_bbbbbbbbbbbbbbbbbbbbbbbb" } })
    // The host names the error type itself; the model reads the message.
    expect(JSON.parse(failed.result)).toMatchObject({
      error: { message: "PLAN_NOT_FOUND: Run gws_plan first. Next step: Create a plan with gws_plan, then commit its planId." },
      content: [],
    })
    const event = await d.host.waitForEvent((item) => item.type === "session.tool.failed" && item.data?.sessionID === d.sessionID && !before.has(item.id))
    const pluginApi = (JSON.parse(readFileSync(join(REPO, "node_modules", "@opencode", "plugin", "package.json"), "utf8")) as { version: string }).version
    const recognized = d.host.hostVersion === pluginApi
    expect(event.data?.metadata).toEqual(recognized ? { code: "PLAN_NOT_FOUND", next: "Create a plan with gws_plan, then commit its planId." } : undefined)
  })
})
