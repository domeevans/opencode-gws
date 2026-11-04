import { readdirSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { Runtime } from "../src/runtime/index.js"
import { account, testRuntime } from "./support/config.js"

/**
 * gws saves a 2xx body that is not JSON to a file in its working directory
 * and prints where: an empty `download.html` for a delete's empty body. A
 * call that is not a download reports what Google answered, and leaves no
 * file behind.
 */

const ctx = { sessionId: "ses_body", agentId: "build" }
const runtimes: Runtime[] = []
afterEach(async () => {
  delete process.env["FAKE_GWS_RESPONSES"]
  for (const runtime of runtimes.splice(0)) await runtime.close()
})

async function runtime(): Promise<Runtime> {
  const created = await testRuntime({ accounts: { personal: account({ services: ["drive"], access: "write" }) } })
  runtimes.push(created)
  return created
}

/** Every file under a directory, relative to it. */
function files(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name).slice(dir.length + 1))
}

describe("a body gws saved for a call that is not a download", () => {
  it("reports an empty body as an empty result and removes the file", async () => {
    const gws = await runtime()
    process.env["FAKE_GWS_RESPONSES"] = JSON.stringify({ "drive.files.delete": { $saved: { name: "download.html", content: "", mimeType: "text/html" } } })
    const plan = await gws.plan({ operation: "drive.files.delete", params: { fileId: "f1" } }, ctx)
    const receipt = await gws.commit("delete", { planId: plan.planId }, ctx)
    expect(receipt.result).toBe("")
    expect(files(gws.workDir).filter((file) => file.endsWith("download.html"))).toEqual([])
  })

  it("reports a non-empty body's type and size, points to gws_export, and removes the file", async () => {
    const gws = await runtime()
    process.env["FAKE_GWS_RESPONSES"] = JSON.stringify({ "drive.files.get": { $saved: { name: "download.bin", content: "%PDF-1.7", mimeType: "application/pdf" } } })
    const read = await gws.read({ operation: "drive.files.get", params: { fileId: "f1", alt: "media" } }, ctx)
    expect(read.data).toEqual({ mimeType: "application/pdf", bytes: 8, saved: false, next: expect.stringMatching(/download\.path.*gws_export/) })
    expect(files(gws.workDir).filter((file) => file.startsWith("download") || file.includes("/download"))).toEqual([])
  })
})
