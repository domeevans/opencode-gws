import { writeFile, mkdir } from "node:fs/promises"
import { write } from "node:fs"
import { dirname } from "node:path"
import { GwsError, isErrorCode } from "./errors.js"
import { commandIndex } from "./manifest.js"

const EVENTS = new Set(["plugin.loaded", "operation.read", "helper.read", "operation.plan", "operation.commit"])
const CATEGORIES = new Set(["read", "write", "send", "share", "delete", "export", "admin"])
/** Recorded for an error that is not a plugin error. */
const UNKNOWN_ERROR = "UNKNOWN_ERROR"

/** Only the code from the error table is retained; never an upstream message or arbitrary exception. */
export function auditErrorCode(error: unknown): string {
  return GwsError.from(error)?.code ?? UNKNOWN_ERROR
}

interface AuditEvent {
  event: string
  outcome: "success" | "error" | "denied"
  account?: string
  category?: string
  operation?: string
  durationMs?: number
  errorCode?: string
}

type Writer = (line: string, signal: AbortSignal) => Promise<void>
const MAX_QUEUE = 64
const WRITE_TIMEOUT_MS = 100

/** Nonblocking, bounded audit. A stalled sink is quarantined until runtime reload. */
export class Audit {
  degraded = false
  private closed = false
  private stalled = false
  private readonly queue: string[] = []
  private active?: { controller: AbortController; timer: ReturnType<typeof setTimeout> }
  private readonly write: Writer

  constructor(
    private readonly config: { enabled: boolean; sink: "stderr" | "jsonl"; path?: string },
    private readonly version: string,
    writer?: Writer,
  ) {
    this.write = writer ?? (async (line, signal) => {
      if (this.config.sink === "jsonl" && this.config.path) {
        await mkdir(dirname(this.config.path), { recursive: true, mode: 0o700 })
        if (signal.aborted) return
        await writeFile(this.config.path, line, { flag: "a", mode: 0o600, signal })
      } else {
        await writeStderr(line, signal)
      }
    })
  }

  emit(event: AuditEvent): void {
    if (!this.config.enabled || this.closed || this.stalled) return
    if (!EVENTS.has(event.event) || !["success", "error", "denied"].includes(event.outcome)) { this.degraded = true; return }
    if (this.queue.length >= MAX_QUEUE) { this.degraded = true; return }
    const index = commandIndex()
    // Explicit projection: extra properties, reasons, parameters and error text never reach storage.
    this.queue.push(`${JSON.stringify({
      timestamp: new Date().toISOString(), plugin: "opencode-gws", version: this.version,
      event: event.event, outcome: event.outcome,
      account: event.account && /^[a-zA-Z0-9_-]{1,64}$/.test(event.account) ? event.account : undefined,
      category: event.category && CATEGORIES.has(event.category) ? event.category : undefined,
      operation: event.operation && (index.methods.has(event.operation) || index.helpers.has(event.operation)) ? event.operation : undefined,
      durationMs: Number.isFinite(event.durationMs) && event.durationMs! >= 0 ? Math.round(event.durationMs!) : undefined,
      errorCode: event.errorCode === undefined ? undefined : isErrorCode(event.errorCode) ? event.errorCode : UNKNOWN_ERROR,
    })}\n`)
    this.pump()
  }

  private pump(): void {
    if (this.active || this.closed || this.stalled) return
    const line = this.queue.shift()
    if (line === undefined) return
    const controller = new AbortController()
    const timer = setTimeout(() => {
      this.degraded = true
      this.stalled = true
      this.queue.length = 0
      controller.abort()
      // Never dispatch a replacement while this underlying write may still be alive.
    }, WRITE_TIMEOUT_MS)
    this.active = { controller, timer }
    void Promise.resolve().then(() => {
      if (!controller.signal.aborted) return this.write(line, controller.signal)
    }).catch(() => { this.degraded = true }).finally(() => {
      clearTimeout(timer)
      this.active = undefined
      this.pump()
    })
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    if (this.queue.length || this.active) this.degraded = true
    this.queue.length = 0
    if (this.active) {
      clearTimeout(this.active.timer)
      this.active.controller.abort()
    }
  }
}

/** Use the fd API so a closed pipe cannot emit an unhandled stream error. */
async function writeStderr(line: string, signal: AbortSignal): Promise<void> {
  const bytes = Buffer.from(`[opencode-gws] ${line}`)
  let offset = 0
  while (offset < bytes.length) {
    if (signal.aborted) return
    const written = await new Promise<number>((resolve, reject) => {
      write(2, bytes, offset, bytes.length - offset, null, (error, count) => error ? reject(error) : resolve(count))
    })
    if (written === 0) throw new Error("Audit write made no progress")
    offset += written
  }
}
