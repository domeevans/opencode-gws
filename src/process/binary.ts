import { createHash } from "node:crypto"
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import { GWS_TARGETS, type Platform, gwsPackage, gwsTarget } from "../domain/backend.js"
import type { PluginConfig } from "../domain/types.js"

/**
 * Resolve the `gws` binary. Without `binary.path` it is the unmodified
 * upstream binary from this platform's optional package, admitted by its
 * pinned SHA-256 and mode; there is no PATH lookup and no download. An
 * explicit `binary.path` is admitted by location and ownership here. The
 * runtime's probe then requires the exact version for both.
 */

const OVERRIDE = 'set "binary.path" to an absolute path to a gws 0.22.5 executable'

function isUnder(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))
}

function assertTrusted(path: string, projectDirectory: string | undefined): string {
  if (!isAbsolute(path)) throw new Error(`BINARY_TRUST_FAILED: Binary path must be absolute: ${path}`)
  if (!existsSync(path)) throw new Error(`GWS_UNAVAILABLE: The binary.path option names a missing file: ${path}. Next step: S${OVERRIDE.slice(1)}.`)
  const real = realpathSync(path)
  const stat = statSync(real)
  if (!stat.isFile()) throw new Error(`BINARY_TRUST_FAILED: Not a regular file: ${real}`)
  if ((stat.mode & 0o111) === 0 || (stat.mode & 0o022) !== 0) {
    throw new Error("BINARY_TRUST_FAILED: Binary must be executable and not group/world writable")
  }
  if (projectDirectory && isUnder(resolve(projectDirectory), real)) {
    throw new Error(`BINARY_TRUST_FAILED: Binary is inside the project directory: ${real}`)
  }
  const groups = new Set<number>()
  if (typeof process.getgid === "function") groups.add(process.getgid())
  if (typeof process.getgroups === "function") for (const gid of process.getgroups()) groups.add(gid)
  let dir = dirname(real)
  for (;;) {
    const stat = statSync(dir)
    const mode = stat.mode & 0o777
    if ((mode & 0o002) !== 0) {
      throw new Error(`BINARY_TRUST_FAILED: World-writable ancestor: ${dir} (mode ${mode.toString(8)})`)
    }
    // A group-writable ancestor is acceptable when the group is one the
    // current user belongs to; it is not acceptable for any other group.
    if ((mode & 0o020) !== 0 && !groups.has(stat.gid)) {
      throw new Error(`BINARY_TRUST_FAILED: Group-writable ancestor owned by a foreign group: ${dir} (mode ${mode.toString(8)}, gid ${stat.gid})`)
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return real
}

/** This process's platform; on Linux, glibc as reported by Node's diagnostic report header. */
export function currentPlatform(): Platform {
  let glibc = false
  if (process.platform === "linux") {
    const report = process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined
    glibc = typeof report?.header?.glibcVersionRuntime === "string"
  }
  return { os: process.platform, cpu: process.arch, glibc }
}

function describePlatform(platform: Platform): string {
  return `${platform.os} ${platform.cpu}${platform.os === "linux" ? (platform.glibc ? " (glibc)" : " (not glibc)") : ""}`
}

/** Packaged binaries already admitted, by real path, with the stat fields that identify those bytes. */
const admitted = new Map<string, string>()

/**
 * The gws binary from this platform's package, resolved from the plugin's
 * own location the way Node resolves a dependency. `from` is a module URL
 * or path inside the installed plugin.
 */
export function resolvePackagedBinary(platform: Platform = currentPlatform(), from: string = import.meta.url): string {
  const target = gwsTarget(platform)
  if (!target) {
    throw new Error(
      `GWS_UNAVAILABLE: No gws package supports ${describePlatform(platform)}; packages exist for macOS arm64 and x64 and Linux arm64 and x64 with glibc. Next step: S${OVERRIDE.slice(1)}.`,
    )
  }
  const name = gwsPackage(target)
  let manifest: string
  try {
    manifest = createRequire(from).resolve(`${name}/package.json`)
  } catch {
    throw new Error(
      `GWS_UNAVAILABLE: ${name} is not installed. Next step: Reinstall the plugin so npm installs its optional dependency for this platform (in a checkout, run npm run fetch:gws), or ${OVERRIDE}.`,
    )
  }
  const path = join(dirname(realpathSync(manifest)), "bin", "gws")
  if (!existsSync(path)) throw new Error(`GWS_UNAVAILABLE: ${name} has no bin/gws. Next step: Reinstall the plugin, or ${OVERRIDE}.`)
  const stat = lstatSync(path)
  // npm applies the installing user's umask to the archive's 0755 mode, so
  // admit any subset of 0755 that keeps owner read and execute.
  const mode = stat.mode & 0o7777
  if (!stat.isFile() || realpathSync(path) !== path || (mode & 0o500) !== 0o500 || (mode & ~0o755) !== 0) {
    throw new Error(`BINARY_TRUST_FAILED: ${name} bin/gws must be a regular file, not a link, with owner read/execute and no permissions outside 0755`)
  }
  const identity = `${stat.size}:${stat.mtimeMs}:${stat.ino}`
  if (admitted.get(path) === identity) return path
  if (createHash("sha256").update(readFileSync(path)).digest("hex") !== GWS_TARGETS[target]!.sha256) {
    throw new Error(`BINARY_TRUST_FAILED: ${name} bin/gws does not match the pinned ${target} release of gws 0.22.5`)
  }
  admitted.set(path, identity)
  return path
}

export function resolveBinary(config: PluginConfig, projectDirectory?: string): string {
  return config.binary.path ? assertTrusted(config.binary.path, projectDirectory) : resolvePackagedBinary()
}
