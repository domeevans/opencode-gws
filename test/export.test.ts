import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { Stage } from "../src/process/staging.js"
import { account, testRuntime } from "./support/config.js"
import { request } from "./support/requests.js"

/**
 * Export delivery: the commit publishes the staged file into the
 * destination, reports cleanup failures without hiding a delivered file,
 * and never publishes after the runtime is revoked.
 *
 * The final publication is controlled after the real destination-side
 * link/rename has succeeded, not before it. `crossDevice` forces the
 * fallback deterministically, so these cases no longer depend on the test's
 * work directory and destination sharing a filesystem.
 */

const hooks = vi.hoisted(() => ({
  crossDevice: false,
  failUnlink: false,
  afterPublish: undefined as undefined | ((published: { method: "link" | "rename"; from: string; to: string }) => Promise<void>),
  beforePartialOpen: undefined as undefined | ((path: string) => Promise<void>),
}))
vi.mock("node:fs/promises", async importOriginal => {
  const fs = await importOriginal<typeof import("node:fs/promises")>()
  const publish = async (method: "link" | "rename", from: string, to: string) => {
    if (hooks.crossDevice && from.includes("/call-")) throw Object.assign(new Error("synthetic cross-device boundary"), { code: "EXDEV" })
    // Let the real final publication land first; only then may a test hold its return.
    const result = await fs[method](from, to)
    await hooks.afterPublish?.({ method, from, to })
    return result
  }
  return {
    ...fs,
    link: (from: string, to: string) => publish("link", from, to),
    rename: (from: string, to: string) => publish("rename", from, to),
    open: async (path: Parameters<typeof fs.open>[0], flags: Parameters<typeof fs.open>[1], mode?: Parameters<typeof fs.open>[2]) => {
      const handle = await fs.open(path, flags, mode)
      if (hooks.beforePartialOpen && String(path).endsWith(".partial")) await hooks.beforePartialOpen(String(path))
      return handle
    },
    unlink: async (path: string) => {
      if (hooks.failUnlink && path.endsWith(".partial")) throw Object.assign(new Error("synthetic cleanup failure"), { code: "EACCES" })
      return fs.unlink(path)
    },
  }
})

const cleaners: Array<() => Promise<void>> = []
afterEach(async () => {
  hooks.crossDevice = false
  hooks.failUnlink = false
  hooks.afterPublish = undefined
  hooks.beforePartialOpen = undefined
  for (const clean of cleaners.splice(0)) await clean()
  vi.restoreAllMocks()
})
const call = { sessionId: "session", agentId: "agent" }

type Settlement<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown }

/** Observe a promise once, immediately, so a rejection before the publication hook is never unhandled. */
const observe = <T>(pending: Promise<T>): Promise<Settlement<T>> =>
  pending.then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }))

/** Wait for the publication hook, but report an early commit settlement at once instead of hanging. */
async function awaitReached<T>(reached: Promise<void>, settlement: Promise<Settlement<T>>): Promise<void> {
  const first = await Promise.race([reached.then(() => "reached" as const), settlement.then(() => "settled" as const)])
  if (first !== "settled") return
  const outcome = await settlement
  if (!outcome.ok) throw outcome.error
  throw new Error("the commit completed before its publication was reached")
}
async function fixture(overwrite = false) {
  const dir = mkdtempSync(join(process.cwd(), ".export-test-")), binary = join(dir, "gws"), log = join(dir, "calls")
  writeFileSync(binary, `#!/bin/sh
if [ "$1" = "--version" ]; then echo 'gws 0.22.5'; exit 0; fi
echo "$*" >> '${log}'
dry=0; out=""
for arg in "$@"; do [ "$arg" = "--dry-run" ] && dry=1; done
while [ $# -gt 0 ]; do if [ "$1" = "--output" ]; then out="$2"; shift; fi; shift; done
if [ $dry = 0 ] && [ -n "$out" ]; then printf 'exported bytes' > "$out"; fi
printf '{"id":"fixture"}'
`)
  chmodSync(binary, 0o755)
  const runtime = await testRuntime({ binary: { path: binary }, accounts: { personal: account({ services: ["drive"] }) }, execution: { allowedWriteRoots: [dir] } })
  cleaners.push(async () => { await runtime.close(); rmSync(dir, { recursive: true, force: true }) })
  const destination = join(dir, "output.bin")
  if (overwrite) writeFileSync(destination, "original bytes")
  const plan = await runtime.plan(request("drive.files.get", { params: { fileId: "fixture", alt: "media" }, download: { path: destination, overwrite } }), call)
  const commits = () => readFileSync(log, "utf8").trim().split("\n").filter(line => !line.includes("--dry-run"))
  return { runtime, plan, destination, dir, commits }
}

describe("export delivery", () => {
  it("returns successful publication plus cleanupDegraded when sibling partial unlink fails", async () => {
    const f = await fixture()
    hooks.crossDevice = true
    hooks.failUnlink = true
    const result = await f.runtime.commit("export", { planId: f.plan.planId }, call)
    const partials = readdirSync(f.dir).filter(name => name.endsWith(".partial"))
    expect(result.ok).toBe(true)
    expect(result.cleanupDegraded).toBe(true)
    expect(readFileSync(f.destination, "utf8")).toBe("exported bytes")
    expect(partials).toHaveLength(1)
    expect(readFileSync(join(f.dir, partials[0]!), "utf8")).toBe("exported bytes")
    expect(f.runtime.plans.get(f.plan.planId)?.state).toBe("consumed")
    await expect(f.runtime.commit("export", { planId: f.plan.planId }, call)).rejects.toThrow(/PLAN_ALREADY_USED/)
  })

  it.each([false, true])("does not report degradation after successful cross-device cleanup (overwrite=%s)", async overwrite => {
    const f = await fixture(overwrite)
    hooks.crossDevice = true
    const result = await f.runtime.commit("export", { planId: f.plan.planId }, call)
    expect(result.ok).toBe(true)
    expect(result.cleanupDegraded).toBeUndefined()
    expect(readFileSync(f.destination, "utf8")).toBe("exported bytes")
    expect(readdirSync(f.dir).filter(name => name.endsWith(".partial"))).toEqual([])
  })

  it.each([false, true])("preserves the receipt when an already published final link or rename wins close (overwrite=%s)", async overwrite => {
    const f = await fixture(overwrite)
    hooks.crossDevice = true
    let entered!: () => void, release!: () => void
    const reached = new Promise<void>(resolve => { entered = resolve })
    const held = new Promise<void>(resolve => { release = resolve })
    const published: Array<{ method: string; from: string; to: string }> = []
    hooks.afterPublish = async publication => { published.push(publication); entered(); await held }
    const pending = f.runtime.commit("export", { planId: f.plan.planId }, call)
    const settled = observe(pending)
    try {
      await awaitReached(reached, settled)
      // The real destination-side final link or rename has succeeded before the test holds its return.
      expect(published).toEqual([{ method: overwrite ? "rename" : "link", from: expect.stringMatching(/\.partial$/), to: f.destination }])
      expect(readFileSync(f.destination, "utf8")).toBe("exported bytes")
      const close = f.runtime.close()
      release()
      const outcome = await settled
      await close
      if (!outcome.ok) throw outcome.error
      expect(outcome.value).toMatchObject({ ok: true, file: { path: f.destination, bytes: 14 } })
      expect(readFileSync(f.destination, "utf8")).toBe("exported bytes")
    } finally {
      release()
    }
  })

  it("returns CANCELLED when close lands before the cross-device fallback publication", async () => {
    const f = await fixture(true)
    hooks.crossDevice = true
    let entered!: () => void, release!: () => void
    const reached = new Promise<void>(resolve => { entered = resolve })
    const held = new Promise<void>(resolve => { release = resolve })
    const partials: string[] = []
    hooks.beforePartialOpen = async path => { partials.push(path); entered(); await held }
    const pending = f.runtime.commit("export", { planId: f.plan.planId }, call)
    const settled = observe(pending)
    try {
      await awaitReached(reached, settled)
      // The fallback has opened its sibling .partial, but has not published or touched the destination.
      expect(partials).toEqual([expect.stringMatching(/\.partial$/)])
      expect(readFileSync(f.destination, "utf8")).toBe("original bytes")
      const close = f.runtime.close()
      release()
      const outcome = await settled
      await close
      if (outcome.ok) throw new Error("expected the fallback publication to be cancelled")
      expect(String((outcome.error as { message?: string }).message ?? outcome.error)).toMatch(/^CANCELLED:/)
      expect(readFileSync(f.destination, "utf8")).toBe("original bytes")
      expect(readdirSync(f.dir).filter(name => name.endsWith(".partial"))).toEqual([])
    } finally {
      release()
    }
  })

  it("reports an early commit failure promptly when its publication hook is never reached", async () => {
    const never = new Promise<void>(() => undefined)
    const early = observe(Promise.reject(new Error("synthetic early failure")))
    const started = Date.now()
    await expect(awaitReached(never, early)).rejects.toThrow("synthetic early failure")
    expect(Date.now() - started).toBeLessThan(1000)
  })

  it.each(["cleanup failure", "close after publication"])("preserves a delivered export after %s", async mode => {
    const f = await fixture()
    if (mode === "cleanup failure") vi.spyOn(Stage.prototype, "dispose").mockRejectedValueOnce(new Error("synthetic cleanup failure"))
    else {
      const deliver = Stage.prototype.deliver
      vi.spyOn(Stage.prototype, "deliver").mockImplementation(async function (this: Stage, output, limits) {
        const receipt = await deliver.call(this, output, limits)
        void f.runtime.close()
        return receipt
      })
    }
    const output = await f.runtime.commit("export", { planId: f.plan.planId }, call)
    expect(output).toMatchObject({ ok: true, file: { path: f.destination, bytes: 14 } })
    expect(readFileSync(f.destination, "utf8")).toBe("exported bytes")
    expect(output.cleanupDegraded).toBe(mode === "cleanup failure" ? true : undefined)
    expect(f.commits()).toHaveLength(1)
  })

  it("does not publish an export after runtime revocation", async () => {
    const f = await fixture()
    const deliver = Stage.prototype.deliver
    vi.spyOn(Stage.prototype, "deliver").mockImplementation(async function (this: Stage, output, limits) {
      void f.runtime.close()
      return deliver.call(this, output, limits)
    })
    await expect(f.runtime.commit("export", { planId: f.plan.planId }, call)).rejects.toThrow(/^CANCELLED:/)
    expect(existsSync(f.destination)).toBe(false)
  })
})
