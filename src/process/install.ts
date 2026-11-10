// The shared native-binary installer (kit v1, D19b). Byte-identical in every native plugin: change it here, then copy
// it. It imports only Node built-ins. Each plugin passes in its names, its platform key, its cache root and its install
// command; the policy (who may download, and when) and the plugin's own trust checks stay at the call site.
//
// A plugin's release commit carries `manifest/native.json`, which pins, for each module and platform, the release
// asset (gzip) by its sha256 and the executable it holds by its size and sha256. Nothing runs until both match.
import { createHash, randomUUID } from "node:crypto"
import { constants, createReadStream, createWriteStream } from "node:fs"
import { chmod, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises"
import { dirname, join } from "node:path"
import { createGunzip } from "node:zlib"

export type NativeCode =
  | "NATIVE_MANIFEST_MISSING"
  | "NATIVE_MANIFEST_INVALID"
  | "NATIVE_UNSUPPORTED_PLATFORM"
  | "NATIVE_NOT_INSTALLED"
  | "NATIVE_NETWORK"
  | "NATIVE_NOT_FOUND"
  | "NATIVE_HASH_MISMATCH"
  | "NATIVE_SIZE_MISMATCH"
  | "NATIVE_STALLED"
  | "NATIVE_CANCELLED"
  | "NATIVE_WRITE_FAILED"

/** A refusal with a code, what happened, and the next step. The plugin wraps it in its own error shape. */
export class NativeError extends Error {
  readonly code: NativeCode
  readonly next: string
  constructor(code: NativeCode, what: string, next: string) {
    super(`${code}: ${what}`)
    this.name = "NativeError"
    this.code = code
    this.next = next
  }
}

export interface NativeExecutable {
  readonly name: string
  readonly bytes: number
  readonly sha256: string
}

export interface NativeAsset {
  readonly name: string
  readonly url: string
  readonly bytes: number
  readonly sha256: string
  readonly executable: NativeExecutable
}

export interface NativeManifest {
  readonly schema: 1
  readonly plugin: string
  readonly repository: string
  readonly tag: string
  readonly built: { readonly commit: string; readonly run: number; readonly workflow: string }
  readonly modules: Readonly<Record<string, Readonly<Record<string, NativeAsset>>>>
}

export interface NativeOptions {
  readonly manifest: NativeManifest
  /** The module's name in the manifest, for example `gws` or `aurum`. */
  readonly module: string
  /** The platform key in the manifest, for example `darwin-arm64` or `linux-x64-gnu`. */
  readonly key: string
  /** The plugin's cache folder. The executable goes in `<cacheRoot>/native/<tag>/<module>/<key>/`. */
  readonly cacheRoot: string
  /** The command a person runs to download it, named in the next step, for example `/gws-install`. */
  readonly installCommand: string
  readonly signal?: AbortSignal
  /** The network seam. Tests pass a fake; the default is the global fetch. */
  readonly fetchImpl?: typeof fetch
  /** Longest silence, in milliseconds, before a download is abandoned. */
  readonly stallMs?: number
  readonly log?: (message: string) => void
}

const HEX64 = /^[a-f0-9]{64}$/
const HEX40 = /^[a-f0-9]{40}$/
const DEFAULT_STALL_MS = 120_000

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const invalid = (what: string): never => {
  throw new NativeError("NATIVE_MANIFEST_INVALID", `the release manifest ${what}`, "Reinstall the plugin from a release whose manifest is valid.")
}

const plain = (value: unknown, field: string): string => {
  if (typeof value !== "string" || value === "" || value.includes("/") || value.includes("\\") || value === "." || value === "..") invalid(`has a bad file name in ${field}`)
  return value as string
}

const positive = (value: unknown, field: string): number => {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) invalid(`has a bad size in ${field}`)
  return value as number
}

const digest = (value: unknown, field: string): string => {
  if (typeof value !== "string" || !HEX64.test(value)) invalid(`has a bad sha256 in ${field}`)
  return value as string
}

/** Validates a parsed `manifest/native.json`. Every URL must be the release asset of this repository and tag. */
export function parseNativeManifest(raw: unknown): NativeManifest {
  if (!isRecord(raw)) invalid("is not an object")
  const { schema, plugin, repository, tag, built, modules } = raw as Record<string, unknown>
  if (schema !== 1) invalid("has an unknown schema")
  if (typeof plugin !== "string" || typeof tag !== "string" || typeof repository !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(repository)) {
    invalid("names no repository or tag")
  }
  if (!isRecord(built) || typeof built.commit !== "string" || !HEX40.test(built.commit) || !Number.isInteger(built.run) || typeof built.workflow !== "string") {
    invalid("has a bad build record")
  }
  if (!isRecord(modules)) invalid("has no modules")
  const out: Record<string, Record<string, NativeAsset>> = {}
  for (const [module, platformsValue] of Object.entries(modules as Record<string, unknown>)) {
    if (!isRecord(platformsValue)) invalid(`has a bad module ${module}`)
    const platforms: Record<string, NativeAsset> = {}
    out[module] = platforms
    for (const [key, value] of Object.entries(platformsValue as Record<string, unknown>)) {
      if (!isRecord(value) || !isRecord(value.executable)) invalid(`has a bad entry for ${module} ${key}`)
      const asset = value as Record<string, unknown>
      const exe = asset.executable as Record<string, unknown>
      const name = plain(asset.name, `${module} ${key}`)
      const url = asset.url
      const expected = `https://github.com/${repository}/releases/download/${tag}/${name}`
      if (url !== expected) invalid(`names a URL other than the release asset for ${module} ${key}`)
      platforms[key] = {
        name,
        url: url as string,
        bytes: positive(asset.bytes, `${module} ${key}`),
        sha256: digest(asset.sha256, `${module} ${key}`),
        executable: {
          name: plain(exe.name, `${module} ${key} executable`),
          bytes: positive(exe.bytes, `${module} ${key} executable`),
          sha256: digest(exe.sha256, `${module} ${key} executable`),
        },
      }
    }
  }
  const build = built as { commit: string; run: number; workflow: string }
  return { schema: 1, plugin: plugin as string, repository: repository as string, tag: tag as string, built: { commit: build.commit, run: build.run, workflow: build.workflow }, modules: out }
}

/** The package's release manifest, or undefined when this copy has none (a development checkout). */
export async function readNativeManifest(packageRoot: string): Promise<NativeManifest | undefined> {
  let text: string
  try {
    text = await readFile(join(packageRoot, "manifest", "native.json"), "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
  try {
    return parseNativeManifest(JSON.parse(text))
  } catch (error) {
    if (error instanceof NativeError) throw error
    return invalid("is not JSON")
  }
}

/** The manifest entry for this module and platform key. */
export function entryFor(options: Pick<NativeOptions, "manifest" | "module" | "key">): NativeAsset {
  const entry = options.manifest.modules[options.module]?.[options.key]
  if (entry === undefined) {
    throw new NativeError(
      "NATIVE_UNSUPPORTED_PLATFORM",
      `the release has no ${options.module} for ${options.key}`,
      "Set the plugin's binary path option to an executable of the pinned version, or use a supported platform.",
    )
  }
  return entry
}

/** Where the verified executable lives. */
export function cachePath(options: NativeOptions): string {
  const entry = entryFor(options)
  return join(options.cacheRoot, "native", options.manifest.tag, options.module, options.key, entry.executable.name)
}

async function sha256File(path: string): Promise<{ bytes: number; sha256: string }> {
  const hash = createHash("sha256")
  let bytes = 0
  for await (const chunk of createReadStream(path)) {
    bytes += (chunk as Buffer).byteLength
    hash.update(chunk as Buffer)
  }
  return { bytes, sha256: hash.digest("hex") }
}

/** True when the file is the pinned size and sha256. A missing or unreadable file is not verified. */
export async function verifiedFile(path: string, expected: { bytes: number; sha256: string }): Promise<boolean> {
  try {
    const info = await stat(path)
    if (!info.isFile() || info.size !== expected.bytes) return false
    return (await sha256File(path)).sha256 === expected.sha256
  } catch {
    return false
  }
}

/** The cached, verified executable's path, or undefined when it must be downloaded. Downloads nothing. */
export async function cachedNative(options: NativeOptions): Promise<string | undefined> {
  const entry = entryFor(options)
  const path = cachePath(options)
  return (await verifiedFile(path, { bytes: entry.executable.bytes, sha256: entry.executable.sha256 })) ? path : undefined
}

const nameOf = (options: NativeOptions) => entryFor(options).name

function fail(code: NativeCode, what: string, options: NativeOptions): never {
  const next: Record<NativeCode, string> = {
    NATIVE_MANIFEST_MISSING: "Set the plugin's binary path option to an executable of the pinned version, or install a release of the plugin.",
    NATIVE_MANIFEST_INVALID: "Reinstall the plugin from a release whose manifest is valid.",
    NATIVE_UNSUPPORTED_PLATFORM: "Set the plugin's binary path option to an executable of the pinned version, or use a supported platform.",
    NATIVE_NOT_INSTALLED: `Run ${options.installCommand}, which downloads and verifies it.`,
    NATIVE_NETWORK: "Check the network or proxy, then call the tool again.",
    NATIVE_NOT_FOUND: "The release is missing this file. Report it; do not retry.",
    NATIVE_HASH_MISMATCH: "The download was discarded. Call the tool again; if it persists, report that the release does not match its manifest.",
    NATIVE_SIZE_MISMATCH: "Call the tool again; if it persists, report that the release does not match its manifest.",
    NATIVE_STALLED: "Call the tool again.",
    NATIVE_CANCELLED: "Call the tool again if you still need the result.",
    NATIVE_WRITE_FAILED: "Check that the plugin's cache folder is writable, then call the tool again.",
  }
  throw new NativeError(code, what, next[code])
}

/**
 * Makes the executable available: the verified cached copy, or a download of the pinned asset. The download is checked
 * twice before anything runs: the asset's size and sha256 as it arrives, then the executable's size and sha256 after
 * it is decompressed. Only then is it renamed into the cache, so the final path never holds unverified bytes.
 */
export async function installNative(options: NativeOptions): Promise<{ path: string; downloaded: boolean }> {
  const entry = entryFor(options)
  const target = cachePath(options)
  if (await verifiedFile(target, { bytes: entry.executable.bytes, sha256: entry.executable.sha256 })) return { path: target, downloaded: false }

  if (options.signal?.aborted) fail("NATIVE_CANCELLED", `the download of ${entry.name} was cancelled before it started`, options)
  const dir = dirname(target)
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 })
  } catch {
    fail("NATIVE_WRITE_FAILED", `the cache folder ${dir} cannot be created`, options)
  }
  const id = randomUUID()
  const asset = `${target}.${id}.gz`
  const exe = `${target}.${id}.part`
  try {
    await download(options, entry, asset)
    await decompress(options, entry, asset, exe)
    await chmod(exe, 0o755)
    await rename(exe, target)
    options.log?.(`installed ${entry.name} (${entry.bytes} bytes) for ${options.module}`)
    return { path: target, downloaded: true }
  } finally {
    await rm(asset, { force: true })
    await rm(exe, { force: true })
  }
}

async function download(options: NativeOptions, entry: NativeAsset, path: string): Promise<void> {
  const stall = new AbortController()
  const request = options.signal ? AbortSignal.any([options.signal, stall.signal]) : stall.signal
  const limit = options.stallMs ?? DEFAULT_STALL_MS
  let watchdog = setTimeout(() => stall.abort(), limit)
  const reset = () => {
    clearTimeout(watchdog)
    watchdog = setTimeout(() => stall.abort(), limit)
  }
  const failure = (error: unknown): never => {
    if (error instanceof NativeError) throw error
    if (stall.signal.aborted) fail("NATIVE_STALLED", `the download of ${entry.name} stopped for ${Math.round(limit / 1000)} seconds`, options)
    if (options.signal?.aborted) fail("NATIVE_CANCELLED", `the download of ${entry.name} was cancelled`, options)
    fail("NATIVE_NETWORK", `the download of ${entry.name} failed (${(error as Error).message})`, options)
  }
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    const response = await (options.fetchImpl ?? fetch)(entry.url, { signal: request, redirect: "follow" }).catch(failure)
    if (response.status === 404) fail("NATIVE_NOT_FOUND", `${entry.name} is not in the release`, options)
    if (!response.ok || response.body === null) fail("NATIVE_NETWORK", `the download of ${entry.name} returned HTTP ${response.status}`, options)
    handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    const hash = createHash("sha256")
    let received = 0
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      reset()
      received += chunk.byteLength
      if (received > entry.bytes) fail("NATIVE_SIZE_MISMATCH", `${entry.name} is larger than its pinned ${entry.bytes} bytes`, options)
      hash.update(chunk)
      await handle.write(chunk)
    }
    if (received !== entry.bytes) fail("NATIVE_SIZE_MISMATCH", `${entry.name} is ${received} bytes, not the pinned ${entry.bytes}`, options)
    if (hash.digest("hex") !== entry.sha256) fail("NATIVE_HASH_MISMATCH", `${entry.name} does not match its pinned sha256, so it was discarded`, options)
    await handle.sync()
  } catch (error) {
    failure(error)
  } finally {
    clearTimeout(watchdog)
    await handle?.close().catch(() => undefined)
  }
}

async function decompress(options: NativeOptions, entry: NativeAsset, source: string, target: string): Promise<void> {
  const write = createWriteStream(target, { flags: "wx", mode: 0o600 })
  // An error is reported by `end` below; without a listener, the stream's own error event would end the process.
  write.on("error", () => undefined)
  const gunzip = createGunzip()
  const hash = createHash("sha256")
  let bytes = 0
  try {
    for await (const chunk of createReadStream(source).pipe(gunzip)) {
      bytes += (chunk as Buffer).byteLength
      if (bytes > entry.executable.bytes) fail("NATIVE_HASH_MISMATCH", `the decompressed ${entry.executable.name} is larger than its pinned size`, options)
      hash.update(chunk as Buffer)
      if (!write.write(chunk)) await new Promise<void>((resolve) => write.once("drain", () => resolve()))
    }
  } catch (error) {
    if (error instanceof NativeError) throw error
    fail("NATIVE_HASH_MISMATCH", `${nameOf(options)} does not decompress, so it was discarded`, options)
  } finally {
    await new Promise<void>((resolve, reject) => {
      write.once("error", reject)
      write.end(() => {
        resolve()
      })
    }).catch(() => fail("NATIVE_WRITE_FAILED", `the cache folder ${dirname(target)} cannot be written`, options))
  }
  if (bytes !== entry.executable.bytes || hash.digest("hex") !== entry.executable.sha256) {
    fail("NATIVE_HASH_MISMATCH", `${entry.executable.name} does not match its pinned sha256, so it was discarded`, options)
  }
}
