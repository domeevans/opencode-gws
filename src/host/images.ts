import { GwsError, throwIfCancelled } from "../domain/errors.js"
import { IMAGE_MAX_BYTES, IMAGE_MIMES, IMAGE_URL_MAX, type ImageMime, driveFileId, imageAccount, imageAnswer, imageUrl, isDriveLink, tooLarge } from "../domain/images.js"
import { fetchImage } from "../process/image-fetch.js"
import type { Runtime } from "../runtime/index.js"

/**
 * `images.read`, the read Jelly makes to draw a Google picture in an agent's UI (hey-jelly
 * `backend/host/src/agent-ui/image-route.ts`). Jelly sends the element's address, `{ url }`, only to the plugin whose
 * `imageHosts` name its host, after judging the declared permission, `gws.read`, against the agent's rules: an RPC
 * call carries no session, so the plugin cannot ask itself. Jelly never sees the token.
 *
 * - A Drive link (`drive.google.com`) is never fetched. Its file id is read through gws, as the account: the file's
 *   `mimeType`, `size` and `thumbnailLink`, then, for a PNG, JPEG, GIF or WebP of at most 1 MB, its bytes
 *   (`alt=media`, in a private staging directory removed before the answer). Any other file answers its thumbnail.
 * - Any other address must be on one of Google's image servers (`PICTURE_SERVERS`), and is fetched over HTTPS by
 *   `fetchImage`. The account's token goes with it only when Google returned that exact address to the account in
 *   this process (`ImageSources`), as a Drive file's `thumbnailLink` is. Otherwise it is fetched without credentials.
 * - The answer's `mime` comes from the bytes, never from a header or Drive's `mimeType`; SVG and every other kind are
 *   refused. A picture over 1 MB is refused, never cut short.
 * - Nothing is kept: no bytes in memory after the call, and no address in an error, a log or the audit.
 */

/** The read's own deadline, inside Jelly's ten seconds. */
export const IMAGE_DEADLINE_MS = 8_000
/** How many pictures are read at once; one more is `IMAGE_UNAVAILABLE`, so a UI of hundreds cannot flood Google. */
export const IMAGE_CONCURRENCY = 4

/** The method's declared schemas; `package.json` `jelly.rpc` carries the same two (test/images.test.ts). */
export const IMAGE_INPUT = {
  type: "object",
  additionalProperties: false,
  required: ["url"],
  properties: { url: { type: "string", minLength: 9, maxLength: IMAGE_URL_MAX } },
} as const
export const IMAGE_OUTPUT = {
  type: "object",
  additionalProperties: false,
  required: ["mime", "base64"],
  properties: {
    mime: { type: "string", enum: [...IMAGE_MIMES] },
    base64: { type: "string", minLength: 1, maxLength: Math.ceil((IMAGE_MAX_BYTES * 4) / 3) + 8 },
  },
} as const

export interface ImageAnswer {
  mime: ImageMime
  base64: string
}

type Reader = Pick<Runtime, "config" | "read" | "readDriveFile" | "imageToken" | "imageSources"> & { readonly audit?: Pick<Runtime["audit"], "emit"> }

export interface ImagesOptions {
  /** The network seam for `fetchImage`. */
  readonly fetchImpl?: typeof fetch
}

/**
 * How one read runs as the image source (`images_read` on the tools RPC) asks: as a named account rather than the one
 * the address picks, with the source's own permission check before the Drive read, and told which account read it.
 * Jelly's `images.read` passes none of these.
 */
export interface ImageReadAs {
  /** Read a Drive file as this account, through its sign-in. */
  readonly account?: string
  /**
   * Fetch an address on Google's image servers without any account's token, even one Google returned to an account. The
   * image source sets it: a credentialed fetch from an image server is no gws operation, so no grant could name it, and
   * the source fetches only what needs no sign-in.
   */
  readonly hostedWithoutToken?: true
  /** Called with the account and operation before the Drive read runs; it throws to refuse. */
  readonly authorize?: (account: string, operation: string) => Promise<void>
  /** Told the account whose sign-in read the picture; not called for a picture fetched without credentials. */
  readonly onAccount?: (account: string) => void
}

/** `images.read` over `runtime`, as the module says. */
export function imagesRead(runtime: Reader, options: ImagesOptions = {}) {
  let active = 0

  const fetchAs = async (url: string, account: string | undefined, signal: AbortSignal): Promise<Uint8Array> => {
    const ctx = { sessionId: "", agentId: "", caller: "rpc" as const, signal }
    const token = account === undefined ? undefined : await runtime.imageToken(account, ctx)
    return fetchImage(url, { token, signal, fetchImpl: options.fetchImpl })
  }

  const drive = async (url: URL, signal: AbortSignal, as: ImageReadAs): Promise<{ account: string; bytes: Uint8Array }> => {
    const fileId = driveFileId(url)
    const account = as.account ?? imageAccount(runtime.config, runtime.imageSources.accounts(url))
    const ctx = { sessionId: "", agentId: "", caller: "rpc" as const, signal }
    await as.authorize?.(account, "drive.files.get")
    const meta = await runtime.read({ account, operation: "drive.files.get", params: { fileId, "supportsAllDrives": true, fields: "mimeType,size,thumbnailLink" } }, ctx)
    const { mimeType, size, thumbnailLink } = (meta.data ?? {}) as { mimeType?: unknown; size?: unknown; thumbnailLink?: unknown }
    const bytesOf = typeof size === "string" && /^\d{1,15}$/.test(size) ? Number(size) : undefined
    if (typeof mimeType === "string" && (IMAGE_MIMES as readonly string[]).includes(mimeType) && bytesOf !== undefined && bytesOf <= IMAGE_MAX_BYTES) {
      const bytes = await runtime.readDriveFile({ account, fileId }, IMAGE_MAX_BYTES, ctx)
      if (bytes === undefined) throw tooLarge()
      return { account, bytes }
    }
    if (typeof thumbnailLink === "string") {
      const thumbnail = imageUrl(thumbnailLink)
      // Google just returned the thumbnail to this account; fetchImage takes only Google's image servers.
      return { account, bytes: await fetchAs(thumbnail.href, account, signal) }
    }
    if (bytesOf !== undefined && bytesOf > IMAGE_MAX_BYTES) throw tooLarge()
    throw new GwsError("IMAGE_UNAVAILABLE", "the Drive file is not a picture and has no thumbnail")
  }

  const hosted = async (url: URL, signal: AbortSignal, as: ImageReadAs): Promise<{ account?: string; bytes: Uint8Array }> => {
    if (as.hostedWithoutToken) return { bytes: await fetchAs(url.href, undefined, signal) }
    const returnedTo = runtime.imageSources.accounts(url)
    if (returnedTo.length === 0) return { bytes: await fetchAs(url.href, undefined, signal) }
    const account = imageAccount(runtime.config, returnedTo)
    return { account, bytes: await fetchAs(url.href, account, signal) }
  }

  return async (address: unknown, signal?: AbortSignal, as: ImageReadAs = {}): Promise<ImageAnswer> => {
    const started = Date.now()
    let account: string | undefined
    const audit = (outcome: "success" | "error", errorCode?: string) =>
      runtime.audit?.emit({ event: "images.read", outcome, account, category: "read", durationMs: Date.now() - started, caller: "rpc", ...(errorCode ? { errorCode } : {}) })
    if (active >= IMAGE_CONCURRENCY) {
      audit("error", "IMAGE_UNAVAILABLE")
      throw new GwsError("IMAGE_UNAVAILABLE", `${IMAGE_CONCURRENCY} pictures are already being read`, { next: "Retry in a moment." })
    }
    const deadline = new AbortController()
    const composed = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const error = new GwsError("TIMEOUT", `the picture was not read within ${IMAGE_DEADLINE_MS / 1000} seconds`, { next: "Retry later." })
        deadline.abort(error)
        reject(error)
      }, IMAGE_DEADLINE_MS)
    })
    try {
      throwIfCancelled(signal)
      const url = imageUrl(address)
      // A read counts against the limit until its work settles, even after the deadline has answered for it.
      active++
      const work = (isDriveLink(url) ? drive(url, composed, as) : hosted(url, composed, as))
        .then((read) => {
          account = read.account
          if (read.account !== undefined) as.onAccount?.(read.account)
          return imageAnswer(read.bytes)
        })
        .finally(() => {
          active--
        })
      work.catch(() => undefined)
      const answer = await Promise.race([work, late])
      audit("success")
      return answer
    } catch (error) {
      audit("error", GwsError.from(error)?.code ?? "UNKNOWN_ERROR")
      throw error
    } finally {
      clearTimeout(timer)
    }
  }
}
