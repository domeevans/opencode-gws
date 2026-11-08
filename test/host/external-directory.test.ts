import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { request } from "../support/requests.js"
import { commits, driver, plan, turn, type Driver } from "./tools-driver.js"

/**
 * A download outside the project needs OpenCode's own `external_directory`
 * permission as well as this plugin's `gws.export`. A rejection writes
 * nothing, keeps the plan, and the refusal names the rule that would allow
 * the folder. A destination inside the project never asks it.
 *
 * Its own file so its host is a separate process. See tools-driver.ts.
 */

let folder: string
let d: Driver

beforeAll(async () => {
  folder = mkdtempSync(join(tmpdir(), "gws-external-"))
  // The rules a user sets to control files outside the project: without one, an agent whose base rule allows
  // everything allows external_directory too, which is why the plugin asserts it and says what to set.
  d = await driver({ permissions: [{ action: "external_directory", resource: "*", effect: "ask" }] })
})
afterAll(async () => {
  await d?.host.close()
  rmSync(folder, { recursive: true, force: true })
})

const destination = () => join(folder, `export-${Date.now()}.txt`)
const exportPlan = () => request("drive.files.export", { params: { fileId: "f-1", mimeType: "text/plain" }, download: { path: destination() } })

describe("a download outside the project", () => {
  it("asks external_directory after the export action, and a rejection writes nothing and names the rule", async () => {
    const planned = await plan(d, exportPlan())
    const before = commits(d.host).length
    const rejected = await turn(d, { tool: "gws_export", input: { planId: planned["planId"] } }, (action) => (action === "external_directory" ? "reject" : "once"))
    // The plugin's own action is allowed at the default access; the folder is the one thing these rules ask for.
    expect(rejected.asked.map((ask) => ask.action)).toEqual(["external_directory"])
    const message = (JSON.parse(rejected.result) as { error: { message: string } }).error.message
    expect(message).toMatch(/^DOWNLOAD_NOT_PERMITTED: The host's rules refused the download folder .* which is outside the project/)
    expect(message).toContain(`{"action": "external_directory", "resource": "${folder}/*", "effect": "allow"}`)
    expect(commits(d.host).length).toBe(before)
    // The plan is still ready, so an approval of both prompts commits it.
    const approved = await turn(d, { tool: "gws_export", input: { planId: planned["planId"] } })
    expect(approved.asked.map((ask) => ask.action)).toEqual(["external_directory"])
    const output = JSON.parse(approved.result) as { ok: boolean; file: { path: string } }
    expect(output).toMatchObject({ ok: true })
    expect(existsSync(output.file.path)).toBe(true)
    expect(commits(d.host).length).toBe(before + 1)
  })
})
