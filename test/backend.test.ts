import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { gzipSync } from "node:zlib"
import { afterEach, describe, expect, it } from "vitest"
import { GWS_TARGETS, GWS_VERSION, gwsTarget } from "../src/domain/backend.js"
import { loadManifest } from "../src/domain/manifest.js"
import { currentPlatform, type NativeInput, resolveBinary, resolvePackagedBinary } from "../src/process/binary.js"
import { account, testConfig, testRuntime } from "./support/config.js"
import { pinnedGwsPath } from "./support/pinned.js"

const root = fileURLToPath(new URL("../", import.meta.url))
const provenance = JSON.parse(readFileSync(join(root, "native/provenance.json"), "utf8")) as {
  version: string
  targets: Record<string, { os: string; cpu: string; libc?: string; binary: { sha256: string } }>
}
const platform = currentPlatform()
const target = gwsTarget(platform)
const REPO = "joe-broadhead/opencode-gws"
const TAG = "v0.0.0"

const dirs: string[] = []
function temporary(base = tmpdir()) {
  const dir = realpathSync(mkdtempSync(join(base, ".backend-test-")))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** The verified upstream executable for this platform, fetched by `npm run fetch:gws`. */
function pinnedBinary(): Buffer {
  return readFileSync(pinnedGwsPath())
}

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
let pinnedGzip: Buffer | undefined
const gzip = () => (pinnedGzip ??= gzipSync(pinnedBinary(), { level: 9 }))

/** A plugin package root with a release manifest that pins `gzip`, for this platform. */
function release(overrides: { gz?: Buffer; executableSha?: string; withManifest?: boolean } = {}) {
  const root2 = temporary()
  const pkg = join(root2, "dist")
  mkdirSync(pkg, { recursive: true })
  writeFileSync(join(root2, "package.json"), JSON.stringify({ name: "github:joe-broadhead/opencode-gws#v0.0.0", version: "0.0.0" }))
  const gz = overrides.gz ?? gzip()
  const exe = pinnedBinary()
  if (overrides.withManifest !== false) {
    mkdirSync(join(root2, "manifest"))
    writeFileSync(join(root2, "manifest", "native.json"), JSON.stringify({
      schema: 1,
      plugin: "opencode-gws",
      repository: REPO,
      tag: TAG,
      built: { commit: "a".repeat(40), run: 1, workflow: "native" },
      modules: {
        gws: {
          [target!]: {
            name: `gws-${target}.gz`,
            url: `https://github.com/${REPO}/releases/download/${TAG}/gws-${target}.gz`,
            bytes: gz.byteLength,
            sha256: sha(gz),
            executable: { name: "gws", bytes: exe.byteLength, sha256: overrides.executableSha ?? provenance.targets[target!]!.binary.sha256 },
          },
        },
      },
    }))
  }
  return { from: join(pkg, "index.js"), root: root2, gz }
}

/** The network seam: serves `body` for the release asset. */
function serving(body: Uint8Array, calls: string[] = []): typeof fetch {
  return (async (input: Request | URL | string) => {
    calls.push(String(input))
    return new Response(body as unknown as BodyInit, { status: 200 })
  }) as typeof fetch
}

function native(cacheRoot: string, extra: Partial<NativeInput> = {}): NativeInput {
  return { cacheRoot, mayDownload: async () => undefined, fetchImpl: serving(gzip()), ...extra }
}

describe("pinned release", () => {
  it("mirrors native/provenance.json and the manifest's gws version", () => {
    expect(GWS_VERSION).toBe(`gws ${provenance.version}`)
    expect(loadManifest().gwsVersion).toBe(GWS_VERSION)
    expect(Object.keys(GWS_TARGETS).sort()).toEqual(Object.keys(provenance.targets).sort())
    for (const [name, entry] of Object.entries(provenance.targets)) {
      expect(GWS_TARGETS[name], name).toEqual({ os: entry.os, cpu: entry.cpu, ...(entry.libc ? { libc: entry.libc } : {}), sha256: entry.binary.sha256 })
    }
  })

  it("maps macOS arm64 and x64 and Linux arm64 and x64 with glibc to their target, and nothing else", () => {
    expect(gwsTarget({ os: "darwin", cpu: "arm64", glibc: false })).toBe("darwin-arm64")
    expect(gwsTarget({ os: "darwin", cpu: "x64", glibc: false })).toBe("darwin-x64")
    expect(gwsTarget({ os: "linux", cpu: "arm64", glibc: true })).toBe("linux-arm64-gnu")
    expect(gwsTarget({ os: "linux", cpu: "x64", glibc: true })).toBe("linux-x64-gnu")
    for (const other of [
      { os: "linux", cpu: "x64", glibc: false },
      { os: "linux", cpu: "arm64", glibc: false },
      { os: "linux", cpu: "ia32", glibc: true },
      { os: "win32", cpu: "x64", glibc: false },
      { os: "freebsd", cpu: "x64", glibc: false },
    ]) expect(gwsTarget(other), JSON.stringify(other)).toBeUndefined()
  })
})

describe("the release binary", () => {
  it("downloads the release's gzip on first use, checks both hashes, caches it, and runs gws 0.22.5", async () => {
    const { from } = release()
    const cache = temporary()
    const calls: string[] = []
    const asks: string[] = []
    const binary = await resolvePackagedBinary(native(cache, { fetchImpl: serving(gzip(), calls), mayDownload: async () => { asks.push("ask") } }), platform, from)
    expect(calls).toEqual([`https://github.com/${REPO}/releases/download/${TAG}/gws-${target}.gz`])
    expect(asks).toEqual(["ask"])
    expect(binary.startsWith(cache)).toBe(true)
    const version = execFileSync(binary, ["--version"], { env: { PATH: "/usr/bin:/bin" }, encoding: "utf8" })
    expect(version.split("\n")[0]).toBe(GWS_VERSION)
  })

  it("uses the cached copy without asking or downloading again", async () => {
    const { from } = release()
    const cache = temporary()
    await resolvePackagedBinary(native(cache), platform, from)
    const calls: string[] = []
    await resolvePackagedBinary(native(cache, { fetchImpl: serving(gzip(), calls), mayDownload: async () => { throw new Error("asked") } }), platform, from)
    expect(calls).toEqual([])
  })

  it("is refused, and never downloaded, when mayDownload refuses (the access rules deny or the person says no)", async () => {
    const { from } = release()
    const calls: string[] = []
    await expect(resolvePackagedBinary(native(temporary(), { fetchImpl: serving(gzip(), calls), mayDownload: async () => { throw new Error("denied") } }), platform, from)).rejects.toThrow("denied")
    expect(calls).toEqual([])
  })

  it("without mayDownload, a missing binary is refused with the command that downloads it", async () => {
    const { from } = release()
    await expect(resolvePackagedBinary({ cacheRoot: temporary() }, platform, from)).rejects.toThrow(
      "GWS_UNAVAILABLE: gws is not installed yet. Next step: Run /gws-install, which downloads and verifies it.",
    )
  })

  it("fails with GWS_UNAVAILABLE, and the override, when the copy has no release manifest", async () => {
    const { from } = release({ withManifest: false })
    await expect(resolvePackagedBinary(native(temporary()), platform, from)).rejects.toThrow(
      /^GWS_UNAVAILABLE: This copy of the plugin has no release manifest, so it names no gws binary\. Next step: Set "binary\.path" to an absolute path to a gws 0\.22\.5 executable, or install a release of the plugin\.$/,
    )
  })

  it("refuses a manifest that pins other bytes than the upstream gws 0.22.5, before any download", async () => {
    const { from } = release({ executableSha: "0".repeat(64) })
    const calls: string[] = []
    await expect(resolvePackagedBinary(native(temporary(), { fetchImpl: serving(gzip(), calls) }), platform, from)).rejects.toThrow(/^BINARY_TRUST_FAILED: The release manifest does not pin the upstream gws 0\.22\.5/)
    expect(calls).toEqual([])
  })

  it("refuses a download whose bytes are not the pinned asset, and leaves nothing in the cache", async () => {
    const { from } = release()
    const cache = temporary()
    const tampered = Buffer.from(gzip())
    tampered[tampered.length - 1] ^= 0xff
    await expect(resolvePackagedBinary(native(cache, { fetchImpl: serving(tampered) }), platform, from)).rejects.toThrow(
      /^BINARY_TRUST_FAILED: gws-.*\.gz does not match its pinned sha256, so it was discarded\. Next step: The download was discarded\./,
    )
    expect(existsSync(join(cache, "native", TAG, "gws", target!, "gws"))).toBe(false)
  })

  it("maps a 404 and a network failure to GWS_UNAVAILABLE with their next steps", async () => {
    const { from } = release()
    const notFound = (async () => new Response("", { status: 404 })) as typeof fetch
    await expect(resolvePackagedBinary(native(temporary(), { fetchImpl: notFound }), platform, from)).rejects.toThrow(/^GWS_UNAVAILABLE: .*is not in the release\. Next step: The release is missing this file\. Report it; do not retry\.$/)
    const offline = (async () => { throw new TypeError("fetch failed") }) as typeof fetch
    await expect(resolvePackagedBinary(native(temporary(), { fetchImpl: offline }), platform, from)).rejects.toThrow(/^GWS_UNAVAILABLE: .*Next step: Check the network or proxy, then call the tool again\.$/)
  })

  it("refuses a cached copy whose mode is unsafe, even when its bytes are right", async () => {
    const { from } = release()
    const cache = temporary()
    const { path } = { path: await resolvePackagedBinary(native(cache), platform, from) }
    chmodSync(path, 0o775)
    await expect(resolvePackagedBinary(native(cache), platform, from)).rejects.toThrow(/^BINARY_TRUST_FAILED: The cached gws must be a regular file/)
  })

  it("refuses a cached copy that is a link, not the file it names", async () => {
    const { from } = release()
    const cache = temporary()
    const path = await resolvePackagedBinary(native(cache), platform, from)
    const real = join(cache, "real-gws")
    writeFileSync(real, pinnedBinary(), { mode: 0o755 })
    chmodSync(real, 0o755)
    rmSync(path)
    symlinkSync(real, path)
    await expect(resolvePackagedBinary(native(cache), platform, from)).rejects.toThrow(/^BINARY_TRUST_FAILED:/)
  })

  it("refuses a cached copy that no longer holds the pinned bytes", async () => {
    const { from } = release()
    const cache = temporary()
    const path = await resolvePackagedBinary(native(cache), platform, from)
    writeFileSync(path, "#!/bin/sh\necho 'gws 0.22.5'\n")
    const calls: string[] = []
    const again = await resolvePackagedBinary(native(cache, { fetchImpl: serving(gzip(), calls) }), platform, from)
    expect(calls).toHaveLength(1)
    expect(execFileSync(again, ["--version"], { encoding: "utf8" }).split("\n")[0]).toBe(GWS_VERSION)
  })

  it("fails with GWS_UNAVAILABLE on an unsupported platform, without looking anywhere else", async () => {
    const { from } = release()
    await expect(resolvePackagedBinary(native(temporary()), { os: "win32", cpu: "x64", glibc: false }, from)).rejects.toThrow(
      /^GWS_UNAVAILABLE: No gws binary is released for win32 x64; .*Next step: Set "binary\.path" to an absolute path to a gws 0\.22\.5 executable\.$/,
    )
  })

})

describe("explicit binary.path", () => {
  function config(binary: Record<string, string>) {
    return testConfig({ binary, accounts: { test: account({ services: ["drive"] }) }, audit: { enabled: false } })
  }
  const cache = () => ({ cacheRoot: temporary() })

  it("admits a path only under the location and ownership rules", async () => {
    const dir = temporary(root), binary = join(dir, "gws")
    writeFileSync(binary, "#!/bin/sh\necho 'gws 0.22.5'\n", { mode: 0o755 })
    expect(() => config({ path: "relative/gws" })).toThrow(/must be an absolute path/)
    expect(await resolveBinary(config({ path: binary }), undefined, cache())).toBe(realpathSync(binary))
    await expect(resolveBinary(config({ path: binary }), dir, cache())).rejects.toThrow(/inside the project/)
    await expect(resolveBinary(config({ path: dir }), undefined, cache())).rejects.toThrow(/Not a regular file/)
    await expect(resolveBinary(config({ path: join(dir, "missing") }), undefined, cache())).rejects.toThrow(/^GWS_UNAVAILABLE: The binary\.path option names a missing file: .*Next step: Set "binary\.path"/)
  })

  it.each([0o644, 0o775, 0o757])("refuses an override with mode %s", async (mode) => {
    const dir = temporary(root), binary = join(dir, "gws")
    writeFileSync(binary, "#!/bin/sh\necho 'gws 0.22.5'\n", { mode: 0o755 })
    chmodSync(binary, mode)
    await expect(resolveBinary(config({ path: binary }), undefined, cache())).rejects.toThrow(/must be executable and not group\/world writable/)
  })

  it("refuses an override inside a world-writable folder", async () => {
    const dir = temporary(root)
    const open = join(dir, "open")
    mkdirSync(open)
    chmodSync(open, 0o777)
    writeFileSync(join(open, "gws"), "#!/bin/sh\necho 'gws 0.22.5'\n", { mode: 0o755 })
    await expect(resolveBinary(config({ path: join(open, "gws") }), undefined, cache())).rejects.toThrow(/World-writable ancestor/)
  })

  it.each([
    ["gws 0.22.6", 0],
    ["gws 0.22.5", 1],
    ["", 0],
  ])("refuses a binary whose version probe prints %j with exit %s", async (version, exit) => {
    const dir = temporary(root), binary = join(dir, "gws")
    writeFileSync(binary, `#!/bin/sh\nprintf '%s\\n' '${version}'\nexit ${exit}\n`, { mode: 0o755 })
    const runtime = await testRuntime({ binary: { path: binary } })
    await expect(runtime.binaryFor({})).rejects.toThrow(/^GWS_VERSION_MISMATCH:/)
  })

  it("never consults PATH: a missing release is not replaced by a gws found there", async () => {
    const shadow = temporary(root)
    writeFileSync(join(shadow, "gws"), "#!/bin/sh\necho 'gws 0.22.5'\n", { mode: 0o755 })
    const from = join(temporary(), "plugin", "dist", "index.js")
    const saved = process.env.PATH
    process.env.PATH = `${shadow}:${saved ?? ""}`
    try {
      await expect(resolvePackagedBinary(native(temporary()), platform, from)).rejects.toThrow(/^GWS_UNAVAILABLE:/)
    } finally {
      process.env.PATH = saved
    }
  })
})
