import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { statusSource } from "../src/host/rpc.js"
import { registerTools } from "../src/host/tools.js"
import type { PermissionRequest } from "../src/host/permissions.js"
import { registerCommands } from "../src/host/commands.js"
import { integrationAuthReporter, integrationTokenProvider } from "../src/host/integrations.js"
import type { AccountCredential, RuntimeOptions } from "../src/runtime/accounts.js"
import { account, testRuntime } from "./support/config.js"
import { request } from "./support/requests.js"

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); vi.restoreAllMocks() })
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
const call = () => ({ sessionID: "session", agent: "agent", messageID: "message", id: "call", signal: new AbortController().signal, progress: async () => {} })
const trash = request("drive.files.update", { params: { fileId: "fixture" }, body: { trashed: true } })
const read = request("drive.files.get", { params: { fileId: "fixture" } })
async function fixture(options: { permission?: (request: PermissionRequest) => Promise<void>; token?: NonNullable<RuntimeOptions["tokenProvider"]>; slow?: boolean; failedAudit?: boolean } = {}) {
  const dir = mkdtempSync(join(process.cwd(), ".runtime-lifecycle-"))
  const binary = join(dir, "gws"), log = join(dir, "calls"), pid = join(dir, "pid")
  writeFileSync(binary, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo 'gws 0.22.5'; exit 0; fi\necho "$*" >> '${log}'\n${options.slow ? `echo $$ > '${pid}'\nexec /bin/sleep 30` : `printf '{"id":"fixture"}'`}\n`)
  chmodSync(binary, 0o755)
  const runtime = await testRuntime(
    { binary: { path: binary }, accounts: { personal: account({ services: ["drive"] }) }, audit: { enabled: options.failedAudit ?? false, path: dir } },
    options.token ? { tokenProvider: options.token } : {},
  )
  cleanups.push(async () => { await runtime.close(); rmSync(dir, { recursive: true, force: true }) })
  const tools = new Map<string, { execute: (input: unknown, context: ReturnType<typeof call>) => Promise<{ output: any }> }>()
  const permissions: PermissionRequest[] = []
  await registerTools({ permission: { hook: async () => {}, assert: async (request: PermissionRequest) => { permissions.push(request); await options.permission?.(request) } }, tool: { transform: async (edit: any) => edit({ namespace: () => {}, add: (tool: any) => tools.set(tool.name, tool) }) } } as never, runtime, statusSource(runtime, async () => []))
  return { runtime, permissions, pid, run: (name: string, input: unknown, context = call()) => tools.get(name)!.execute(input, context), calls: () => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [] }
}

describe("plan and commit through the tools", () => {
  it("routes Drive trash to delete, refuses write, and performs zero mutations on host rejection", async () => {
    const rejected = Object.assign(new Error("host rejected"), { _tag: "Permission.Rejected" })
    const f = await fixture({ permission: async request => { if (request.action === "gws.delete") throw rejected } })
    const { output: plan } = await f.run("plan", trash)
    expect(plan).toMatchObject({ category: "delete", preview: { category: "delete" } })
    expect(plan).not.toHaveProperty("requiresConfirmation")
    await expect(f.run("write", { planId: plan.planId })).rejects.toThrow(/CATEGORY_MISMATCH/)
    await expect(f.run("delete", { planId: plan.planId })).rejects.toBe(rejected)
    expect(f.permissions.map(x => x.action)).toEqual(["gws.plan", "gws.delete"])
    expect(f.calls()).toHaveLength(1)
    expect(f.calls()[0]).toContain("--dry-run")
    expect(f.runtime.plans.get(plan.planId)?.state).toBe("ready")
  })

  it.each([false, "true", undefined])("does not treat trashed=%s as a delete", async trashed => {
    const f = await fixture()
    const { output } = await f.run("plan", { ...trash, body: { trashed } })
    expect(output.category).toBe("write")
  })

  it("returns a successful mutation while exposing real audit storage failure through tool status", async () => {
    const f = await fixture({ failedAudit: true })
    const { output: plan } = await f.run("plan", trash)
    const { output } = await f.run("delete", { planId: plan.planId })
    expect(output.ok).toBe(true)
    await vi.waitFor(() => expect(f.runtime.audit.degraded).toBe(true))
    expect((await f.run("status", {})).output.auditDegraded).toBe(true)
    expect(f.calls().filter(line => !line.includes("--dry-run"))).toHaveLength(1)
  })
})

describe("runtime close", () => {
  it("revokes retained local and remote callbacks before any permission or process work", async () => {
    const f = await fixture()
    await f.runtime.close()
    for (const [name, input] of [["status", {}], ["catalog", {}], ["read", read], ["plan", trash]] as const) {
      await expect(f.run(name, input)).rejects.toThrow(/^CANCELLED:/)
    }
    expect(f.permissions).toEqual([])
    expect(f.calls()).toEqual([])
  })

  it("settles a held permission on close and does not continue after late approval", async () => {
    const entered = deferred<void>(), permission = deferred<void>()
    const f = await fixture({ permission: async () => { entered.resolve(); await permission.promise } })
    const pending = f.run("read", read)
    const verdict = expect(pending).rejects.toThrow(/^CANCELLED:/)
    await entered.promise
    await f.runtime.close()
    await verdict
    permission.resolve()
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(f.calls()).toEqual([])
  })

  it("settles a held token request on close and ignores the late token", async () => {
    const entered = deferred<void>(), token = deferred<AccountCredential | undefined>()
    const f = await fixture({ token: async () => { entered.resolve(); return token.promise } })
    const pending = f.run("read", read)
    const verdict = expect(pending).rejects.toThrow(/^CANCELLED:/)
    await entered.promise
    await f.runtime.close()
    await verdict
    token.resolve({ access: "synthetic-token", grantedScopes: [] })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(f.calls()).toEqual([])
  })

  it.each(["read", "plan", "schema"])("kills a running %s process before close completes", async name => {
    const f = await fixture({ slow: true })
    const pending = f.run(name, name === "plan" ? trash : name === "schema" ? request("drive.files.get") : read)
    const outcome = pending.catch(error => error)
    await vi.waitFor(() => expect(existsSync(f.pid)).toBe(true), { timeout: 5_000 })
    const pid = Number(readFileSync(f.pid, "utf8"))
    await f.runtime.close()
    expect(await outcome).toMatchObject({ message: expect.stringMatching(/^CANCELLED:/) })
    expect(() => process.kill(pid, 0)).toThrow()
  }, 10_000)

  it("revokes a commit held at confirmation without starting a mutation", async () => {
    const entered = deferred<void>(), permission = deferred<void>()
    const f = await fixture({ permission: async request => {
      if (request.action === "gws.delete") { entered.resolve(); await permission.promise }
    } })
    const { output: plan } = await f.run("plan", trash)
    const pending = f.run("delete", { planId: plan.planId })
    const verdict = expect(pending).rejects.toThrow(/^CANCELLED:/)
    await entered.promise
    await f.runtime.close()
    await verdict
    permission.resolve()
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(f.calls()).toHaveLength(1)
    expect(f.runtime.plans.list()).toEqual([])
  })

  it("does not create an orphan plan when close occurs after dry-run completion", async () => {
    const f = await fixture()
    await expect(f.run("plan", trash, { ...call(), progress: async (update?: any) => { if (update.status === "parsing") void f.runtime.close() } })).rejects.toThrow(/^CANCELLED:/)
    expect(f.runtime.plans.list()).toEqual([])
  })

  it("revokes a held command status and retained command callbacks without synthetic delivery", async () => {
    const f = await fixture(), entered = deferred<void>(), status = deferred<any>()
    const commands = new Map<string, any>(), synthetic = vi.fn()
    const stop = await registerCommands({ command: { transform: async (edit: any) => edit({ add: (command: any) => commands.set(command.name, command) }) }, session: { synthetic } } as never,
      { status: async () => { entered.resolve(); return status.promise }, plans: () => [], doctor: f.runtime, install: async () => ({ path: "", version: "unknown" }) }, f.runtime.signal)
    const pending = commands.get("gws-status").execute({ sessionID: "session", delivery: "queue" })
    const verdict = expect(pending).rejects.toThrow(/^CANCELLED:/)
    await entered.promise
    await f.runtime.close()
    await verdict
    status.resolve({ accounts: [] })
    await expect(commands.get("gws-doctor").execute({ sessionID: "session", delivery: "queue" })).rejects.toThrow(/^CANCELLED:/)
    expect(synthetic).not.toHaveBeenCalled()
    await stop()
  })

  it("prevents token resolution and auth-state effects after a held active-connection lookup is revoked", async () => {
    const f = await fixture(), active = deferred<any>()
    const connection = { active: vi.fn(() => active.promise), resolve: vi.fn(), status: vi.fn() }
    const ids = new Map([["personal", "gws-personal"]])
    const provider = integrationTokenProvider({ integration: { connection } } as never, f.runtime.config, ids)!
    const reporter = integrationAuthReporter({ integration: { connection } } as never, f.runtime.config, ids)!
    const token = provider("personal", f.runtime.signal)
    const cancelled = expect(token).rejects.toThrow(/^CANCELLED:/)
    const report = reporter("personal", { status: "ok" }, f.runtime.signal)
    await Promise.resolve()
    await f.runtime.close()
    await cancelled
    await report
    active.resolve({ id: "fixture" })
    await Promise.resolve()
    expect(connection.resolve).not.toHaveBeenCalled()
    expect(connection.status).not.toHaveBeenCalled()
  })
})
