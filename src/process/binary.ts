import { existsSync, lstatSync, realpathSync, statSync } from "node:fs"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { GWS_TARGETS, type Platform, gwsTarget } from "../domain/backend.js"
import type { PluginConfig } from "../domain/types.js"
import { NativeError, cachedNative, installNative, readNativeManifest } from "./install.js"

/**
 * Resolve the `gws` binary. An explicit `binary.path` is admitted by location and ownership here. Without it, the
 * binary is the unmodified upstream gws 0.22.5 for this platform, which the plugin's release manifest pins: it is
 * downloaded on first use from the plugin's GitHub Release, checked against the manifest's sha256 values and the
 * upstream pin in GWS_TARGETS, then cached. There is no PATH lookup. The runtime's probe then requires the exact
 * version for both.
 */

const OVERRIDE = 'Set "binary.path" to an absolute path to a gws 0.22.5 executable'

/** What the resolver needs from the call: the cache, the network seam, and the access rules' say on a download. */
export interface NativeInput {
  /** The plugin's cache folder: the verified executable lives under it. */
  readonly cacheRoot: string
  /**
   * Called only when the binary is not cached and has to be downloaded. It may throw to refuse: the access rules deny
   * it under `read-only`, and ask under `ask-changes`. Without it, a missing binary is refused with the next step.
   */
  readonly mayDownload?: () => Promise<void>
  readonly signal?: AbortSignal
  readonly fetchImpl?: typeof fetch
}

function isUnder(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))
}

function assertTrusted(path: string, projectDirectory: string | undefined): string {
  if (!isAbsolute(path)) throw new Error(`BINARY_TRUST_FAILED: Binary path must be absolute: ${path}`)
  if (!existsSync(path)) throw new Error(`GWS_UNAVAILABLE: The binary.path option names a missing file: ${path}. Next step: ${OVERRIDE}.`)
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

/** The directory holding the nearest package.json above `from` (a module URL or a path inside the installed plugin). */
function packageRoot(from: string): string {
  let dir = dirname(from.startsWith("file:") ? fileURLToPath(from) : from)
  for (;;) {
    if (existsSync(join(dir, "package.json"))) return dir
    const parent = dirname(dir)
    if (parent === dir) throw new Error("GWS_UNAVAILABLE: The plugin's package folder was not found. Next step: Reinstall the plugin.")
    dir = parent
  }
}

/** Turns a native-installer refusal into this plugin's refusal, with its next step. */
function refusal(error: unknown): Error {
  if (!(error instanceof NativeError)) return error as Error
  const code = error.code === "NATIVE_HASH_MISMATCH" || error.code === "NATIVE_SIZE_MISMATCH" ? "BINARY_TRUST_FAILED" : "GWS_UNAVAILABLE"
  return new Error(`${code}: ${error.message.replace(/^NATIVE_[A-Z_]+: /, "")}. Next step: ${error.next}`)
}

/**
 * The cached executable must be a regular file, not a link, owner-executable and not writable by others. Its bytes
 * were checked against the manifest's sha256 (which equals the upstream pin, see resolvePackagedBinary) when it was
 * installed or found by `cachedNative`.
 */
function checkExecutable(path: string): string {
  const stat = lstatSync(path)
  // A download is installed with mode 0755; admit any subset of 0755 that keeps owner read and execute.
  const mode = stat.mode & 0o7777
  if (!stat.isFile() || (mode & 0o500) !== 0o500 || (mode & ~0o755) !== 0) {
    throw new Error(`BINARY_TRUST_FAILED: The cached gws must be a regular file, not a link, with owner read/execute and no permissions outside 0755. Next step: Remove ${path}, then call the tool again.`)
  }
  return path
}

/**
 * The gws binary for this platform, from the plugin's release manifest: the cached copy when it verifies, otherwise a
 * download, which `mayDownload` must allow first. The manifest must pin the upstream gws 0.22.5 for the platform.
 */
export async function resolvePackagedBinary(native: NativeInput, platform: Platform = currentPlatform(), from: string = import.meta.url): Promise<string> {
  const target = gwsTarget(platform)
  if (!target) {
    throw new Error(`GWS_UNAVAILABLE: No gws binary is released for ${describePlatform(platform)}; releases exist for macOS arm64 and x64 and Linux arm64 and x64 with glibc. Next step: ${OVERRIDE}.`)
  }
  const manifest = await readNativeManifest(packageRoot(from))
  if (manifest === undefined) {
    throw new Error(`GWS_UNAVAILABLE: This copy of the plugin has no release manifest, so it names no gws binary. Next step: ${OVERRIDE}, or install a release of the plugin.`)
  }
  const entry = manifest.modules.gws?.[target]
  if (entry === undefined || entry.executable.sha256 !== GWS_TARGETS[target]!.sha256) {
    throw new Error(`BINARY_TRUST_FAILED: The release manifest does not pin the upstream gws 0.22.5 for ${target}. Next step: Reinstall the plugin from a release whose manifest is valid.`)
  }
  const options = { manifest, module: "gws", key: target, cacheRoot: native.cacheRoot, installCommand: "/gws-install", signal: native.signal, fetchImpl: native.fetchImpl }
  let path = await cachedNative(options)
  if (path === undefined) {
    if (native.mayDownload === undefined) {
      throw new Error("GWS_UNAVAILABLE: gws is not installed yet. Next step: Run /gws-install, which downloads and verifies it.")
    }
    await native.mayDownload()
    try {
      path = (await installNative(options)).path
    } catch (error) {
      throw refusal(error)
    }
  }
  return checkExecutable(path)
}

/** The configured binary (admitted by location and ownership), or the release's gws for this platform. */
export async function resolveBinary(config: PluginConfig, projectDirectory: string | undefined, native: NativeInput): Promise<string> {
  return config.binary.path ? assertTrusted(config.binary.path, projectDirectory) : resolvePackagedBinary(native)
}
