import { Rpc } from "@opencode/plugin/rpc"
import { expect } from "vitest"
import { request } from "../support/requests.js"
import type { Harness } from "./harness.js"

/**
 * The tools RPC path, shared by the `access` suites: each value gets its own
 * file, because one embedded host per process is all the SDK supports.
 */

/** The client side only names the methods: the plugin checks each input against the tool's own contract. */
const open = {}
const Tools = Rpc.define({
  id: "google-workspace.gws.tools",
  methods: {
    describe: { input: open, output: open },
    ...Object.fromEntries(
      ["status", "catalog", "schema", "read", "plan", "events_list"].map((name) => [
        name,
        { input: open, output: open, errors: { failed: open } },
      ]),
    ),
  },
  events: {},
})

export const list = request("gmail.users.messages.list", { params: { userId: "me", maxResults: 1 }, fields: "messages(id)" })
export const create = request("gmail.users.labels.create", { params: { userId: "me" }, body: { name: "access" } })

export const gwsCalls = (host: Harness) => host.invocations().filter((argv) => argv[0] !== "--version" && argv[0] !== "schema")
export const writes = (host: Harness) => host.invocations().filter((argv) => argv.includes("create") && !argv.includes("--dry-run"))
export const asked = (host: Harness) => host.events.filter((event) => event.type === "permission.asked")

/** The method's result, or the declared error's `{ type, code, message }`. */
export async function run(host: Harness, sessionID: string, method: string, input: unknown): Promise<Record<string, any>> {
  const tools = host.opencode.rpc(Tools) as unknown as Record<string, (input: unknown, options: unknown) => Promise<unknown>>
  try {
    return { value: await tools[method]!({ sessionID, input }, { location: host.location }) }
  } catch (error) {
    const e = error as Record<string, any>
    return { type: e.type ?? e._tag, code: e.data?.code, message: String(e.message ?? e) }
  }
}

/** The `build` agent's permissions start with the block for `access`, right after its base allow. */
export async function expectBlock(host: Harness, block: readonly { action: string; resource: string; effect: string }[]) {
  const agents = (await host.opencode.agent.list({ location: host.location })).data
  const build = agents.find((agent) => agent.id === "build")!
  expect(build.permissions[0]).toMatchObject({ action: "*", resource: "*", effect: "allow" })
  expect(build.permissions.slice(1, 1 + block.length)).toEqual([...block])
}
