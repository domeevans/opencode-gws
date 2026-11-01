import { cancelledError, throwIfCancelled } from "./errors.js"

/** Revocation for retained callbacks and asynchronous work owned by one runtime. */
export class Lifecycle {
  private readonly controller = new AbortController()
  private readonly pending = new Set<Promise<unknown>>()
  readonly signal: AbortSignal = this.controller.signal

  compose(signal?: AbortSignal): AbortSignal {
    return signal ? AbortSignal.any([this.signal, signal]) : this.signal
  }

  assert(signal?: AbortSignal): void {
    throwIfCancelled(this.signal)
    throwIfCancelled(signal)
  }

  /** Non-cooperative metadata/permission/token waits settle on revocation. */
  wait<T>(start: (signal: AbortSignal) => Promise<T>, caller?: AbortSignal): Promise<T> {
    const signal = this.compose(caller)
    return new Promise<T>((resolve, reject) => {
      const abort = () => { signal.removeEventListener("abort", abort); reject(cancelledError()) }
      if (signal.aborted) { abort(); return }
      signal.addEventListener("abort", abort, { once: true })
      try {
        start(signal).then(value => {
          signal.removeEventListener("abort", abort)
          if (signal.aborted) reject(cancelledError())
          else resolve(value)
        }, error => {
          signal.removeEventListener("abort", abort)
          reject(signal.aborted ? cancelledError() : error)
        })
      } catch (error) {
        signal.removeEventListener("abort", abort)
        reject(error)
      }
    })
  }

  /** Process and publication work must settle themselves, not lose their result in a race. */
  track<T>(start: () => Promise<T>): Promise<T> {
    const pending = Promise.resolve().then(() => { this.assert(); return start() })
    this.pending.add(pending)
    void pending.then(() => this.pending.delete(pending), () => this.pending.delete(pending))
    return pending
  }

  async close(): Promise<void> {
    this.controller.abort()
    await Promise.allSettled([...this.pending])
  }
}
