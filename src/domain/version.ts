/** package.json `version`, set at build time by scripts/bundle.mjs and in tests by vitest.config.ts. */
declare const __PLUGIN_VERSION__: string
export const PLUGIN_VERSION = __PLUGIN_VERSION__
export const PLUGIN_ID = "google-workspace.gws"

/** The tested OpenCode line; equal to package.json `opencode.host`. */
export const HOST_RANGE = ">=2.2.3 <2.3.0"

interface HostCheck {
  version: string
  /** Set when the host is outside the range and allowUntestedHost let setup continue. */
  warning?: string
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

/**
 * Refuse an OpenCode host outside the tested range, unless the operator set
 * allowUntestedHost; then continue and report the warning in status.
 */
export function checkHost(version: unknown, range: string, allowUntested: boolean): HostCheck {
  const text = typeof version === "string" && version.trim() ? version.trim() : "unknown"
  if (satisfies(text, range)) return { version: text }
  const problem = `tested with OpenCode ${range}, found ${text}`
  if (!allowUntested) {
    const [major, minor, patch] = bounds(range).floor
    throw new Error(
      `HOST_UNTESTED: Tested with OpenCode ${range}, found ${text}. Next step: Use OpenCode ${major}.${minor}.${patch} or a later ${major}.${minor}.x release, or set "allowUntestedHost": true.`,
    )
  }
  return { version: text, warning: `${problem}; running anyway because allowUntestedHost is true` }
}
