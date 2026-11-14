import { afterEach, describe, expect, it, vi } from "vitest"
import { registerToolsRpc, scriptMethods } from "../src/host/script-methods.js"
import type { Runtime } from "../src/runtime/index.js"
import { testRuntime } from "./support/config.js"

/**
 * With rpcCommits on, each commit method's describe names the agents without the default rules. The names come from
 * the agent list alone, listed once per describe pass and shared by the six commit methods: never the runtime's
 * status, the skills or the full status source.
 */

type Handler = (input: unknown, context: unknown) => Promise<any>
type Agent = { id: string; permissions: { action: string; resource: string; effect: "allow" | "deny" | "ask" }[] }

const NOTE = "Note: a script running as notes commits without asking, because that agent lacks the default rules."
const COMMITS = ["write", "send", "share", "delete", "export", "admin"]

let runtime: Runtime | undefined
afterEach(async () => {
  vi.useRealTimers()
  await runtime?.close()
  runtime = undefined
})

async function setup(listAgents: () => Promise<Agent[]>) {
  runtime = await testRuntime({ rpcCommits: true, access: "ask-changes" })
  const runtimeStatus = vi.spyOn(runtime, "status")
  const status = vi.fn(async () => {
    throw new Error("the full status source is not for describe")
  })
  let handlers: Record<string, Handler> = {}
  const ctx = {
    location: { directory: "/project" },
    rpc: {
      register: async (_definition: unknown, registered: Record<string, Handler>) => {
        handlers = registered
        return { dispose: async () => {} }
      },
    },
    permission: { hook: async () => ({ dispose: async () => {} }), assert: async () => {} },
  }
  await registerToolsRpc(ctx, scriptMethods({ runtime, assert: async () => {}, status: status as never, listAgents }))
  const describeOnce = async () => (await handlers.describe!({}, { signal: new AbortController().signal, error: () => undefined })) as { methods: Array<{ name: string; description: string }> }
  return { describeOnce, runtimeStatus, status }
}

const guarded = { id: "build", permissions: [{ action: "*", resource: "*", effect: "allow" as const }, { action: "gws.*", resource: "*", effect: "ask" as const }] }
const unguarded = { id: "notes", permissions: [{ action: "*", resource: "*", effect: "allow" as const }] }

describe("the commit methods' describe note", () => {
  it("lists the agents once per describe, names the unguarded ones on every commit method, and never reads the runtime's status", async () => {
    const listAgents = vi.fn(async () => [guarded, unguarded])
    const h = await setup(listAgents)
    const described = await h.describeOnce()
    expect(listAgents).toHaveBeenCalledTimes(1)
    expect(h.runtimeStatus).not.toHaveBeenCalled()
    expect(h.status).not.toHaveBeenCalled()
    for (const method of described.methods) {
      if (COMMITS.includes(method.name)) expect(method.description, method.name).toContain(NOTE)
      else expect(method.description, method.name).not.toContain("Note:")
    }
  })

  it("lists the agents again for a describe after the shared listing has aged", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    const listAgents = vi.fn(async () => [guarded, unguarded])
    const h = await setup(listAgents)
    await h.describeOnce()
    vi.setSystemTime(Date.now() + 5_000)
    await h.describeOnce()
    expect(listAgents).toHaveBeenCalledTimes(2)
  })

  it("names none when every agent is guarded, or when the listing fails", async () => {
    const all = await setup(async () => [guarded])
    for (const method of (await all.describeOnce()).methods) expect(method.description).not.toContain("Note:")
    await runtime?.close()
    const failing = vi.fn(async (): Promise<Agent[]> => {
      throw new Error("agent list failed")
    })
    const failed = await setup(failing)
    for (const method of (await failed.describeOnce()).methods) expect(method.description).not.toContain("Note:")
    expect(failing).toHaveBeenCalledTimes(1)
  })
})
