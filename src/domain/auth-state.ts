/**
 * Per-account sign-in state as observed by tool calls. The runtime reports
 * every observation; the tracker turns them into transitions so the host is
 * told only when an account's state actually changes.
 */

export type AuthProblemCode = "AUTH_REQUIRED" | "AUTH_SCOPE_MISSING"

export type AuthState =
  | { status: "ok" }
  | { status: "needs_auth"; code: AuthProblemCode; message: string }

const UNKNOWN = "\u0000unknown"

export class AuthStateTracker {
  private readonly states = new Map<string, string>()

  /**
   * Record an observation. Returns true when it changes the account's state.
   * An account starts unknown: the host keeps a reported problem across a
   * plugin reload, so the first observation is always reported.
   */
  update(account: string, state: AuthState): boolean {
    const key = state.status === "ok" ? "ok" : `${state.code}\u0000${state.message}`
    const previous = this.states.get(account) ?? UNKNOWN
    if (previous === key) return false
    this.states.set(account, key)
    return true
  }

  /** Mark an account's state unknown, so the next observation is reported whatever it is (after a failed report). */
  forget(account: string): void {
    this.states.set(account, UNKNOWN)
  }
}
