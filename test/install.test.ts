// Unit tests for the shared native installer, against a fake network: each test serves exactly the bytes it names.
// A copy in a plugin repository changes only its runner import and the path of its copy of install.ts.
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { gzipSync } from "node:zlib"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { NativeError, type NativeManifest, cachePath, cachedNative, installNative, parseNativeManifest, readNativeManifest } from "../src/process/install.js"

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
const REPO = "joe-broadhead/opencode-example"
const TAG = "v0.0.0"
const EXE = Buffer.from("#!/bin/sh\necho example 1.2.3\n")
const GZ = gzipSync(EXE)
const KEY = "darwin-arm64"

function manifestFor(gz: Uint8Array = GZ, exe: Uint8Array = EXE, overrides: Partial<NativeManifest> = {}): NativeManifest {
  return {
    schema: 1,
    plugin: "opencode-example",
    repository: REPO,
    tag: TAG,
    built: { commit: "a".repeat(40), run: 42, workflow: "native" },
    modules: {
      example: {
        [KEY]: {
          name: "example-darwin-arm64.gz",
          url: `https://github.com/${REPO}/releases/download/${TAG}/example-darwin-arm64.gz`,
          bytes: gz.byteLength,
          sha256: sha(gz),
          executable: { name: "example", bytes: exe.byteLength, sha256: sha(exe) },
        },
      },
    },
    ...overrides,
  }
}

/** A fake network: `serve` answers every request for the asset's URL with the given behaviour. */
type Serve = { status?: number; body?: Uint8Array | "stall" | "reject"; chunk?: number }
function fakeFetch(serve: Serve, calls: string[] = []): typeof fetch {
  return (async (input: Request | URL | string, init?: RequestInit) => {
    calls.push(String(input))
    if (serve.body === "reject") throw new TypeError("fetch failed: getaddrinfo ENOTFOUND github.com")
    if (serve.body === "stall") {
      const signal = init?.signal
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          signal?.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")))
        },
      })
      return new Response(stream, { status: serve.status ?? 200 })
    }
    const bytes = serve.body ?? new Uint8Array()
    const step = serve.chunk ?? 1024
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let at = 0; at < bytes.byteLength; at += step) controller.enqueue(bytes.slice(at, at + step))
        controller.close()
      },
    })
    return new Response(stream, { status: serve.status ?? 200 })
  }) as typeof fetch
}

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "native-install-test-"))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const options = (manifest: NativeManifest, fetchImpl: typeof fetch, extra: Partial<Parameters<typeof installNative>[0]> = {}) => ({
  manifest,
  module: "example",
  key: KEY,
  cacheRoot: join(root, "cache"),
  installCommand: "/example-install",
  fetchImpl,
  ...extra,
})

async function refusal(promise: Promise<unknown>): Promise<NativeError> {
  try {
    await promise
  } catch (error) {
    if (error instanceof NativeError) return error
    throw error
  }
  throw new Error("expected a NativeError")
}

describe("the manifest", () => {
  test("accepts a release manifest and refuses one that names anything but its own release asset", () => {
    expect(parseNativeManifest(JSON.parse(JSON.stringify(manifestFor())))).toMatchObject({ tag: TAG, repository: REPO })
    const elsewhere = JSON.parse(JSON.stringify(manifestFor()))
    elsewhere.modules.example[KEY].url = "https://example.com/example-darwin-arm64.gz"
    expect(() => parseNativeManifest(elsewhere)).toThrow(/names a URL other than the release asset/)
    const otherTag = JSON.parse(JSON.stringify(manifestFor()))
    otherTag.modules.example[KEY].url = `https://github.com/${REPO}/releases/download/v9.9.9/example-darwin-arm64.gz`
    expect(() => parseNativeManifest(otherTag)).toThrow(/names a URL other than the release asset/)
  })

  test("refuses a bad schema, a bad hash, a path in a file name, and a non-integer size", () => {
    const base = JSON.parse(JSON.stringify(manifestFor()))
    expect(() => parseNativeManifest({ ...base, schema: 2 })).toThrow(/unknown schema/)
    const badHash = JSON.parse(JSON.stringify(base))
    badHash.modules.example[KEY].sha256 = "XYZ"
    expect(() => parseNativeManifest(badHash)).toThrow(/bad sha256/)
    const pathName = JSON.parse(JSON.stringify(base))
    pathName.modules.example[KEY].executable.name = "../example"
    expect(() => parseNativeManifest(pathName)).toThrow(/bad file name/)
    const fractional = JSON.parse(JSON.stringify(base))
    fractional.modules.example[KEY].bytes = 1.5
    expect(() => parseNativeManifest(fractional)).toThrow(/bad size/)
  })

  test("a package with no manifest is a development checkout, not an error; a manifest that is not JSON is refused", async () => {
    expect(await readNativeManifest(root)).toBeUndefined()
    mkdirSync(join(root, "manifest"))
    writeFileSync(join(root, "manifest", "native.json"), "{ not json")
    const refused = await refusal(readNativeManifest(root))
    expect(refused.code).toBe("NATIVE_MANIFEST_INVALID")
    writeFileSync(join(root, "manifest", "native.json"), JSON.stringify(manifestFor()))
    expect(await readNativeManifest(root)).toMatchObject({ tag: TAG })
  })

  test("an unsupported platform key is refused with its next step", async () => {
    const refused = await refusal(installNative(options(manifestFor(), fakeFetch({ body: GZ }), { key: "win32-x64" })))
    expect(refused.code).toBe("NATIVE_UNSUPPORTED_PLATFORM")
    expect(refused.next).toMatch(/binary path option/)
  })
})

describe("installing", () => {
  test("downloads, checks the asset and the executable, and installs the executable into the cache", async () => {
    const calls: string[] = []
    const result = await installNative(options(manifestFor(), fakeFetch({ body: GZ }, calls)))
    expect(result).toEqual({ path: cachePath(options(manifestFor(), fakeFetch({ body: GZ }))), downloaded: true })
    expect(readFileSync(result.path)).toEqual(EXE)
    expect(calls).toEqual([`https://github.com/${REPO}/releases/download/${TAG}/example-darwin-arm64.gz`])
    expect(readdirSync(join(root, "cache", "native", TAG, "example", KEY))).toEqual(["example"])
  })

  test("a verified cached executable is used without a second download", async () => {
    await installNative(options(manifestFor(), fakeFetch({ body: GZ })))
    const calls: string[] = []
    const again = await installNative(options(manifestFor(), fakeFetch({ body: GZ }, calls)))
    expect(again.downloaded).toBe(false)
    expect(calls).toEqual([])
    expect(await cachedNative(options(manifestFor(), fakeFetch({ body: GZ })))).toBe(again.path)
  })

  test("a cached executable that no longer matches its pin is downloaded again, not run", async () => {
    const first = await installNative(options(manifestFor(), fakeFetch({ body: GZ })))
    writeFileSync(first.path, "tampered")
    expect(await cachedNative(options(manifestFor(), fakeFetch({ body: GZ })))).toBeUndefined()
    const calls: string[] = []
    const second = await installNative(options(manifestFor(), fakeFetch({ body: GZ }, calls)))
    expect(second.downloaded).toBe(true)
    expect(calls).toHaveLength(1)
    expect(readFileSync(second.path)).toEqual(EXE)
  })

  test("an asset whose sha256 is not the pin is discarded: nothing reaches the final path", async () => {
    const tampered = Buffer.from(GZ)
    tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 0xff
    const refused = await refusal(installNative(options(manifestFor(), fakeFetch({ body: tampered }))))
    expect(refused.code).toBe("NATIVE_HASH_MISMATCH")
    expect(refused.message).toMatch(/does not match its pinned sha256/)
    expect(existsSync(cachePath(options(manifestFor(), fakeFetch({ body: GZ }))))).toBe(false)
    expect(readdirSync(join(root, "cache", "native", TAG, "example", KEY))).toEqual([])
  })

  test("an asset of the wrong size is refused as a size mismatch, however much is served", async () => {
    const short = await refusal(installNative(options(manifestFor(), fakeFetch({ body: GZ.subarray(0, 10) }))))
    expect(short.code).toBe("NATIVE_SIZE_MISMATCH")
    const long = await refusal(installNative(options(manifestFor(), fakeFetch({ body: Buffer.concat([GZ, GZ]) }))))
    expect(long.code).toBe("NATIVE_SIZE_MISMATCH")
    expect(long.next).toMatch(/report that the release does not match/)
  })

  test("an executable whose sha256 is not the pin is discarded after decompression", async () => {
    // The asset is the right gzip of OTHER, so it passes its own pin; OTHER is not the executable the manifest names.
    const OTHER = Buffer.from(EXE.toString().replace("example", "EXAMPLE"))
    const otherGz = gzipSync(OTHER)
    const bad = manifestFor(otherGz, EXE)
    const refused = await refusal(installNative(options(bad, fakeFetch({ body: otherGz }))))
    expect(refused.code).toBe("NATIVE_HASH_MISMATCH")
    expect(existsSync(cachePath(options(bad, fakeFetch({ body: GZ }))))).toBe(false)
    expect(readdirSync(join(root, "cache", "native", TAG, "example", KEY))).toEqual([])
  })

  test("an asset that does not decompress is refused, and what the pin names is never run", async () => {
    const junk = Buffer.from("not gzip at all, but the right length and hash")
    const manifest = manifestFor(junk, EXE)
    const refused = await refusal(installNative(options(manifest, fakeFetch({ body: junk }))))
    expect(refused.code).toBe("NATIVE_HASH_MISMATCH")
    expect(refused.message).toMatch(/does not decompress/)
  })

  test("a 404 is the release missing its file, not a network fault", async () => {
    const refused = await refusal(installNative(options(manifestFor(), fakeFetch({ status: 404 }))))
    expect(refused.code).toBe("NATIVE_NOT_FOUND")
    expect(refused.next).toMatch(/do not retry/)
  })

  test("a server error is a network refusal that names the status", async () => {
    const refused = await refusal(installNative(options(manifestFor(), fakeFetch({ status: 503 }))))
    expect(refused.code).toBe("NATIVE_NETWORK")
    expect(refused.message).toMatch(/HTTP 503/)
  })

  test("no network is a network refusal with the next step to check it", async () => {
    const refused = await refusal(installNative(options(manifestFor(), fakeFetch({ body: "reject" }))))
    expect(refused.code).toBe("NATIVE_NETWORK")
    expect(refused.next).toMatch(/Check the network or proxy/)
  })

  test("a download that stops sending is abandoned after the stall limit", async () => {
    const refused = await refusal(installNative(options(manifestFor(), fakeFetch({ body: "stall" }), { stallMs: 50 })))
    expect(refused.code).toBe("NATIVE_STALLED")
  })

  test("a cancelled caller stops the download and says so", async () => {
    const controller = new AbortController()
    controller.abort()
    const refused = await refusal(installNative(options(manifestFor(), fakeFetch({ body: "stall" }), { signal: controller.signal })))
    expect(refused.code).toBe("NATIVE_CANCELLED")
  })

  test("a cache folder that cannot be created is a write failure with its next step", async () => {
    writeFileSync(join(root, "cache"), "a file, not a folder")
    const refused = await refusal(installNative(options(manifestFor(), fakeFetch({ body: GZ }))))
    expect(refused.code).toBe("NATIVE_WRITE_FAILED")
    expect(refused.next).toMatch(/cache folder is writable/)
  })

  test("two installs at once both finish with the same verified executable", async () => {
    const [a, b] = await Promise.all([installNative(options(manifestFor(), fakeFetch({ body: GZ }))), installNative(options(manifestFor(), fakeFetch({ body: GZ })))])
    expect(a.path).toBe(b.path)
    expect(readFileSync(a.path)).toEqual(EXE)
    expect(readdirSync(join(root, "cache", "native", TAG, "example", KEY))).toEqual(["example"])
  })
})
