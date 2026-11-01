import { join } from "node:path"
import { doctorTarget, probeArgv, probeOutcome, type DoctorOutcome, type DoctorTarget } from "../auth/doctor.js"
import { signInScopes } from "../auth/form.js"
import { integrationIdFor, integrationIds, integrationNames } from "../auth/google.js"
import { accountSignInStatus, connectStep, type ConnectionView } from "../auth/status.js"
import type { Audit } from "../domain/audit.js"
import type { AuthProblemCode, AuthState } from "../domain/auth-state.js"
import { throwIfCancelled } from "../domain/errors.js"
import { authProblem, type AuthRemediation } from "../domain/result.js"
import { acceptedScopes, grants, shortScope } from "../domain/scopes.js"
import type { RuntimeStatus } from "../domain/status.js"
import type { AccountProfile, PluginConfig, ProcessResult } from "../domain/types.js"
import { buildChildEnv } from "../process/env.js"
import { ownedDir, type PluginPaths } from "../process/paths.js"
import { runProcess } from "../process/run.js"

/**
 * Account credentials and the gws process: the sign-in lookup and scope
 * preflight, the child environment, spawning, sign-in remediation,
 * auth-state reporting, /gws-doctor probes, and the accounts' status.
 */

/** Progress milestones reported while a call runs. */
export interface Progress {
  status: "resolving" | "running" | "parsing"
  operation: string
  /** Pages received so far, for paginated reads. */
  page?: number
}

export interface CallContext {
  sessionId: string
  agentId: string
  /** Aborting stops the gws child and rejects with `CANCELLED`. */
  signal?: AbortSignal
  progress?: (update: Progress) => void
}

/** An interactive account's current sign-in, from OpenCode's credential store. */
export interface AccountCredential {
  /** The access token; it exists only in the gws child environment. */
  access: string
  /** The scopes Google granted the sign-in. */
  grantedScopes: readonly string[]
}

export interface RuntimeOptions {
  pluginVersion: string
  hostVersion?: string
  /** Why setup continued on an untested host; shown in status. */
  hostWarning?: string
  projectDirectory?: string
  /** Plugin-owned directories; the platform defaults unless given. */
  paths?: PluginPaths
  /**
   * The current sign-in of an interactive account: undefined when it has
   * none. A rejection means the sign-in exists but could not be refreshed.
   */
  tokenProvider?: (account: string, signal?: AbortSignal) => Promise<AccountCredential | undefined>
  /** An interactive account's connection, for status. */
  connection?: (account: string, signal?: AbortSignal) => Promise<ConnectionView>
  /**
   * Observe an account's sign-in state after each call that used (or failed
   * to get) its credential. Called on every observation, including
   * repeats; best-effort, so a failure never fails the call.
   */
  onAuthState?: (account: string, state: AuthState, signal?: AbortSignal) => void | Promise<void>
}

/** What a gws run tells the runtime about the account's sign-in state. */
interface RunOptions {
  paged?: boolean
  /** Manifest scopes of the operation, for consent remediation. */
  scopes?: readonly string[]
  /** A --dry-run never contacts Google, so its success says nothing about the credential. */
  dryRun?: boolean
  /** Run gws in this staging directory (calls with local files). */
  cwd?: string
}

/** The runtime state account work reads; supplied by `Runtime`. */
interface AccountsContext {
  readonly config: PluginConfig
  readonly options: RuntimeOptions
  readonly binary: string
  readonly version: string
  readonly workDir: string
  readonly paths: PluginPaths
  readonly audit: Audit
  readonly signal: AbortSignal
  assertActive(signal?: AbortSignal): void
  wait<T>(start: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T>
  visibleServices(): ReadonlySet<string>
}

export class Accounts {
  private readonly integrations: Map<string, string>
  private readonly names: Map<string, string>

  constructor(private readonly runtime: AccountsContext) {
    this.integrations = integrationIds(runtime.config.accounts)
    this.names = integrationNames(runtime.config.accounts)
  }

  async status(signal?: AbortSignal): Promise<RuntimeStatus> {
    this.runtime.assertActive(signal)
    const { config, options } = this.runtime
    const accounts = await Promise.all(
      Object.entries(config.accounts).map(async ([alias, profile]) => {
        const integrationID = this.integrationId(alias)
        const connection = profile.mode === "interactive" ? await this.connection(alias, signal) : undefined
        const signIn = accountSignInStatus({ alias, name: this.names.get(alias) ?? "Google Workspace", integrationID, profile, pluginClient: config.oauthClient, connection })
        return {
          alias,
          mode: profile.mode,
          services: profile.enabledServices,
          ...(profile.mode === "interactive" ? { integrationID } : {}),
          ...signIn,
        }
      }),
    )
    return {
      auditDegraded: this.runtime.audit.degraded,
      pluginVersion: options.pluginVersion,
      hostVersion: options.hostVersion ?? "unknown",
      ...(options.hostWarning ? { hostWarning: options.hostWarning } : {}),
      binary: { path: this.runtime.binary, version: this.runtime.version },
      services: [...this.runtime.visibleServices()].sort(),
      accounts,
    }
  }

  /** The connection as the host reports it; a failed lookup reads as not connected. */
  private async connection(alias: string, signal?: AbortSignal): Promise<ConnectionView | undefined> {
    const lookup = this.runtime.options.connection
    if (!lookup) return undefined
    try {
      return await this.runtime.wait((settled) => lookup(alias, settled), signal)
    } catch {
      this.runtime.assertActive(signal)
      return undefined
    }
  }

  async run(argv: string[], account: string, operation: string, ctx: CallContext, options: RunOptions = {}): Promise<ProcessResult> {
    const profile = this.runtime.config.accounts[account]
    if (!profile) throw new Error(`ACCOUNT_UNKNOWN: '${account}' is not configured`)
    throwIfCancelled(ctx.signal)
    const credential = profile.mode === "interactive" ? await this.credential(account, profile, operation, ctx) : undefined
    this.runtime.assertActive(ctx.signal)
    const env = buildChildEnv(profile, this.accountDir(account), this.runtime.workDir, credential?.access)
    report(ctx, { status: "running", operation })
    const result = await this.spawn(argv, env, operation, ctx, options.paged === true, options.cwd ?? this.runtime.workDir)
    // Only a call that used the integration credential says anything about
    // that connection; headless credentials have no connection to mark.
    if (credential) {
      const problem = authProblem(result)
      if (problem) this.observeAuth(account, { status: "needs_auth", code: problem, message: this.authMessage(account, problem, options.scopes) })
      else if (result.exitCode === 0 && options.dryRun !== true) this.observeAuth(account, { status: "ok" })
    }
    return result
  }

  /**
   * The interactive account's credential, checked against the operation
   * before anything spawns: no sign-in fails with AUTH_REQUIRED, and a
   * grant without any scope the operation accepts fails with
   * AUTH_SCOPE_MISSING.
   */
  private async credential(account: string, profile: AccountProfile, operation: string, ctx: CallContext): Promise<AccountCredential> {
    const provider = this.runtime.options.tokenProvider
    let credential: AccountCredential | undefined
    try {
      credential = provider ? await this.runtime.wait((signal) => provider(account, signal), ctx.signal) : undefined
    } catch {
      this.runtime.assertActive(ctx.signal)
      this.observeAuth(account, { status: "needs_auth", code: "AUTH_REQUIRED", message: this.authMessage(account, "AUTH_REQUIRED") })
      throw new Error(`AUTH_REQUIRED: The Google Workspace sign-in for '${account}' could not be refreshed. Next step: ${capitalize(this.remediation(account).signIn)}.`)
    }
    this.runtime.assertActive(ctx.signal)
    if (!credential) {
      throw new Error(`AUTH_REQUIRED: '${account}' is not signed in to Google Workspace. Next step: To sign in, ${this.connect(account)}.`)
    }
    const accepted = acceptedScopes(operation)
    if (!grants(accepted, credential.grantedScopes)) throw new Error(this.scopeMissing(account, profile, operation, accepted))
    return credential
  }

  private scopeMissing(account: string, profile: AccountProfile, operation: string, accepted: readonly string[]): string {
    const read = signInScopes(profile, "read")
    const write = signInScopes(profile, "write")
    const named = accepted.slice(0, 5).map(shortScope).join(", ")
    const extra = `add one of them to accounts.${account}.scopes`
    const connect = this.connect(account)
    const next = accepted.some((scope) => read.includes(scope))
      ? `to sign in again, ${connect}, and approve every scope Google lists.`
      : accepted.some((scope) => write.includes(scope))
        ? `to sign in again, ${connect}, and choose Read and write; or ${extra}.`
        : `${extra}; then, to sign in again, ${connect}.`
    return `AUTH_SCOPE_MISSING: The sign-in for '${account}' has not granted a scope ${operation} needs (one of: ${named}). Next step: ${capitalize(next)}`
  }

  private integrationId(account: string): string {
    return this.integrations.get(account) ?? integrationIdFor(account)
  }

  private connect(account: string): string {
    return connectStep(this.names.get(account) ?? "Google Workspace", this.integrationId(account))
  }

  /** The plugin-owned per-account gws directory: its Discovery cache, and in credentials_file mode its token cache. */
  private accountDir(account: string): string {
    return ownedDir(join(this.runtime.paths.cacheDir, "accounts", this.integrationId(account).replace(/^gws-/, "")))
  }

  /** Remediation text for an account's sign-in and consent problems, by credential mode. */
  remediation(account: string, scopes?: readonly string[]): AuthRemediation {
    const profile = this.runtime.config.accounts[account]
    const named = scopes && scopes.length > 0 ? scopes.slice(0, 5).map(shortScope).join(", ") : undefined
    const grant = named ? `include one of: ${named}` : "include the scope this operation needs"
    if (profile?.mode === "credentials_file") {
      const source = profile.credentialsFileEnv ? `the credentials file named by ${profile.credentialsFileEnv}` : "the credentials file"
      return { signIn: `replace ${source}`, consent: `replace ${source} with one whose grant can ${grant}` }
    }
    if (profile?.mode === "access_token") {
      const source = profile.tokenEnv ? `the access token in ${profile.tokenEnv}` : "the access token"
      return { signIn: `refresh ${source}`, consent: `mint ${source} with scopes that ${grant}` }
    }
    const connect = this.connect(account)
    const extra = named ? `, or add one of ${named} to accounts.${account}.scopes` : ""
    return {
      signIn: `to sign in again, ${connect}`,
      consent: `to grant the scope, ${connect}, sign in again, and approve every scope, choosing Read and write for a change${extra}`,
    }
  }

  private authMessage(account: string, code: AuthProblemCode, scopes?: readonly string[]): string {
    const remediation = this.remediation(account, scopes)
    return code === "AUTH_REQUIRED" ? capitalize(remediation.signIn) : capitalize(remediation.consent)
  }

  private observeAuth(account: string, state: AuthState): void {
    const signal = this.runtime.signal
    if (signal.aborted) return
    try {
      const pending = this.runtime.options.onAuthState?.(account, state, signal)
      if (pending) pending.catch(() => undefined)
    } catch {
      /* best-effort: reporting never fails the call */
    }
  }

  /** Every account and enabled service /gws-doctor checks, in config order. */
  doctorTargets(): DoctorTarget[] {
    this.runtime.assertActive()
    return Object.entries(this.runtime.config.accounts).flatMap(([alias, profile]) => profile.enabledServices.map((service) => doctorTarget(alias, service)))
  }

  /** Run one /gws-doctor probe as the account. A failure becomes an outcome, never a throw, except cancellation. */
  async probe(target: DoctorTarget, ctx: CallContext): Promise<DoctorOutcome> {
    if (!target.operation) return { ...target, status: "SKIPPED", detail: "no read-only check exists for this service" }
    const started = Date.now()
    try {
      const result = await this.run(probeArgv(target), target.account, target.operation, ctx)
      const outcome = probeOutcome(target, result)
      this.runtime.audit.emit({ event: "operation.read", outcome: outcome.status === "OK" ? "success" : "error", account: target.account, category: "read", operation: target.operation, durationMs: Date.now() - started })
      return outcome
    } catch (error) {
      throwIfCancelled(ctx.signal)
      this.runtime.assertActive()
      const message = error instanceof Error ? error.message : String(error)
      const code = /^([A-Z_]+):\s*/.exec(message)
      const status = code?.[1] === "AUTH_REQUIRED" || code?.[1] === "AUTH_SCOPE_MISSING" ? code[1] : "ERROR"
      return { ...target, status, detail: code ? message.slice(code[0].length) : message }
    }
  }

  private spawn(argv: string[], env: Record<string, string>, operation: string, ctx: CallContext, paged: boolean, cwd: string): Promise<ProcessResult> {
    const { execution } = this.runtime.config
    let page = 0
    return runProcess({
      binary: this.runtime.binary,
      argv,
      cwd,
      env,
      timeoutMs: execution.timeoutMs,
      maxStdoutBytes: execution.maxStdoutBytes,
      maxStderrBytes: execution.maxStderrBytes,
      signal: ctx.signal,
      // Paginated gws output is NDJSON: one line per page.
      onStdout: paged && ctx.progress
        ? (chunk) => {
            for (const byte of chunk) if (byte === 0x0a) report(ctx, { status: "running", operation, page: ++page })
          }
        : undefined,
    })
  }
}

/** Progress is best-effort: a host failure to record it never fails the call. */
export function report(ctx: Pick<CallContext, "progress">, update: Progress): void {
  try {
    ctx.progress?.(update)
  } catch {
    /* ignore */
  }
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}
