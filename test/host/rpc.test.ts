import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Gws, REPO, isStatus, packageJson } from "./package.js"
import { ACCOUNT, PLUGIN_ID, startHost, type Harness } from "./harness.js"

/**
 * The RPC contract and the commands through the real
 * host: calls go through the embedded client's `client.rpc(Gws)`, exactly
 * as the TUI part does with the same contract inlined into dist/tui.js.
 */

let host: Harness

/** A user's skill folder holding one skill that runs gws in a shell. */
const SKILLS = join(REPO, "test", "fixtures", "skills")

beforeAll(async () => {
  host = await startHost({ skills: [SKILLS] })
})

afterAll(async () => {
  await host?.close()
})

const gws = () => host.opencode.rpc(Gws)
const at = () => ({ location: host.location })

describe("plugin parts", () => {
  it("reports the server and tui features from the package exports, with ./rpc kept internal", async () => {
    const { data } = await host.opencode.plugin.list({ location: host.location })
    const entry = data.find((plugin) => plugin.id === PLUGIN_ID)
    expect(entry?.state).toEqual({ status: "active" })
    expect(entry?.features).toMatchObject({ server: true, tui: true })
    expect(entry?.features).not.toHaveProperty("rpc")
  })

  it("registers only /gws-status and /gws-doctor", async () => {
    const { data } = await host.opencode.command.list({ location: host.location })
    const names = data.map((command) => command.name).filter((name) => name.startsWith("gws-"))
    expect(names.sort()).toEqual(["gws-doctor", "gws-status"])
  })
})

describe("rpc through client.rpc", () => {
  it("answers status with each account's sign-in state, never a token or secret", async () => {
    const status = await gws().status({}, at())
    if (!isStatus(status)) throw new Error(`not a status: ${JSON.stringify(status)}`)
    expect(status).toMatchObject({ version: packageJson.version, host: { version: host.hostVersion, range: ">=2.2.3 <2.3.0" }, gws: { version: "gws 0.22.5" } })
    expect(status.accounts).toEqual([
      expect.objectContaining({ alias: ACCOUNT, mode: "interactive", services: ["gmail", "drive"], integrationID: `gws-${ACCOUNT}`, access: expect.stringMatching(/^(read|write)$/) }),
    ])
    expect(JSON.stringify(status)).not.toMatch(/ya29\.|client_secret|clientSecret/)
  })

  // The skill comes from OpenCode's own skill list, through the public ctx.skill.list().
  it("names a user's skill that runs gws in a shell, with its file", async () => {
    const status = await gws().status({}, at())
    if (!isStatus(status)) throw new Error(`not a status: ${JSON.stringify(status)}`)
    expect(status.shellSkills).toEqual([{ id: "gws-mail-cli", path: join(SKILLS, "gws-mail-cli", "SKILL.md") }])
  })
})
