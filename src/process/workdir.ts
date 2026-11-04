import { lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

/**
 * The runtime's private work folder, `$TMPDIR/opencode-gws-XXXXXX`, and the
 * clean-up of folders a server left behind when it stopped without closing.
 * Each folder records the process that owns it in `owner.pid`.
 */

const PREFIX = "opencode-gws-"
const OWNER = "owner.pid"
const DAY_MS = 24 * 60 * 60 * 1000
/** A folder with no owner record (from 0.0.2 or earlier, or a version probe) is removed only after a week. */
const UNOWNED_MS = 7 * DAY_MS

/** Create the work folder: 0700, with an empty `.env` so gws reads none from a parent folder, and the owner record. */
export function createWorkDir(root = tmpdir()): string {
  const dir = mkdtempSync(join(root, PREFIX))
  writeFileSync(join(dir, ".env"), "")
  writeFileSync(join(dir, OWNER), `${process.pid}\n`, { mode: 0o600 })
  return dir
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

/**
 * Remove this user's `opencode-gws-*` work folders that are older than a
 * day and whose owning process is gone (a week, for a folder with no owner
 * record). Never follows a link, and never touches another user's folder.
 * Best effort: a failure leaves the folder. Returns the folders removed.
 */
export function removeStaleWorkDirs(root = tmpdir(), now = Date.now()): string[] {
  const removed: string[] = []
  let names: string[]
  try {
    names = readdirSync(root)
  } catch {
    return removed
  }
  const uid = process.getuid?.()
  for (const name of names) {
    if (!/^opencode-gws-(?:probe-)?[A-Za-z0-9]{6}$/.test(name)) continue
    const dir = join(root, name)
    try {
      const stat = lstatSync(dir)
      if (!stat.isDirectory() || (uid !== undefined && stat.uid !== uid)) continue
      const age = now - stat.mtimeMs
      if (age < DAY_MS) continue
      let owner: number | undefined
      try {
        owner = Number.parseInt(readFileSync(join(dir, OWNER), "utf8"), 10)
      } catch {
        owner = undefined
      }
      const stale = owner !== undefined && Number.isInteger(owner) && owner > 0 ? !alive(owner) : age >= UNOWNED_MS
      if (!stale) continue
      rmSync(dir, { recursive: true, force: true })
      removed.push(dir)
    } catch {
      /* best effort: leave it */
    }
  }
  return removed
}
