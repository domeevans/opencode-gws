import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { doctorTarget, probeArgv, probeOutcome, skipDetail, type DoctorOutcome, type DoctorTarget } from "../auth/doctor.js"
import { signInScopes } from "../auth/form.js"
import { integrationIdFor, integrationIds, integrationNames } from "../auth/google.js"
import { accountSignInStatus, connectStep, type ConnectionView } from "../auth/status.js"
import type { Audit } from "../domain/audit.js"
import type { AuthProblemCode, AuthState } from "../domain/auth-state.js"
import { throwIfCancelled } from "../domain/errors.js"
import { adminAccountStep, authProblem, privilegeName, type AuthRemediation } from "../domain/result.js"
import { delegationRequired, restriction } from "../domain/restricted.js"
import { acceptedScopes, grants, shortScope } from "../domain/scopes.js"
import type { RuntimeStatus } from "../domain/status.js"
import { HOST_RANGE, type HostCheck } from "../domain/host.js"
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
interface Progress {
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
  /** Set when a script made the call through the tools RPC rather than a tool call; the audit records it. */
  caller?: "rpc"
  /**
   * Called only when this call must download the gws binary first. It throws to refuse, so the access rules decide
   * whether a download happens on a model's call; without it the download is refused.
   */
  mayDownload?: () => Promise<void>
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
  /** The OpenCode host setup checked; unknown in a runtime made without one. */
  host?: HostCheck
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
  /** Run gws in this staging directory (calls with local files); otherwise in a private directory removed after the call. */
  cwd?: string
}

/** The runtime state account work reads; supplied by `Runtime`. */
interface AccountsContext {
  readonly config: PluginConfig
  readonly options: RuntimeOptions
  readonly binary: string
  readonly version: string
  requireBinary(): string
  binaryFor(ctx: Pick<CallContext, "signal" | "mayDownload">): Promise<string>
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

  /**
   * The binary as status reports it: the verified copy the cache or an override holds, resolved without a download
   * (status never asks for or makes a change). Not installed yet is reported as an empty path, not an error.
   */
  private async binaryStatus(signal?: AbortSignal): Promise<{ path: string; version: string }> {
    await this.runtime.binaryFor({ signal }).catch(() => undefined)
    return { path: this.runtime.binary, version: this.runtime.version }
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
          ...delegationField(profile),
          ...signIn,
        }
      }),
    )
    return {
      auditDegraded: this.runtime.audit.degraded,
      version: options.pluginVersion,
      host: options.host ?? { version: null, range: HOST_RANGE, tested: false },
      binary: await this.binaryStatus(signal),
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
    // gws saves a body that is not JSON to a file in its working directory:
    // a call without its own staging directory runs in a private one, removed after.
    const scratch = options.cwd ? undefined : await mkdtemp(join(this.runtime.workDir, "call-"))
    let result: ProcessResult
    try {
      result = await this.spawn(argv, env, operation, ctx, options.paged === true, options.cwd ?? scratch!)
    } finally {
      if (scratch) await rm(scratch, { recursive: true, force: true }).catch(() => undefined)
    }
    // Only a call that used the integration credential says anything about
    // that connection; headless credentials have no connection to mark.
    if (credential) {
      const problem = authProblem(result, serviceOf(operation))
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
    const reason = restriction(operation)
    if (reason === "app-only") {
      return (
        `AUTH_SCOPE_MISSING: ${operation} needs a scope Google grants only to an app's own credentials (a Chat app or a Classroom add-on), never to a person's sign-in, so '${account}' cannot run it. ` +
        "Next step: Tell the user this method cannot run with a Google sign-in, and use another method."
      )
    }
    if (reason === "domain-wide-delegation") {
      const named = accepted.map(shortScope).join(" or ")
      return (
        `AUTH_SCOPE_MISSING: ${operation} needs ${named}, which Google grants only through domain-wide delegation that a Workspace admin sets up, and the sign-in for '${account}' has not granted it. ` +
        `Next step: Tell the user this method needs domain-wide delegation; once their admin has set it up, they add ${named} to accounts.${account}.scopes and sign in again.`
      )
    }
    const read = signInScopes(profile, "read")
    const named = accepted.slice(0, 5).map(shortScope).join(", ")
    const connect = this.connect(account)
    // The write set covers every method a person's sign-in can run (test/scopes.test.ts), so a miss is a re-consent or write.
    const next = accepted.some((scope) => read.includes(scope))
      ? `to sign in again, ${connect}, and approve every scope Google lists.`
      : `to sign in again, ${connect}, and choose Read and write; or add one of them to accounts.${account}.scopes.`
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

  /** Remediation text for an account's sign-in, consent and admin privilege problems, by credential mode. */
  remediation(account: string, scopes?: readonly string[], service?: string): AuthRemediation {
    const profile = this.runtime.config.accounts[account]
    const named = scopes && scopes.length > 0 ? scopes.slice(0, 5).map(shortScope).join(", ") : undefined
    const grant = named ? `include one of: ${named}` : "include the scope this operation needs"
    const admin = `a Workspace admin account that has ${privilegeName(service)}`
    const remove = `remove ${service ?? "the service"} from accounts.${account}.enabledServices`
    if (profile?.mode === "credentials_file") {
      const source = profile.credentialsFileEnv ? `the credentials file named by ${profile.credentialsFileEnv}` : "the credentials file"
      return { signIn: `replace ${source}`, consent: `replace ${source} with one whose grant can ${grant}`, privilege: `replace ${source} with one for ${admin}, or ${remove}` }
    }
    if (profile?.mode === "access_token") {
      const source = profile.tokenEnv ? `the access token in ${profile.tokenEnv}` : "the access token"
      return { signIn: `refresh ${source}`, consent: `mint ${source} with scopes that ${grant}`, privilege: `mint ${source} for ${admin}, or ${remove}` }
    }
    const connect = this.connect(account)
    const extra = named ? `, or add one of ${named} to accounts.${account}.scopes` : ""
    return {
      signIn: `to sign in again, ${connect}`,
      consent: `to grant the scope, ${connect}, sign in again, and approve every scope, choosing Read and write for a change${extra}`,
      privilege: service ? adminAccountStep(account, service) : `sign in to a separate account alias for ${admin}, or ${remove}`,
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
    return Object.entries(this.runtime.config.accounts).flatMap(([alias, profile]) =>
      profile.enabledServices.map((service) => doctorTarget(alias, service, profile.mode === "interactive" && delegationRequired([service], profile.scopes).length > 0)),
    )
  }

  /** Run one /gws-doctor probe as the account. A failure becomes an outcome, never a throw, except cancellation. */
  async probe(target: DoctorTarget, ctx: CallContext): Promise<DoctorOutcome> {
    if (!target.operation) return { ...target, status: "SKIPPED", detail: skipDetail(target) }
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
      binary: this.runtime.requireBinary(),
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

/** Services this account enables that need domain-wide delegation its scopes do not add; omitted when none. */
function delegationField(profile: AccountProfile): { delegationRequired?: string[] } {
  // A headless credential's grant is not ours to know: the doctor checks it.
  if (profile.mode !== "interactive") return {}
  const services = delegationRequired(profile.enabledServices, profile.scopes)
  return services.length > 0 ? { delegationRequired: services } : {}
}

/** The service of an operation id: its first part, as in `admin-reports.activities.list`. */
function serviceOf(operation: string): string {
  return operation.slice(0, operation.indexOf("."))
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}
