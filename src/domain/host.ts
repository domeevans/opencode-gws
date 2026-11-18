/**
 * The OpenCode hosts the plugin supports and is tested on. No build-time
 * constant, so the runtime and every test can import it.
 */

/** The supported OpenCode line; equal to package.json `opencode.host`. */
export const HOST_RANGE = ">=2.2.3 <2.4.0"

/**
 * The OpenCode releases the checks run on (the host, pack and stock stages).
 * The one list: scripts/pack-smoke.mjs reads it from this file.
 */
export const TESTED_HOSTS: readonly string[] = ["2.2.3", "2.2.4", "2.2.5", "2.2.6", "2.2.7", "2.3.0", "2.3.1", "2.3.2"]

/** The host as status reports it. */
export interface HostCheck {
  /** null when the host gave no version. */
  version: string | null
  range: string
  /** True only for a release in TESTED_HOSTS. */
  tested: boolean
}

type Triple = [number, number, number]

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
const RANGE = /^>=(\d+)\.(\d+)\.(\d+) <(\d+)\.(\d+)\.(\d+)$/

function compare(a: Triple, b: Triple): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2]
}

/**
 * The one supported range form, `>=A.B.C <D.E.F`: at or above the floor and
 * below the ceiling. A prerelease, such as a 0.0.0-dev build, is outside it.
 */
function bounds(range: string): { floor: Triple; ceiling: Triple } {
  const parts = RANGE.exec(range)?.slice(1).map(Number)
  if (!parts) throw new Error(`invalid host range ${range}`)
  return { floor: parts.slice(0, 3) as Triple, ceiling: parts.slice(3) as Triple }
}

function satisfies(version: string, range: string): boolean {
  const { floor, ceiling } = bounds(range)
  const found = SEMVER.exec(version)
  if (!found || found[4]) return false
  const triple = found.slice(1, 4).map(Number) as Triple
  return compare(triple, floor) >= 0 && compare(triple, ceiling) < 0
}

/** The minor lines a range spans, as prose: `2.2 or 2.3` for `>=2.2.3 <2.4.0`, `2.2` for `>=2.2.3 <2.3.0`. */
function lines(floor: Triple, ceiling: Triple): string {
  const last = ceiling[0] === floor[0] && ceiling[2] === 0 ? ceiling[1] - 1 : floor[1]
  const minors = Array.from({ length: Math.max(1, last - floor[1] + 1) }, (_, i) => `${floor[0]}.${floor[1] + i}`)
  return minors.length === 1 ? minors[0] : `${minors.slice(0, -1).join(", ")} or ${minors.at(-1)}`
}

/**
 * Refuse an OpenCode host outside the supported range, unless the operator
 * set allowUntestedHost. A host inside the range but not in TESTED_HOSTS
 * starts, and status reports it as untested.
 */
export function checkHost(version: unknown, range: string, allowUntested: boolean): HostCheck {
  const text = typeof version === "string" && version.trim() ? version.trim() : undefined
  if (!(text && satisfies(text, range)) && !allowUntested) {
    const { floor, ceiling } = bounds(range)
    throw new Error(
      `HOST_UNTESTED: Supports OpenCode ${range}, found ${text ?? "unknown"}. Next step: Use OpenCode ${floor.join(".")} or a later ${lines(floor, ceiling)} release, or set "allowUntestedHost": true.`,
    )
  }
  return { version: text ?? null, range, tested: text !== undefined && TESTED_HOSTS.includes(text.replace(/^v/, "")) }
}
