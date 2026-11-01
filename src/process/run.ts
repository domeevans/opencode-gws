import { spawn } from "node:child_process"
import { cancelledError } from "../domain/errors.js"
import type { ProcessResult } from "../domain/types.js"

/**
 * The only spawn site in the plugin. `gws` runs with an argv array,
 * `shell: false`, its own process group (so a kill reaches grandchildren),
 * and byte-capped stdout/stderr.
 */

export interface RunOptions {
  binary: string
  argv: string[]
  cwd: string
  env: Record<string, string>
  timeoutMs: number
  maxStdoutBytes: number
  maxStderrBytes: number
  /** Aborting kills the process group and rejects with `CANCELLED`. */
  signal?: AbortSignal
  /** Observes stdout chunks as they arrive (for progress), after capping. */
  onStdout?: (chunk: Buffer) => void
}

export function runProcess(options: RunOptions): Promise<ProcessResult> {
  if (options.signal?.aborted) return Promise.reject(cancelledError())
  return new Promise((resolvePromise, rejectPromise) => {
    const started = Date.now()
    const child = spawn(options.binary, options.argv, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = Buffer.alloc(0)
    let stderr = Buffer.alloc(0)
    let outputCapped = false
    let timedOut = false
    let cancelled = false

    const kill = (): void => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL")
        else child.kill("SIGKILL")
      } catch {
        try {
          child.kill("SIGKILL")
        } catch {
          /* already gone */
        }
      }
    }

    const timer = setTimeout(() => {
      timedOut = true
      kill()
    }, options.timeoutMs)

    const onAbort = (): void => {
      cancelled = true
      kill()
    }
    options.signal?.addEventListener("abort", onAbort, { once: true })

    const settle = (result: ProcessResult): void => {
      clearTimeout(timer)
      options.signal?.removeEventListener("abort", onAbort)
      // Reject only after the child has exited, so a cancelled call never
      // leaves a running gws behind.
      if (cancelled) rejectPromise(cancelledError())
      else resolvePromise(result)
    }

    child.stdout?.on("data", (chunk: Buffer) => {
      if (outputCapped) return
      stdout = Buffer.concat([stdout, chunk])
      if (stdout.length > options.maxStdoutBytes) {
        stdout = stdout.subarray(0, options.maxStdoutBytes)
        outputCapped = true
        kill()
        return
      }
      options.onStdout?.(chunk)
    })
    child.stderr?.on("data", (chunk: Buffer) => {
      if (outputCapped) return
      stderr = Buffer.concat([stderr, chunk])
      if (stderr.length > options.maxStderrBytes) {
        stderr = stderr.subarray(0, options.maxStderrBytes)
        outputCapped = true
        kill()
      }
    })

    child.on("error", (error) => {
      settle({
        exitCode: null,
        signal: null,
        stdout,
        stderr: Buffer.from(String(error)),
        durationMs: Date.now() - started,
        timedOut,
        outputCapped,
      })
    })
    child.on("close", (code, signal) => {
      settle({
        exitCode: code,
        signal,
        stdout,
        stderr,
        durationMs: Date.now() - started,
        timedOut,
        outputCapped,
      })
    })
  })
}
