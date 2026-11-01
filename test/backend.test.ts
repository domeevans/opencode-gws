import { execFileSync } from "node:child_process"
import { chmodSync, constants, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"
import { GWS_TARGETS, GWS_VERSION, gwsPackage, gwsTarget } from "../src/domain/backend.js"
import { loadManifest } from "../src/domain/manifest.js"
import { currentPlatform, resolveBinary, resolvePackagedBinary } from "../src/process/binary.js"
import { account, testConfig, testRuntime } from "./support/config.js"

const root = fileURLToPath(new URL("../", import.meta.url))
const provenance = JSON.parse(readFileSync(join(root, "native/provenance.json"), "utf8")) as {
  version: string
  targets: Record<string, { os: string; cpu: string; libc?: string; binary: { sha256: string } }>
}
const platform = currentPlatform()
const target = gwsTarget(platform)

const dirs: string[] = []
function temporary(base = tmpdir()) {
  const dir = realpathSync(mkdtempSync(join(base, ".backend-test-")))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** The host's fetched package: the unmodified binary every admission case starts from. */
function fetchedBinary(): string {
  if (!target) throw new Error(`no gws package for ${platform.os} ${platform.cpu}; these tests need a supported platform`)
  const binary = join(root, "node_modules", gwsPackage(target), "bin", "gws")
  if (!existsSync(binary)) throw new Error(`${gwsPackage(target)} is not installed: run npm run fetch:gws`)
  return binary
}

/** A fresh install tree holding a copy of this platform's package; returns the plugin module to resolve from and the binary. */
function installed(prepare?: (binary: string) => void): { from: string; binary: string } {
  const project = temporary()
  const pkg = join(project, "node_modules", gwsPackage(target!))
  mkdirSync(join(pkg, "bin"), { recursive: true })
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: gwsPackage(target!), version: "1.2.3" }))
  const binary = join(pkg, "bin", "gws")
  copyFileSync(fetchedBinary(), binary, constants.COPYFILE_FICLONE)
  chmodSync(binary, 0o755)
  prepare?.(binary)
  return { from: join(project, "node_modules", "@joe-broadhead", "opencode-gws", "dist", "index.js"), binary }
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

  it("maps macOS arm64 and x64 and Linux arm64 and x64 with glibc to their packages, and nothing else", () => {
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
    expect(gwsPackage("darwin-arm64")).toBe("@joe-broadhead/opencode-gws-bin-darwin-arm64")
  })
})

describe("packaged backend", () => {
  it("resolves this platform's installed package from the plugin's location and runs gws 0.22.5", () => {
    const binary = resolvePackagedBinary(platform, join(root, "dist", "index.js"))
    expect(binary).toBe(realpathSync(fetchedBinary()))
    const version = execFileSync(binary, ["--version"], { env: { PATH: "/usr/bin:/bin" }, encoding: "utf8" })
    expect(version.split("\n")[0]).toBe(GWS_VERSION)
  })

  it("fails with GWS_UNAVAILABLE and the override on an unsupported platform, without looking anywhere else", () => {
    expect(() => resolvePackagedBinary({ os: "win32", cpu: "x64", glibc: false }, join(root, "dist", "index.js"))).toThrow(
      /^GWS_UNAVAILABLE: No gws package supports win32 x64; .*Next step: Set "binary\.path" to an absolute path to a gws 0\.22\.5 executable\.$/,
    )
    expect(() => resolvePackagedBinary({ os: "linux", cpu: "x64", glibc: false }, join(root, "dist", "index.js"))).toThrow(
      /^GWS_UNAVAILABLE: No gws package supports linux x64 \(not glibc\)/,
    )
  })

  it("fails with GWS_UNAVAILABLE, naming the package and the next step, when the platform package is not installed", () => {
    const from = join(temporary(), "node_modules", "@joe-broadhead", "opencode-gws", "dist", "index.js")
    expect(() => resolvePackagedBinary(platform, from)).toThrow(
      `GWS_UNAVAILABLE: ${gwsPackage(target!)} is not installed. Next step: Reinstall the plugin so npm installs its optional dependency for this platform (in a checkout, run npm run fetch:gws), or set "binary.path" to an absolute path to a gws 0.22.5 executable.`,
    )
  })

  it.each([0o755, 0o750, 0o700, 0o555, 0o500])("admits installed mode %s without changing it", (mode) => {
    const { from, binary } = installed((path) => chmodSync(path, mode))
    expect(resolvePackagedBinary(platform, from)).toBe(binary)
    expect(statSync(binary).mode & 0o7777).toBe(mode)
  })

  it.each([0o775, 0o757, 0o4755, 0o2755, 0o1755, 0o600, 0o111, 0o055])("rejects unsafe or unusable installed mode %s", (mode) => {
    const { from } = installed((path) => chmodSync(path, mode))
    expect(() => resolvePackagedBinary(platform, from)).toThrow(/^BINARY_TRUST_FAILED:/)
  })

  it("rejects altered bytes, a linked binary, and a package without bin/gws", () => {
    const corrupt = installed((path) => writeFileSync(path, "#!/bin/sh\necho 'gws 0.22.5'\n"))
    expect(() => resolvePackagedBinary(platform, corrupt.from)).toThrow(/^BINARY_TRUST_FAILED: .* does not match the pinned .* release of gws 0\.22\.5$/)
    const linked = installed((path) => {
      rmSync(path)
      symlinkSync(fetchedBinary(), path)
    })
    expect(() => resolvePackagedBinary(platform, linked.from)).toThrow(/^BINARY_TRUST_FAILED:/)
    const missing = installed((path) => rmSync(path))
    expect(() => resolvePackagedBinary(platform, missing.from)).toThrow(/^GWS_UNAVAILABLE: .* has no bin\/gws\. Next step: Reinstall the plugin/)
  })

  it("hashes again only when the binary's size, mtime or inode change", () => {
    const stamp = new Date("2026-01-01T00:00:00Z")
    const { from, binary } = installed((path) => utimesSync(path, stamp, stamp))
    expect(resolvePackagedBinary(platform, from)).toBe(binary)
    // Same size, mtime and inode: the earlier admission stands without rereading the bytes.
    const bytes = readFileSync(binary)
    bytes[bytes.length - 1] ^= 0xff
    writeFileSync(binary, bytes)
    utimesSync(binary, stamp, stamp)
    expect(resolvePackagedBinary(platform, from)).toBe(binary)
    // A new mtime identifies new bytes, which fail the digest.
    utimesSync(binary, stamp, new Date("2026-01-02T00:00:00Z"))
    expect(() => resolvePackagedBinary(platform, from)).toThrow(/^BINARY_TRUST_FAILED:/)
  })
})

describe("explicit binary.path", () => {
  function config(binary: Record<string, string>) {
    return testConfig({ binary, accounts: { test: account({ services: ["drive"] }) }, audit: { enabled: false } })
  }

  it("admits a path only under the location and ownership rules", () => {
    const dir = temporary(root), binary = join(dir, "gws")
    writeFileSync(binary, "#!/bin/sh\necho 'gws 0.22.5'\n", { mode: 0o755 })
    expect(() => config({ path: "relative/gws" })).toThrow(/must be an absolute path/)
    expect(resolveBinary(config({ path: binary }))).toBe(realpathSync(binary))
    expect(() => resolveBinary(config({ path: binary }), dir)).toThrow(/inside the project/)
    expect(() => resolveBinary(config({ path: dir }))).toThrow(/Not a regular file/)
    expect(() => resolveBinary(config({ path: join(dir, "missing") }))).toThrow(/^GWS_UNAVAILABLE: The binary\.path option names a missing file: .*Next step: Set "binary\.path"/)
    for (const mode of [0o644, 0o775, 0o757]) {
      chmodSync(binary, mode)
      expect(() => resolveBinary(config({ path: binary })), mode.toString(8)).toThrow(/must be executable and not group\/world writable/)
    }
    const open = join(dir, "open")
    mkdirSync(open)
    chmodSync(open, 0o777)
    writeFileSync(join(open, "gws"), "#!/bin/sh\necho 'gws 0.22.5'\n", { mode: 0o755 })
    expect(() => resolveBinary(config({ path: join(open, "gws") }))).toThrow(/World-writable ancestor/)
  })

  it.each([
    ["gws 0.22.6", 0],
    ["gws 0.22.5", 1],
    ["", 0],
  ])("refuses a binary whose version probe prints %j with exit %s", async (version, exit) => {
    const dir = temporary(root), binary = join(dir, "gws")
    writeFileSync(binary, `#!/bin/sh\nprintf '%s\\n' '${version}'\nexit ${exit}\n`, { mode: 0o755 })
    await expect(testRuntime({ binary: { path: binary } })).rejects.toThrow(/^GWS_VERSION_MISMATCH:/)
  })

  it("never consults PATH: a missing package is not replaced by a gws found there", () => {
    const shadow = temporary(root)
    writeFileSync(join(shadow, "gws"), "#!/bin/sh\necho 'gws 0.22.5'\n", { mode: 0o755 })
    const from = join(temporary(), "plugin", "dist", "index.js")
    const saved = process.env.PATH
    process.env.PATH = `${shadow}:${saved ?? ""}`
    try {
      expect(() => resolvePackagedBinary(platform, from)).toThrow(/^GWS_UNAVAILABLE:/)
    } finally {
      process.env.PATH = saved
    }
  })
})
