import { createHash } from "node:crypto"
import { constants } from "node:fs"
import { link, lstat, mkdir, mkdtemp, open, realpath, rename, rm, stat, unlink, writeFile, type FileHandle } from "node:fs/promises"
import { basename, dirname, isAbsolute, join } from "node:path"
import { withinRootSets, type FileLimits, type InputFile, type OutputFile, type StagedInput } from "../domain/files.js"
import { GwsError, throwIfCancelled } from "../domain/errors.js"

/**
 * Per-call staging directory: the gws cwd for a call that reads or writes
 * local files. gws accepts file paths only inside its cwd, so inputs are
 * copied in before the spawn and the output is delivered after it. Every
 * path check runs on the resolved (realpath) location, so a symlink cannot
 * escape the configured roots.
 */

const CHUNK = 64 * 1024
// Never block on a FIFO swapped in after the type check; never follow a final symlink.
const READ_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)

interface DeliveredFile {
  path: string
  bytes: number
  sha256: string
  /** Publication succeeded, but a sibling staging file could not be removed. */
  cleanupDegraded?: boolean
}

export class Stage {
  private constructor(readonly dir: string, private readonly signal?: AbortSignal) {}

  static async create(workDir: string, signal?: AbortSignal): Promise<Stage> {
    throwIfCancelled(signal)
    const dir = await mkdtemp(join(workDir, "call-"))
    // gws reads a .env from its cwd; an empty one keeps ambient settings out.
    try {
      throwIfCancelled(signal)
      await writeFile(join(dir, ".env"), "", { mode: 0o600 })
      return new Stage(dir, signal)
    } catch (error) {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined)
      throw error
    }
  }

  /** Copy every input into the stage, checking roots, type, and size, and fingerprint the copy. */
  async stageInputs(inputs: readonly InputFile[], limits: FileLimits): Promise<StagedInput[]> {
    const roots = await realRootSets(limits.readRoots)
    const staged: StagedInput[] = []
    for (const input of inputs) staged.push(await this.stageInput(input, limits.maxUploadBytes, roots))
    return staged
  }

  /** Create the directory gws writes the output into. */
  async prepareOutput(output: OutputFile): Promise<void> {
    throwIfCancelled(this.signal)
    await mkdir(dirname(join(this.dir, output.rel)), { recursive: true, mode: 0o700 })
  }

  /**
   * Move the staged output to its destination: size cap, then the same
   * destination checks as planning, then an atomic replace (overwrite) or an
   * atomic no-clobber link. Across filesystems the bytes are copied to a
   * temporary file beside the destination, fsynced, and renamed or linked.
   */
  async deliver(output: OutputFile, limits: FileLimits): Promise<DeliveredFile> {
    throwIfCancelled(this.signal)
    const staged = join(this.dir, output.rel)
    const info = await lstat(staged).catch(() => undefined)
    if (!info?.isFile()) throw new GwsError("DOWNLOAD_INVALID", "gws did not write the output file", { next: "Report it; the plan is used up." })
    if (info.size > limits.maxDownloadBytes) {
      throw new GwsError("DOWNLOAD_LIMIT", `the download is ${info.size} bytes; execution.maxDownloadBytes is ${limits.maxDownloadBytes}. Nothing was written to '${output.destination}'`)
    }
    const target = await checkDestination(output, limits)
    const sha256 = await hashFile(staged)
    const cleanupDegraded = await place(staged, target, output, this.signal)
    return { path: output.destination, bytes: info.size, sha256, ...(cleanupDegraded ? { cleanupDegraded: true } : {}) }
  }

  async dispose(): Promise<void> {
    await rm(this.dir, { recursive: true, force: true })
  }

  private async stageInput(input: InputFile, maxBytes: number, roots: string[][]): Promise<StagedInput> {
    throwIfCancelled(this.signal)
    if (!isAbsolute(input.source)) throw new GwsError("UPLOAD_INVALID", `'${input.source}' must be an absolute path`)
    const real = await realpath(input.source).catch(() => undefined)
    if (!real) throw new GwsError("UPLOAD_INVALID", `'${input.source}' does not exist`)
    if (!withinRootSets(real, roots)) {
      throw new GwsError("POLICY_DENIED", `upload path '${input.source}' resolves outside allowed read roots`, {
        next: "Use a file inside execution.allowedReadRoots, or ask the user to add its folder there.",
      })
    }
    if (!(await stat(real)).isFile()) throw new GwsError("UPLOAD_INVALID", `'${input.source}' is not a regular file`)
    let source: FileHandle | undefined
    let target: FileHandle | undefined
    try {
      source = await open(real, READ_FLAGS)
      const info = await source.stat()
      if (!info.isFile()) throw new GwsError("UPLOAD_INVALID", `'${input.source}' is not a regular file`)
      if (info.size > maxBytes) throw uploadLimit(input.source, info.size, maxBytes)
      const destination = join(this.dir, input.rel)
      throwIfCancelled(this.signal)
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
      throwIfCancelled(this.signal)
      target = await open(destination, "wx", 0o600)
      const hash = createHash("sha256")
      const buffer = Buffer.alloc(CHUNK)
      let bytes = 0
      for (;;) {
        throwIfCancelled(this.signal)
        const { bytesRead } = await source.read(buffer, 0, CHUNK, null)
        if (bytesRead === 0) break
        bytes += bytesRead
        // The file can grow between fstat and the read.
        if (bytes > maxBytes) throw uploadLimit(input.source, bytes, maxBytes)
        const chunk = buffer.subarray(0, bytesRead)
        hash.update(chunk)
        throwIfCancelled(this.signal)
        await target.write(chunk)
      }
      return { ...input, bytes, sha256: hash.digest("hex") }
    } finally {
      await source?.close()
      await target?.close()
    }
  }
}

/**
 * Resolve a destination and refuse it before anything is written: the
 * parent directory must exist, its realpath must be inside every write-root
 * set, and an existing entry is refused unless overwrite is set (a directory
 * always). Returns the resolved target path.
 */
export async function checkDestination(output: OutputFile, limits: FileLimits): Promise<string> {
  if (!isAbsolute(output.destination)) throw new GwsError("DOWNLOAD_INVALID", `'${output.destination}' must be an absolute path`)
  const parent = await realpath(dirname(output.destination)).catch(() => undefined)
  if (!parent) throw new GwsError("DOWNLOAD_INVALID", `the directory for '${output.destination}' does not exist`)
  const target = join(parent, basename(output.destination))
  if (!withinRootSets(target, await realRootSets(limits.writeRoots))) {
    throw new GwsError("POLICY_DENIED", `download path '${output.destination}' resolves outside allowed write roots`, {
      next: "Use a destination inside execution.allowedWriteRoots, or ask the user to add its folder there.",
    })
  }
  const existing = await lstat(target).catch(() => undefined)
  if (existing?.isDirectory()) throw new GwsError("DOWNLOAD_INVALID", `'${output.destination}' is a directory`)
  if (existing && !output.overwrite) throw exists(output.destination)
  return target
}

async function place(staged: string, target: string, output: OutputFile, signal?: AbortSignal): Promise<boolean> {
  throwIfCancelled(signal)
  try {
    if (output.overwrite) await rename(staged, target)
    else await link(staged, target)
    return false
  } catch (error) {
    if (code(error) === "EEXIST") throw exists(output.destination)
    if (code(error) !== "EXDEV" && code(error) !== "EPERM" && code(error) !== "ENOTSUP") throw error
  }
  // Different filesystem (or no hard links): copy beside the target first.
  const temp = join(dirname(target), `.${basename(target)}.${process.pid}.${Date.now()}.partial`)
  let cleanupDegraded = false
  try {
    throwIfCancelled(signal)
    await copyDurable(staged, temp, signal)
    throwIfCancelled(signal)
    if (output.overwrite) await rename(temp, target)
    else {
      try {
        await link(temp, target)
      } catch (error) {
        if (code(error) === "EEXIST") throw exists(output.destination)
        throw error
      }
    }
  } finally {
    await unlink(temp).catch(error => {
      // A successful overwrite renamed the sibling away. Other failures
      // can leave content behind and must be reflected in the receipt.
      if (code(error) !== "ENOENT") cleanupDegraded = true
    })
  }
  return cleanupDegraded
}

async function copyDurable(from: string, to: string, signal?: AbortSignal): Promise<void> {
  const source = await open(from, "r")
  let target: FileHandle | undefined
  try {
    throwIfCancelled(signal)
    target = await open(to, "wx", 0o600)
    const buffer = Buffer.alloc(CHUNK)
    for (;;) {
      throwIfCancelled(signal)
      const { bytesRead } = await source.read(buffer, 0, CHUNK, null)
      if (bytesRead === 0) break
      throwIfCancelled(signal)
      await target.write(buffer.subarray(0, bytesRead))
    }
    await target.sync()
  } finally {
    await source.close()
    await target?.close()
  }
}

async function hashFile(path: string): Promise<string> {
  const handle = await open(path, "r")
  try {
    const hash = createHash("sha256")
    const buffer = Buffer.alloc(CHUNK)
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, CHUNK, null)
      if (bytesRead === 0) break
      hash.update(buffer.subarray(0, bytesRead))
    }
    return hash.digest("hex")
  } finally {
    await handle.close()
  }
}

/** Roots compared by realpath too (e.g. /tmp → /private/tmp); a missing root keeps its literal path. */
async function realRootSets(sets: readonly (readonly string[])[]): Promise<string[][]> {
  return Promise.all(sets.map((roots) => Promise.all(roots.map((root) => realpath(root).catch(() => root)))))
}

function uploadLimit(path: string, bytes: number, max: number): GwsError {
  return new GwsError("UPLOAD_LIMIT", `'${path}' is at least ${bytes} bytes; execution.maxUploadBytes is ${max}`)
}

function exists(path: string): GwsError {
  return new GwsError("DOWNLOAD_EXISTS", `'${path}' already exists; pass download.overwrite: true to replace it, or choose another path`, {
    next: "Ask the user before planning again with download.overwrite set to true.",
  })
}

function code(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code
}
