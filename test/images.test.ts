import { mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { loadConfig } from "../src/domain/config.js"
import { GwsError } from "../src/domain/errors.js"
import {
  IMAGE_HOSTS,
  IMAGE_MAX_BYTES,
  ImageSources,
  SOURCE_MAX,
  SOURCE_TTL_MS,
  driveFileId,
  imageAccount,
  imageAnswer,
  imageUrl,
  sniffImage,
  tokenHost,
} from "../src/domain/images.js"
import { IMAGE_CONCURRENCY, IMAGE_DEADLINE_MS, IMAGE_INPUT, IMAGE_OUTPUT, imagesRead } from "../src/host/images.js"
import { JellyRpc, registerJellyRpc } from "../src/host/jelly-rpc.js"
import { fetchImage } from "../src/process/image-fetch.js"
import { Stage } from "../src/process/staging.js"
import type { Runtime } from "../src/runtime/index.js"
import { account, accountDir, testRuntime } from "./support/config.js"

/**
 * images.read, the read Jelly makes to draw a Google picture in an agent's UI (hey-jelly
 * backend/host/src/agent-ui/image-route.ts, protocol/contracts/src/agent-ui/routes.ts AgentUiImageReadSchema): the
 * address gate, where the token may go, the size cap while streaming, the type from the bytes, which account reads,
 * and the declaration. Every network answer here is a fake `fetch`; nothing reaches the network.
 */

const root = new URL("../", import.meta.url)
const pkg = JSON.parse(readFileSync(new URL("package.json", root), "utf8"))
const TOKEN = "ya29.fake-test-token"

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 16])
const ascii = (text: string) => Uint8Array.from([...text].map((char) => char.charCodeAt(0)))
const GIF87 = ascii("GIF87a\u0001\u0000")
const GIF89 = ascii("GIF89a\u0001\u0000")
const WEBP = ascii("RIFF\u0000\u0000\u0000\u0000WEBPVP8 ")
const SVG = ascii('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')
/** A PNG of `size` bytes. */
const png = (size: number) => {
  const bytes = new Uint8Array(size)
  bytes.set(PNG)
  return bytes
}

const THUMB = "https://lh3.googleusercontent.com/drive-storage/AJQWtBfake=s220"

describe("the address images.read takes", () => {
  it("is https on drive.google.com or a name under googleusercontent.com", () => {
    for (const ok of [
      THUMB,
      "https://lh7-rt.googleusercontent.com/docsz/AD_fake",
      "https://drive.google.com/file/d/1AbCdEfGhIjKlMnOp/view",
      "https://DRIVE.GOOGLE.COM/open?id=1AbCdEfGhIjKlMnOp",
      "https://lh4.googleusercontent.com/a/photo=s96",
      "https://drive.google.com:443/file/d/1AbCdEfGhIjKlMnOp/view",
    ])
      expect(() => imageUrl(ok), ok).not.toThrow()
  })

  it("refuses every other scheme, host, user name, port, IP address and look-alike", () => {
    for (const bad of [
      "http://lh3.googleusercontent.com/a",
      "data:image/png;base64,iVBORw0KGgo=",
      "javascript:alert(1)",
      "file:///etc/passwd",
      "ftp://drive.google.com/x",
      "https://user@drive.google.com/file/d/1AbCdEfGhIjKlMnOp/view",
      "https://user:pass@lh3.googleusercontent.com/a",
      "https://lh3.googleusercontent.com:8443/a",
      "https://googleusercontent.com/a",
      "https://x.bc.googleusercontent.com/a.png",
      "https://1.2.3.4.bc.googleusercontent.com/a.png",
      "https://script.googleusercontent.com/macros/echo?user_content_key=x",
      "https://docs.googleusercontent.com/a",
      "https://ci3.googleusercontent.com/proxy/a",
      "https://lh8.googleusercontent.com/a",
      "https://lh3x.googleusercontent.com/a",
      "https://a.lh3.googleusercontent.com/a",
      "https://xgoogleusercontent.com/a",
      "https://googleusercontent.com.evil.com/a",
      "https://lh3.googleusercontent.com.evil.com/a",
      "https://drive.google.com.evil.com/a",
      "https://evil.com/drive.google.com",
      "https://evil.com\\@drive.google.com/a",
      "https://evil.com#@drive.google.com",
      "https://docs.google.com/a",
      "https://google.com/a",
      "https://drive.google.com./file/d/1AbCdEfGhIjKlMnOp/view",
      "https://127.0.0.1/a",
      "https://2130706433/a",
      "https://[::1]/a",
      "https://0x7f.0.0.1/a",
      `https://lh3.googleusercontent.com/${"a".repeat(2048)}`,
      "",
      "not a url",
    ])
      expect(() => imageUrl(bad), bad).toThrow(/^IMAGE_HOST_REFUSED: /)
    expect(() => imageUrl(42)).toThrow(/^IMAGE_HOST_REFUSED: /)
    for (const ip of ["https://127.0.0.1/a", "https://2130706433/a", "https://0x7f.0.0.1/a", "https://[::1]/a", "https://[2001:db8::1]/a"])
      expect(() => imageUrl(ip), ip).toThrow(/^IMAGE_HOST_REFUSED: The picture's address is an IP address\./)
  })

  it("matches Jelly's own check for every address it takes, and the hosts it declares", () => {
    // hey-jelly protocol/contracts/src/agent-ui/parts.ts agentUiImageAllowed, ported: https, no credentials, exact or suffix.
    const jellyAllows = (src: string, hosts: readonly string[]) => {
      const url = new URL(src)
      if (url.protocol !== "https:" || url.username !== "" || url.password !== "") return false
      const host = url.hostname.toLowerCase()
      return hosts.some((name) => (name.startsWith(".") ? host.endsWith(name) || host === name.slice(1) : host === name))
    }
    for (const src of [THUMB, "https://drive.google.com/file/d/1AbCdEfGhIjKlMnOp/view", "https://lh7-us.googleusercontent.com/x"]) {
      expect(imageUrl(src)).toBeDefined()
      expect(jellyAllows(src, IMAGE_HOSTS)).toBe(true)
    }
    expect(pkg.jelly.imageHosts).toEqual([...IMAGE_HOSTS])
    // Exactly what the method takes: each declared host is exact (no suffix), and each is taken.
    for (const host of pkg.jelly.imageHosts as string[]) {
      expect(host.startsWith("."), host).toBe(false)
      expect(imageUrl(`https://${host}/x`).hostname).toBe(host)
    }
    expect(pkg.jelly.imageHosts).toEqual([
      "drive.google.com",
      "lh3.googleusercontent.com",
      "lh4.googleusercontent.com",
      "lh5.googleusercontent.com",
      "lh6.googleusercontent.com",
      "lh7.googleusercontent.com",
      "lh7-rt.googleusercontent.com",
      "lh7-us.googleusercontent.com",
    ])
  })

  it("names a Drive file by its id in each link shape Drive returns, and nothing else", () => {
    const id = "1AbCdEfGhIjKlMnOp_-9"
    for (const link of [`/file/d/${id}/view?usp=drivesdk`, `/file/d/${id}`, `/file/d/${id}/preview`, `/open?id=${id}`, `/uc?id=${id}&export=download`, `/thumbnail?id=${id}&sz=w400`])
      expect(driveFileId(imageUrl(`https://drive.google.com${link}`)), link).toBe(id)
    for (const link of ["/drive/folders/1AbCdEfGhIjKlMnOp", "/open?id=short", "/file/d/../../x/view", "/uc", `/open?id=${id}%2F..`, "/file/d/1AbCdEfGhIjKlMnOp/view/more"])
      expect(() => driveFileId(imageUrl(`https://drive.google.com${link}`)), link).toThrow(/^IMAGE_HOST_REFUSED: /)
  })

  it("sends the account's token only to Google's image servers", () => {
    for (const host of ["lh3.googleusercontent.com", "lh7-rt.googleusercontent.com", "lh7-us.googleusercontent.com", "lh5.googleusercontent.com"]) expect(tokenHost(host), host).toBe(true)
    for (const host of [
      "1.2.3.4.bc.googleusercontent.com",
      "script.googleusercontent.com",
      "ci3.googleusercontent.com",
      "drive.google.com",
      "lh8.googleusercontent.com",
      "lh3.googleusercontent.com.evil.com",
      "xlh3.googleusercontent.com",
      "a.lh3.googleusercontent.com",
    ])
      expect(tokenHost(host), host).toBe(false)
  })
})

describe("what the bytes are", () => {
  it("is PNG, JPEG, GIF or WebP from the first bytes", () => {
    expect(sniffImage(PNG)).toBe("image/png")
    expect(sniffImage(JPEG)).toBe("image/jpeg")
    expect(sniffImage(GIF87)).toBe("image/gif")
    expect(sniffImage(GIF89)).toBe("image/gif")
    expect(sniffImage(WEBP)).toBe("image/webp")
  })

  it("refuses SVG, HTML, other RIFF, other kinds and nothing", () => {
    for (const bytes of [SVG, ascii("<svg/>"), ascii("<!doctype html><img>"), ascii("RIFF\u0000\u0000\u0000\u0000WAVEfmt "), ascii("GIF88a"), ascii("BM6"), new Uint8Array(), PNG.slice(0, 7)])
      expect(sniffImage(bytes)).toBeUndefined()
    expect(() => imageAnswer(SVG)).toThrow(/^IMAGE_TYPE_REFUSED: /)
  })

  it("answers Jelly's shape, and refuses a picture over 1 MB", () => {
    expect(imageAnswer(PNG)).toEqual({ mime: "image/png", base64: Buffer.from(PNG).toString("base64") })
    expect(imageAnswer(png(IMAGE_MAX_BYTES)).mime).toBe("image/png")
    expect(() => imageAnswer(png(IMAGE_MAX_BYTES + 1))).toThrow(/^IMAGE_TOO_LARGE: /)
  })
})

describe("the account that reads a picture", () => {
  const config = (accounts: Record<string, unknown>) => loadConfig({ accounts })
  it("is the account Google returned the address to", () => {
    expect(imageAccount(config({ work: account({ services: ["drive"] }), home: account({ services: ["drive"] }) }), ["home"])).toBe("home")
  })
  it("is otherwise the only account that enables drive, or the default account", () => {
    expect(imageAccount(loadConfig({}), [])).toBe("default")
    expect(imageAccount(config({ mail: account({ services: ["gmail"] }), work: account({ services: ["drive"] }) }), [])).toBe("work")
    expect(imageAccount(config({ default: account({ services: ["drive"] }), work: account({ services: ["drive"] }) }), [])).toBe("default")
    expect(imageAccount(config({ default: account({ services: ["drive"] }), work: account({ services: ["drive"] }) }), ["work", "default"])).toBe("default")
  })
  it("is refused when several could and none is the default account, or none enables drive", () => {
    expect(() => imageAccount(config({ work: account({ services: ["drive"] }), home: account({ services: ["drive"] }) }), [])).toThrow(/^IMAGE_ACCOUNT_AMBIGUOUS: /)
    expect(() => imageAccount(config({ work: account({ services: ["drive"] }), home: account({ services: ["drive"] }) }), ["work", "home"])).toThrow(/^IMAGE_ACCOUNT_AMBIGUOUS: /)
    expect(() => imageAccount(config({ mail: account({ services: ["gmail"] }) }), [])).toThrow(/^IMAGE_ACCOUNT_AMBIGUOUS: No configured account enables drive/)
  })
})

describe("the addresses Google returned", () => {
  it("are found anywhere in a read's answer, for that account, and only on the image hosts", () => {
    const sources = new ImageSources()
    sources.record("work", { files: [{ id: "f", thumbnailLink: THUMB, webViewLink: "https://drive.google.com/file/d/1AbCdEfGhIjKlMnOp/view", iconLink: "https://evil.com/a.png" }] })
    expect(sources.accounts(new URL(THUMB))).toEqual(["work"])
    expect(sources.accounts(new URL("https://drive.google.com/file/d/1AbCdEfGhIjKlMnOp/view"))).toEqual(["work"])
    expect(sources.accounts(new URL("https://evil.com/a.png"))).toEqual([])
    sources.record("home", { thumbnailLink: THUMB })
    expect(sources.accounts(new URL(THUMB)).sort()).toEqual(["home", "work"])
  })

  it("are only the fields Google produces, never text someone wrote", () => {
    const sources = new ImageSources()
    const link = (name: string) => `https://lh3.googleusercontent.com/${name}`
    sources.record("work", {
      description: link("description"),
      values: [[link("cell")]],
      body: { content: [{ paragraph: { elements: [{ textRun: { content: link("text") } }] } }] },
      pageElements: [{ image: { sourceUrl: link("source"), contentUrl: link("slides") } }],
      inlineObjects: { k: { inlineObjectProperties: { embeddedObject: { imageProperties: { contentUri: link("docs") } } } } },
      owners: [{ photoLink: link("owner") }],
      photos: [{ url: link("person") }],
      links: [{ url: link("link") }],
      thumbnailPhotoUrl: link("directory"),
    })
    const seen = (name: string) => sources.accounts(new URL(link(name)))
    for (const name of ["slides", "docs", "owner", "person", "directory"]) expect(seen(name), name).toEqual(["work"])
    for (const name of ["description", "cell", "text", "source", "link"]) expect(seen(name), name).toEqual([])
  })

  it("are forgotten after an hour, and at most SOURCE_MAX are kept, the least recently seen dropped", () => {
    let now = 0
    const sources = new ImageSources(() => now)
    sources.record("work", { thumbnailLink: THUMB })
    now = SOURCE_TTL_MS + 1
    expect(sources.accounts(new URL(THUMB))).toEqual([])
    const link = (index: number) => `https://lh3.googleusercontent.com/p/${index}`
    sources.record("work", { files: Array.from({ length: SOURCE_MAX + 5 }, (_, index) => ({ thumbnailLink: link(index) })) })
    expect(sources.size).toBe(SOURCE_MAX)
    expect(sources.accounts(new URL(link(0)))).toEqual([])
    expect(sources.accounts(new URL(link(SOURCE_MAX + 4)))).toEqual(["work"])
  })
})

/** A fake fetch: each call recorded with its headers, answered by `answer`. */
function fakeFetch(answer: (url: string) => Response) {
  const calls: { url: string; headers: Record<string, string>; init: RequestInit }[] = []
  const impl = (async (input: string, init: RequestInit = {}) => {
    calls.push({ url: String(input), headers: { ...(init.headers as Record<string, string>) }, init })
    return answer(String(input))
  }) as unknown as typeof fetch
  return { impl, calls }
}

/** A streamed body of `total` bytes in 64 KB chunks, counting how many chunks the reader pulled. */
function streamed(total: number, head = PNG) {
  const state = { pulled: 0, cancelled: false }
  let sent = 0
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= total) return controller.close()
      const size = Math.min(65_536, total - sent)
      const chunk = new Uint8Array(size)
      if (sent === 0) chunk.set(head.subarray(0, Math.min(head.length, size)))
      sent += size
      state.pulled++
      controller.enqueue(chunk)
    },
    cancel() {
      state.cancelled = true
    },
  })
  return { body, state }
}

describe("fetching a picture", () => {
  it("sends the token only to a token host, and refuses it for any other", async () => {
    const { impl, calls } = fakeFetch(() => new Response(PNG, { status: 200 }))
    await fetchImage(THUMB, { token: TOKEN, fetchImpl: impl })
    expect(calls[0]?.headers["authorization"]).toBe(`Bearer ${TOKEN}`)
    await fetchImage("https://lh4.googleusercontent.com/a/photo", { fetchImpl: impl })
    expect(calls[1]?.headers["authorization"]).toBeUndefined()
    await expect(fetchImage("https://1.2.3.4.bc.googleusercontent.com/x", { token: TOKEN, fetchImpl: impl })).rejects.toThrow(/^IMAGE_HOST_REFUSED: /)
    await expect(fetchImage("https://1.2.3.4.bc.googleusercontent.com/x", { fetchImpl: impl })).rejects.toThrow(/^IMAGE_HOST_REFUSED: /)
    // A Drive link is read through gws, never fetched.
    await expect(fetchImage("https://drive.google.com/uc?id=1AbCdEfGhIjKlMnOp", { fetchImpl: impl })).rejects.toThrow(/^IMAGE_HOST_REFUSED: /)
    await expect(fetchImage("https://evil.com/x", { fetchImpl: impl })).rejects.toThrow(/^IMAGE_HOST_REFUSED: /)
    expect(calls).toHaveLength(2)
    expect(calls[0]?.init).toMatchObject({ method: "GET", redirect: "manual", credentials: "omit", referrerPolicy: "no-referrer" })
  })

  it("never follows a redirect, so the token never reaches the address it names", async () => {
    for (const status of [301, 302, 303, 307, 308]) {
      const { impl, calls } = fakeFetch(() => new Response(null, { status, headers: { location: "https://evil.com/steal" } }))
      await expect(fetchImage(THUMB, { token: TOKEN, fetchImpl: impl })).rejects.toThrow(/^IMAGE_UNAVAILABLE: .*redirect/)
      expect(calls.map((call) => call.url)).toEqual([THUMB])
    }
  })

  it("refuses a declared length over the cap before reading the body", async () => {
    const { body, state } = streamed(IMAGE_MAX_BYTES + 1)
    const { impl } = fakeFetch(() => new Response(body, { status: 200, headers: { "content-length": String(IMAGE_MAX_BYTES + 1) } }))
    await expect(fetchImage(THUMB, { fetchImpl: impl })).rejects.toThrow(/^IMAGE_TOO_LARGE: /)
    expect(state.pulled).toBeLessThanOrEqual(1)
    expect(state.cancelled).toBe(true)
  })

  it("stops a body with no length once it passes the cap, and refuses it rather than cutting it short", async () => {
    const { body, state } = streamed(10 * IMAGE_MAX_BYTES)
    const { impl } = fakeFetch(() => new Response(body, { status: 200 }))
    await expect(fetchImage(THUMB, { fetchImpl: impl })).rejects.toThrow(/^IMAGE_TOO_LARGE: /)
    // 16 chunks fill 1 MB; the 17th passes it. Reading stopped there, not at 10 MB.
    expect(state.pulled).toBeLessThanOrEqual(18)
    expect(state.cancelled).toBe(true)
  })

  it("reads a body of exactly the cap whole", async () => {
    const { body } = streamed(IMAGE_MAX_BYTES)
    const { impl } = fakeFetch(() => new Response(body, { status: 200 }))
    expect((await fetchImage(THUMB, { fetchImpl: impl })).byteLength).toBe(IMAGE_MAX_BYTES)
  })

  it("is unavailable on any answer but 200, or when the host cannot be reached", async () => {
    for (const status of [204, 401, 403, 404, 500]) {
      const { impl } = fakeFetch(() => new Response(status === 204 ? null : "no", { status }))
      await expect(fetchImage(THUMB, { fetchImpl: impl }), String(status)).rejects.toThrow(/^IMAGE_UNAVAILABLE: /)
    }
    const failing = (async () => {
      throw new TypeError(`fetch failed for ${THUMB}`)
    }) as unknown as typeof fetch
    const error = await fetchImage(THUMB, { fetchImpl: failing }).catch((caught: Error) => caught)
    expect(String(error)).toMatch(/IMAGE_UNAVAILABLE: /)
    expect(String(error)).not.toContain("drive-storage")
  })

  it("stops when the call is cancelled", async () => {
    const controller = new AbortController()
    controller.abort()
    const { impl, calls } = fakeFetch(() => new Response(PNG))
    await expect(fetchImage(THUMB, { signal: controller.signal, fetchImpl: impl })).rejects.toThrow(/^CANCELLED: /)
    expect(calls).toHaveLength(0)
  })
})

/** A reader with fake Drive answers, a fake token per account, and the audit it emits. */
function fakeRuntime(accounts: Record<string, unknown> = { work: account({ services: ["drive"] }) }) {
  const meta: Record<string, unknown> = {}
  const files: Record<string, Uint8Array | Error> = {}
  const reads: { account?: string; operation: string; params?: Record<string, unknown> }[] = []
  const downloads: { account: string; fileId: string }[] = []
  const tokens: Record<string, string | undefined | Error> = {}
  const audited: Record<string, unknown>[] = []
  const imageSources = new ImageSources()
  const runtime = {
    config: loadConfig({ accounts }),
    imageSources,
    audit: { emit: (event: Record<string, unknown>) => audited.push(event) },
    wait: <T>(start: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal) => start(signal ?? new AbortController().signal),
    read: async (request: { account?: string; operation: string; params?: Record<string, unknown> }) => {
      reads.push(request)
      const data = meta[String(request.params?.["fileId"])]
      if (data instanceof Error) throw data
      imageSources.record(request.account!, data)
      return { ok: true, operation: request.operation, category: "read", data, truncated: false }
    },
    readDriveFile: async (input: { account: string; fileId: string }, max: number) => {
      downloads.push(input)
      const bytes = files[input.fileId]
      if (bytes instanceof Error) throw bytes
      return bytes && bytes.byteLength <= max ? Buffer.from(bytes) : undefined
    },
    imageToken: async (alias: string) => {
      const token = alias in tokens ? tokens[alias] : TOKEN
      if (token instanceof Error) throw token
      return token
    },
  }
  return { runtime: runtime as unknown as Runtime, meta, files, reads, downloads, tokens, audited, imageSources }
}

const FILE = "1AbCdEfGhIjKlMnOp"
const LINK = `https://drive.google.com/file/d/${FILE}/view?usp=drivesdk`

describe("images.read", () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it("reads a Drive picture's bytes through gws as the account, and answers its type from the bytes", async () => {
    const fake = fakeRuntime()
    fake.meta[FILE] = { mimeType: "image/png", size: "12" }
    fake.files[FILE] = PNG
    const { impl, calls } = fakeFetch(() => new Response(PNG))
    expect(await imagesRead(fake.runtime, { fetchImpl: impl })(LINK)).toEqual({ mime: "image/png", base64: Buffer.from(PNG).toString("base64") })
    expect(fake.reads).toEqual([{ account: "work", operation: "drive.files.get", params: { fileId: FILE, "supportsAllDrives": true, fields: "mimeType,size,thumbnailLink" } }])
    expect(fake.downloads).toEqual([{ account: "work", fileId: FILE }])
    expect(calls).toHaveLength(0)
    expect(fake.audited).toEqual([{ event: "images.read", outcome: "success", account: "work", category: "read", durationMs: expect.any(Number), caller: "rpc" }])
  })

  it("answers the thumbnail, with the token, for a file that is not a picture or is over 1 MB", async () => {
    for (const data of [
      { mimeType: "application/pdf", size: "5000", thumbnailLink: THUMB },
      { mimeType: "image/png", size: String(IMAGE_MAX_BYTES + 1), thumbnailLink: THUMB },
      { mimeType: "image/svg+xml", size: "100", thumbnailLink: THUMB },
      { mimeType: "image/png", thumbnailLink: THUMB },
    ]) {
      const fake = fakeRuntime()
      fake.meta[FILE] = data
      const { impl, calls } = fakeFetch(() => new Response(JPEG))
      expect((await imagesRead(fake.runtime, { fetchImpl: impl })(LINK)).mime).toBe("image/jpeg")
      expect(fake.downloads).toEqual([])
      expect(calls.map((call) => [call.url, call.headers["authorization"]])).toEqual([[THUMB, `Bearer ${TOKEN}`]])
    }
  })

  it("never fetches a thumbnail address off Google's image servers", async () => {
    const fake = fakeRuntime()
    const { impl, calls } = fakeFetch(() => new Response(PNG))
    for (const thumbnailLink of ["https://x.bc.googleusercontent.com/t.png", "https://drive.google.com/thumbnail?id=1AbCdEfGhIjKlMnOp"]) {
      fake.meta[FILE] = { mimeType: "application/pdf", thumbnailLink }
      await expect(imagesRead(fake.runtime, { fetchImpl: impl })(LINK)).rejects.toThrow(/^IMAGE_HOST_REFUSED: /)
    }
    expect(calls).toEqual([])
  })

  it("refuses any other googleusercontent.com name before fetching anything, with or without credentials", async () => {
    const fake = fakeRuntime()
    const { impl, calls } = fakeFetch(() => new Response(PNG))
    for (const address of ["https://x.bc.googleusercontent.com/a.png", "https://script.googleusercontent.com/macros/echo?x=1", "https://docs.googleusercontent.com/a"]) {
      fake.imageSources.record("work", { thumbnailLink: address })
      await expect(imagesRead(fake.runtime, { fetchImpl: impl })(address), address).rejects.toThrow(/^IMAGE_HOST_REFUSED: /)
    }
    expect(calls).toEqual([])
  })

  it("is unavailable for a file with no picture and no thumbnail, and too large for a big one with none", async () => {
    const fake = fakeRuntime()
    fake.meta[FILE] = { mimeType: "application/vnd.google-apps.folder" }
    await expect(imagesRead(fake.runtime)(LINK)).rejects.toThrow(/^IMAGE_UNAVAILABLE: /)
    fake.meta[FILE] = { mimeType: "image/png", size: String(IMAGE_MAX_BYTES + 1) }
    await expect(imagesRead(fake.runtime)(LINK)).rejects.toThrow(/^IMAGE_TOO_LARGE: /)
    expect(fake.downloads).toEqual([])
  })

  it("refuses a download that turns out over the cap, and one that is not a picture", async () => {
    const fake = fakeRuntime()
    fake.meta[FILE] = { mimeType: "image/png", size: "12" }
    fake.files[FILE] = png(IMAGE_MAX_BYTES + 1)
    await expect(imagesRead(fake.runtime)(LINK)).rejects.toThrow(/^IMAGE_TOO_LARGE: /)
    fake.files[FILE] = SVG
    await expect(imagesRead(fake.runtime)(LINK)).rejects.toThrow(/^IMAGE_TYPE_REFUSED: /)
  })

  it("fetches an address Google returned to the account with its token, and any other without", async () => {
    const fake = fakeRuntime()
    const { impl, calls } = fakeFetch(() => new Response(GIF89))
    const read = imagesRead(fake.runtime, { fetchImpl: impl })
    expect((await read(THUMB)).mime).toBe("image/gif")
    fake.imageSources.record("work", { thumbnailLink: THUMB })
    expect((await read(THUMB)).mime).toBe("image/gif")
    await read("https://lh4.googleusercontent.com/a/photo")
    expect(calls.map((call) => call.headers["authorization"])).toEqual([undefined, `Bearer ${TOKEN}`, undefined])
  })

  it("is AUTH_REQUIRED when the account that must read the picture is signed out", async () => {
    const fake = fakeRuntime()
    fake.meta[FILE] = new GwsError("AUTH_REQUIRED", "'work' is not signed in to Google Workspace")
    await expect(imagesRead(fake.runtime)(LINK)).rejects.toThrow(/^AUTH_REQUIRED: /)
    fake.tokens["work"] = new Error("AUTH_REQUIRED: 'work' is not signed in to Google Workspace. Next step: Sign in.")
    fake.imageSources.record("work", { thumbnailLink: THUMB })
    const { impl, calls } = fakeFetch(() => new Response(PNG))
    await expect(imagesRead(fake.runtime, { fetchImpl: impl })(THUMB)).rejects.toThrow(/^AUTH_REQUIRED: /)
    expect(calls).toHaveLength(0)
  })

  it("refuses when no single account can read a Drive link", async () => {
    const fake = fakeRuntime({ work: account({ services: ["drive"] }), home: account({ services: ["drive"] }) })
    await expect(imagesRead(fake.runtime)(LINK)).rejects.toThrow(/^IMAGE_ACCOUNT_AMBIGUOUS: /)
    expect(fake.reads).toEqual([])
  })

  it("never names the address, the file or the token in an error or the audit", async () => {
    const fake = fakeRuntime()
    const secret = "SECRETPATHabc123"
    const thumb = `https://lh3.googleusercontent.com/${secret}`
    fake.imageSources.record("work", { thumbnailLink: thumb })
    fake.meta[FILE] = { mimeType: "application/pdf", thumbnailLink: thumb }
    const failures: string[] = []
    for (const answer of [
      () => new Response(null, { status: 302, headers: { location: `https://evil.com/${secret}` } }),
      () => new Response("x", { status: 403 }),
      () => new Response(SVG),
    ]) {
      const { impl } = fakeFetch(answer)
      for (const address of [thumb, LINK, `https://evil.com/${secret}`])
        failures.push(String(await imagesRead(fake.runtime, { fetchImpl: impl })(address).catch((error: Error) => error.message)))
    }
    const text = JSON.stringify([failures, fake.audited])
    for (const leak of [secret, FILE, TOKEN, "evil.com"]) expect(text).not.toContain(leak)
  })

  it("answers a picture of 47 KB within Jelly's 64 KB RPC limit", async () => {
    const fake = fakeRuntime()
    fake.meta[FILE] = { mimeType: "image/png", size: String(47 * 1024) }
    fake.files[FILE] = png(47 * 1024)
    const answer = await imagesRead(fake.runtime)(LINK)
    // hey-jelly backend/host/src/plugin-views/rpc.ts: an answer over VIEW_DATA_MAX_BYTES of JSON is refused.
    expect(new TextEncoder().encode(JSON.stringify(answer)).byteLength).toBeLessThanOrEqual(65_536)
  })

  it("reads at most IMAGE_CONCURRENCY pictures at once", async () => {
    const fake = fakeRuntime()
    const held: (() => void)[] = []
    let hold = true
    const impl = (async () => {
      if (hold) await new Promise<void>((resolve) => held.push(resolve))
      return new Response(PNG)
    }) as unknown as typeof fetch
    const read = imagesRead(fake.runtime, { fetchImpl: impl })
    const pending = Array.from({ length: IMAGE_CONCURRENCY }, () => read(THUMB))
    await vi.waitFor(() => expect(held).toHaveLength(IMAGE_CONCURRENCY))
    await expect(read(THUMB)).rejects.toThrow(/^IMAGE_UNAVAILABLE: /)
    hold = false
    for (const release of held) release()
    await Promise.all(pending)
    expect((await read(THUMB)).mime).toBe("image/png")
  })

  it("counts a read abandoned at its deadline against the limit until its work settles", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    const fake = fakeRuntime()
    const held: (() => void)[] = []
    let hold = true
    // A fetch that ignores its signal: the work goes on after the deadline answers.
    const impl = (async () => {
      if (hold) await new Promise<void>((resolve) => held.push(resolve))
      return new Response(PNG)
    }) as unknown as typeof fetch
    const read = imagesRead(fake.runtime, { fetchImpl: impl })
    const pending = Array.from({ length: IMAGE_CONCURRENCY }, () => read(THUMB).catch((error: Error) => error.message))
    await vi.advanceTimersByTimeAsync(IMAGE_DEADLINE_MS)
    for (const answer of await Promise.all(pending)) expect(answer).toMatch(/^TIMEOUT: /)
    await expect(read(THUMB)).rejects.toThrow(/^IMAGE_UNAVAILABLE: 4 pictures are already being read/)
    hold = false
    for (const release of held) release()
    await vi.waitFor(async () => expect((await read(THUMB)).mime).toBe("image/png"))
  })

  it("gives up after its deadline, inside Jelly's ten seconds", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    const fake = fakeRuntime()
    let aborted: unknown
    const impl = ((_url: string, init: RequestInit) =>
      new Promise((_, reject) => {
        init.signal?.addEventListener("abort", () => {
          aborted = init.signal?.reason
          reject(init.signal?.reason)
        })
      })) as unknown as typeof fetch
    const answer = imagesRead(fake.runtime, { fetchImpl: impl })(THUMB).catch((error: Error) => error)
    await vi.advanceTimersByTimeAsync(IMAGE_DEADLINE_MS)
    expect(String(await answer)).toMatch(/TIMEOUT: The picture was not read within 8 seconds/)
    expect(aborted).toBeDefined()
  })
})

describe("images.read on the package's RPC", () => {
  it("shares one registration with calendar.today, and answers a failure as the declared error", async () => {
    const fake = fakeRuntime()
    const registered: { contract: unknown; handlers: Record<string, (input: unknown, context: unknown) => Promise<unknown>> }[] = []
    const ctx = {
      rpc: {
        register: async (contract: unknown, handlers: Record<string, (input: unknown, context: unknown) => Promise<unknown>>) => {
          registered.push({ contract, handlers })
          return { dispose: async () => {} }
        },
      },
    }
    await registerJellyRpc(ctx as never, fake.runtime)
    expect(registered).toHaveLength(1)
    expect(registered[0]?.contract).toBe(JellyRpc)
    expect(Object.keys(registered[0]!.handlers).sort()).toEqual(["calendar.today", "images.read"])
    const context = { signal: new AbortController().signal, error: (type: string, message: string, data: unknown) => ({ type, message, data }) }
    expect(await registered[0]!.handlers["images.read"]!({ url: "https://evil.com/a.png" }, context)).toEqual({
      type: "failed",
      message: expect.stringMatching(/^IMAGE_HOST_REFUSED: /),
      data: { code: "IMAGE_HOST_REFUSED", next: expect.any(String) },
    })
  })
})

describe("images.read through the plugin's own read path, with a fake gws", () => {
  const runtimes: Runtime[] = []
  /** The bytes the fake gws writes for a download, in a file beside the runtime's own. */
  const body = (runtime: Runtime, bytes: Uint8Array) => {
    const path = join(runtime.paths.stateDir, "fake-body")
    mkdirSync(runtime.paths.stateDir, { recursive: true })
    writeFileSync(path, bytes)
    return path
  }
  afterEach(async () => {
    delete process.env["FAKE_GWS_RESPONSES"]
    delete process.env["FAKE_GWS_OUTPUT_FILE"]
    for (const runtime of runtimes.splice(0)) await runtime.close()
  })

  it("downloads the file with alt=media into a private directory it removes, and remembers what Google returned", async () => {
    const runtime = await testRuntime({ accounts: { personal: account({ services: ["drive"] }) } })
    runtimes.push(runtime)
    process.env["FAKE_GWS_RESPONSES"] = JSON.stringify({ "drive.files.get": { mimeType: "image/webp", size: String(WEBP.byteLength), thumbnailLink: THUMB } })
    process.env["FAKE_GWS_OUTPUT_FILE"] = body(runtime, WEBP)
    expect(await imagesRead(runtime)(LINK)).toEqual({ mime: "image/webp", base64: Buffer.from(WEBP).toString("base64") })
    const argv = readFileSync(join(accountDir(runtime.paths), "invocations.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[])
    const params = (call: string[]) => JSON.parse(call[call.indexOf("--params") + 1]!)
    expect(argv.map((call) => call.slice(0, 3))).toEqual([
      ["drive", "files", "get"],
      ["drive", "files", "get"],
    ])
    expect(params(argv[0]!)).toEqual({ fileId: FILE, "supportsAllDrives": true, fields: "mimeType,size,thumbnailLink" })
    expect(params(argv[1]!)).toEqual({ fileId: FILE, alt: "media", "supportsAllDrives": true })
    expect(argv[1]).toContain("--output")
    expect(argv.flat()).not.toContain("--dry-run")
    expect(readdirSync(runtime.workDir).filter((name) => name.startsWith("call-"))).toEqual([])
    expect(runtime.imageSources.accounts(new URL(THUMB))).toEqual(["personal"])
  })

  it("refuses a download gws wrote over the cap, after the metadata said it fit", async () => {
    const runtime = await testRuntime({ accounts: { personal: account({ services: ["drive"] }) } })
    runtimes.push(runtime)
    process.env["FAKE_GWS_RESPONSES"] = JSON.stringify({ "drive.files.get": { mimeType: "image/png", size: "12" } })
    process.env["FAKE_GWS_OUTPUT_FILE"] = body(runtime, png(IMAGE_MAX_BYTES + 1))
    await expect(imagesRead(runtime)(LINK)).rejects.toThrow(/^IMAGE_TOO_LARGE: /)
    expect(readdirSync(runtime.workDir).filter((name) => name.startsWith("call-"))).toEqual([])
  })

  it("is AUTH_REQUIRED, before gws runs, when the account has no sign-in", async () => {
    const runtime = await testRuntime({ accounts: { personal: account({ services: ["drive"] }) } }, { tokenProvider: async () => undefined })
    runtimes.push(runtime)
    await expect(imagesRead(runtime)(LINK)).rejects.toThrow(/^AUTH_REQUIRED: /)
    await expect(runtime.imageToken("personal", { sessionId: "", agentId: "" })).rejects.toThrow(/^AUTH_REQUIRED: /)
  })

  it("gives the token of an interactive or access-token account, and none for a credentials file", async () => {
    process.env["IMAGES_TEST_TOKEN"] = "ya29.from-env"
    try {
      const runtime = await testRuntime({
        accounts: {
          personal: account({ services: ["drive"] }),
          bot: { mode: "access_token", tokenEnv: "IMAGES_TEST_TOKEN", enabledServices: ["drive"] },
          robot: { mode: "credentials_file", credentialsFileEnv: "IMAGES_TEST_FILE", enabledServices: ["drive"] },
          mail: account({ services: ["gmail"] }),
        },
      })
      runtimes.push(runtime)
      const ctx = { sessionId: "", agentId: "" }
      expect(await runtime.imageToken("personal", ctx)).toBe(TOKEN)
      expect(await runtime.imageToken("bot", ctx)).toBe("ya29.from-env")
      expect(await runtime.imageToken("robot", ctx)).toBeUndefined()
      // An account that does not enable drive never lends its token to a Drive picture.
      await expect(runtime.imageToken("mail", ctx)).rejects.toThrow(/^POLICY_DENIED: /)
    } finally {
      delete process.env["IMAGES_TEST_TOKEN"]
    }
  })
})

describe("reading gws's output file", () => {
  it("refuses a symlink in place of the file, and stops one byte past the cap", async () => {
    const runtime = await testRuntime()
    try {
      const stage = await Stage.create(runtime.workDir)
      mkdirSync(join(stage.dir, "out"))
      writeFileSync(join(runtime.workDir, "secret"), "secret")
      symlinkSync(join(runtime.workDir, "secret"), join(stage.dir, "out/picture"))
      await expect(stage.readCapped("out/picture", 100)).rejects.toThrow(/^DOWNLOAD_INVALID: /)
      writeFileSync(join(stage.dir, "out/big"), new Uint8Array(101))
      expect(await stage.readCapped("out/big", 100)).toBeUndefined()
      expect(await stage.readCapped("out/big", 101)).toHaveLength(101)
      await stage.dispose()
    } finally {
      await runtime.close()
    }
  })
})

describe("the jelly declaration of images.read", () => {
  const jelly = pkg.jelly as {
    tools: { name: string; permission: string; readOnly?: boolean }[]
    rpc: { name: string; label: string; permission: string; readOnly: boolean; input: unknown; output: unknown }[]
    imageHosts: string[]
    imageRead: { method: string }
  }

  it("declares the schemas the method registers, with no pattern (OpenCode refuses every call to one)", () => {
    const method = jelly.rpc.find((entry) => entry.name === "images.read")
    expect(method?.input).toEqual(IMAGE_INPUT)
    expect(method?.output).toEqual(IMAGE_OUTPUT)
    expect(JSON.stringify([IMAGE_INPUT, IMAGE_OUTPUT])).not.toContain("pattern")
  })

  // hey-jelly protocol/contracts/src/plugin-contract.ts PluginDeclarationSchema (imageHosts, imageRead, rpc),
  // plugin-image-read.ts PluginImageReadSchema and imageReadIssues, agent-ui/parts.ts IMAGE_HOST, ported.
  it("passes Jelly's declaration rules for imageHosts, imageRead and the method", () => {
    const IMAGE_HOST = /^\.?[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/u
    const ID = /^[a-zA-Z][a-zA-Z0-9._-]{0,127}$/
    expect(jelly.imageHosts.length).toBeGreaterThan(0)
    expect(jelly.imageHosts.length).toBeLessThanOrEqual(16)
    for (const host of jelly.imageHosts) {
      expect(host.length).toBeGreaterThanOrEqual(1)
      expect(host.length).toBeLessThanOrEqual(253)
      expect(host).toMatch(IMAGE_HOST)
    }
    expect(Object.keys(jelly.imageRead)).toEqual(["method"])
    expect(jelly.imageRead.method).toMatch(/^[a-zA-Z][a-zA-Z0-9._-]{0,63}$/u)
    const method = jelly.rpc.find((entry) => entry.name === jelly.imageRead.method)
    expect(method?.readOnly).toBe(true)
    expect(Object.keys(method ?? {}).sort()).toEqual(["input", "label", "name", "output", "permission", "readOnly"])
    expect(method?.name).toMatch(ID)
    expect(method?.permission).toMatch(ID)
    expect(method?.label.length).toBeGreaterThan(0)
    expect(method?.label.length).toBeLessThanOrEqual(120)
    expect(jelly.rpc.length).toBeLessThanOrEqual(64)
    // The permission is gws_read's, which every access level allows.
    expect(jelly.tools.find((tool) => tool.permission === method?.permission)).toMatchObject({ name: "gws.read", readOnly: true })
  })

  it("answers within Jelly's AgentUiImageReadSchema: one of four types, base64 of at most 1 MB", () => {
    // hey-jelly protocol/contracts/src/agent-ui/routes.ts: max base64 length ceil(1 MiB × 4 / 3) + 8.
    expect(IMAGE_OUTPUT.properties.mime.enum).toEqual(["image/png", "image/jpeg", "image/gif", "image/webp"])
    expect(IMAGE_OUTPUT.properties.base64.maxLength).toBe(Math.ceil((1024 * 1024 * 4) / 3) + 8)
    const answer = imageAnswer(png(IMAGE_MAX_BYTES))
    expect(answer.base64.length).toBeLessThanOrEqual(IMAGE_OUTPUT.properties.base64.maxLength)
    expect(answer.base64).toMatch(/^[A-Za-z0-9+/]+={0,2}$/u)
  })
})
