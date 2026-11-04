import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createWorkDir, removeStaleWorkDirs } from "../src/process/workdir.js"

const DAY = 24 * 60 * 60 * 1000
const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function root(): string {
  const dir = mkdtempSync(join(tmpdir(), "gws-workdir-test-"))
  roots.push(dir)
  return dir
}

/** A work folder last changed `days` ago, owned by `pid` (none: no owner record, as 0.0.2 left them). */
function folder(parent: string, name: string, days: number, pid?: number): string {
  const dir = join(parent, name)
  mkdirSync(join(dir, "home"), { recursive: true })
  writeFileSync(join(dir, ".env"), "")
  if (pid !== undefined) writeFileSync(join(dir, "owner.pid"), `${pid}\n`)
  const when = new Date(Date.now() - days * DAY)
  utimesSync(dir, when, when)
  return dir
}

/** A process id that has exited. */
function deadPid(): number {
  return spawnSync(process.execPath, ["-e", ""]).pid!
}

describe("work folders", () => {
  it("creates a private folder with an empty .env and its owner", () => {
    const dir = createWorkDir(root())
    expect(statSync(dir).mode & 0o777).toBe(0o700)
    expect(readFileSync(join(dir, ".env"), "utf8")).toBe("")
    expect(readFileSync(join(dir, "owner.pid"), "utf8")).toBe(`${process.pid}\n`)
  })

  it("removes only old folders whose owner is gone, or unowned ones older than a week", () => {
    const parent = root()
    const dead = folder(parent, "opencode-gws-aaaaaa", 2, deadPid())
    const running = folder(parent, "opencode-gws-bbbbbb", 2, process.pid)
    const recent = folder(parent, "opencode-gws-cccccc", 0.5, deadPid())
    const unownedRecent = folder(parent, "opencode-gws-dddddd", 3)
    const unownedOld = folder(parent, "opencode-gws-probe-eeeeee", 8)
    const other = folder(parent, "opencode-gws-pack-ffffff", 30)
    const target = folder(parent, "elsewhere", 30)
    symlinkSync(target, join(parent, "opencode-gws-gggggg"))
    writeFileSync(join(parent, "opencode-gws-hhhhhh"), "")

    expect(removeStaleWorkDirs(parent).sort()).toEqual([dead, unownedOld].sort())
    for (const kept of [running, recent, unownedRecent, other, target, join(parent, "opencode-gws-gggggg"), join(parent, "opencode-gws-hhhhhh")]) expect(existsSync(kept), kept).toBe(true)
  })

  it("never fails on a missing folder", () => {
    expect(removeStaleWorkDirs(join(root(), "missing"))).toEqual([])
  })
})
