import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Audit } from "../domain/audit.js"
import { GWS_VERSION } from "../domain/backend.js"
import type { CommitOutput, PlanOutput, ReadOutput, RequestInput, SchemaOutput } from "../domain/contract.js"
import { Lifecycle } from "../domain/lifecycle.js"
import { canonicalService, loadManifest } from "../domain/manifest.js"
import { PlanStore } from "../domain/plans.js"
import type { RuntimeStatus } from "../domain/status.js"
import type { CommitCategory, Plan, PluginConfig } from "../domain/types.js"
import type { DoctorOutcome, DoctorTarget } from "../auth/doctor.js"
import { resolveBinary } from "../process/binary.js"
import { localEnv } from "../process/env.js"
import { ownedDir, pluginPaths, type PluginPaths } from "../process/paths.js"
import { runProcess } from "../process/run.js"
import { createWorkDir, removeStaleWorkDirs } from "../process/workdir.js"
import { SchemaClient } from "../process/schema.js"
import { Accounts, type CallContext, type RuntimeOptions } from "./accounts.js"
import { Operations, type SchemaTarget, type Target } from "./operations.js"

/** How long one `gws schema` lookup may take. */
const SCHEMA_TIMEOUT_MS = 15_000

/**
 * The orchestrator: owns the lifecycle, the binary, the work directory,
 * the plan store and audit, and composes account work (accounts.ts) with
 * the operation pipeline (operations.ts). It knows nothing about OpenCode;
 * `src/host/` adapts it to tools.
 */

export class Runtime {
  readonly plans = new PlanStore()
  readonly workDir: string
  readonly paths: PluginPaths
  readonly binary: string
  readonly audit: Audit
  readonly schema: SchemaClient
  private visible?: ReadonlySet<string>
  private readonly lifetime = new Lifecycle()
  private readonly accounts: Accounts
  private readonly operations: Operations
  private closing?: Promise<void>

  get signal(): AbortSignal { return this.lifetime.signal }

  assertActive(signal?: AbortSignal): void { this.lifetime.assert(signal) }

  wait<T>(start: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    return this.lifetime.wait(start, signal)
  }

  private invocation<T>(ctx: Pick<CallContext, "signal" | "progress">, start: (control: Pick<CallContext, "signal" | "progress">) => Promise<T>): Promise<T> {
    const signal = this.lifetime.compose(ctx.signal)
    return this.lifetime.track(() => {
      this.assertActive(signal)
      return start({ ...ctx, signal, progress: update => { if (!signal.aborted) ctx.progress?.(update) } })
    })
  }

  private constructor(
    readonly config: PluginConfig,
    readonly options: RuntimeOptions,
    binary: string,
    readonly version: string,
  ) {
    this.binary = binary
    this.paths = options.paths ?? pluginPaths()
    this.workDir = createWorkDir()
    this.audit = new Audit({ ...config.audit, path: config.audit.path ?? join(this.paths.stateDir, "audit.jsonl") }, options.pluginVersion)
    this.schema = new SchemaClient(binary, this.workDir, localEnv(this.workDir, ownedDir(join(this.paths.cacheDir, "discovery"))), SCHEMA_TIMEOUT_MS)
    this.accounts = new Accounts(this)
    this.operations = new Operations(this, this.accounts)
  }

  static async create(config: PluginConfig, options: RuntimeOptions): Promise<Runtime> {
    const binary = resolveBinary(config, options.projectDirectory)
    // Work folders of servers that stopped without closing.
    removeStaleWorkDirs()
    const probeDir = mkdtempSync(join(tmpdir(), "opencode-gws-probe-"))
    let version = "unknown"
    try {
      const probe = await runProcess({
        binary,
        argv: ["--version"],
        cwd: probeDir,
        env: localEnv(probeDir),
        timeoutMs: 10_000,
        maxStdoutBytes: 64 * 1024,
        maxStderrBytes: 64 * 1024,
      })
      version = probe.stdout.toString("utf8").split("\n")[0]?.trim() ?? "unknown"
      if (probe.exitCode !== 0 || probe.timedOut || probe.outputCapped || version !== GWS_VERSION || version !== loadManifest().gwsVersion) {
        throw new Error(`GWS_VERSION_MISMATCH: Requires ${GWS_VERSION} and the matching manifest`)
      }
    } finally {
      rmSync(probeDir, { recursive: true, force: true })
    }
    return new Runtime(config, options, binary, version)
  }

  /** Model-facing service allowlist: explicit config.services or the account union. */
  visibleServices(): ReadonlySet<string> {
    this.assertActive()
    if (this.visible) return this.visible
    const configured = this.config.services ?? Object.values(this.config.accounts).flatMap((profile) => profile.enabledServices)
    this.visible = new Set(configured.map(canonicalService))
    return this.visible
  }

  isVisible(service: string): boolean {
    return this.visibleServices().has(canonicalService(service))
  }

  /** Versions, the binary, and each account's sign-in state, read from OpenCode's credential store. */
  status(signal?: AbortSignal): Promise<RuntimeStatus> {
    return this.accounts.status(signal)
  }

  /** Every account and enabled service /gws-doctor checks. */
  doctorTargets(): DoctorTarget[] {
    return this.accounts.doctorTargets()
  }

  /** Run one /gws-doctor probe as its account. */
  async probe(target: DoctorTarget, ctx: Pick<CallContext, "sessionId" | "signal">): Promise<DoctorOutcome> {
    return this.invocation(ctx, control => this.accounts.probe(target, { ...ctx, agentId: "", ...control }))
  }

  /**
   * Resolve and policy-check a request without running anything, so the
   * host can ask for permission on the exact account and operation first.
   */
  inspect(request: RequestInput, mode: "read" | "plan"): Target {
    return this.operations.inspect(request, mode)
  }

  /**
   * Resolve a schema request and check that its service is enabled for the
   * account and model-facing, without running anything.
   */
  inspectSchema(account: string | undefined, operation: string): SchemaTarget {
    return this.operations.inspectSchema(account, operation)
  }

  /** Validate a commit against its stored plan without consuming it. */
  inspectPlan(category: CommitCategory, input: { planId: string }, ctx: Pick<CallContext, "sessionId" | "agentId">): Plan {
    return this.operations.inspectPlan(category, input, ctx)
  }

  /** Describe an inspected operation: `gws schema` for a method, the manifest entry for a helper. */
  async describe(target: SchemaTarget, ctx: Pick<CallContext, "signal" | "progress">): Promise<SchemaOutput> {
    return this.invocation(ctx, control => this.operations.describe(target, control))
  }

  async read(request: RequestInput, ctx: CallContext): Promise<ReadOutput> {
    return this.invocation(ctx, control => this.operations.read(request, { ...ctx, ...control }))
  }

  async plan(request: RequestInput, ctx: CallContext): Promise<PlanOutput> {
    return this.invocation(ctx, control => this.operations.plan(request, { ...ctx, ...control }))
  }

  async commit(category: CommitCategory, input: { planId: string }, ctx: CallContext): Promise<CommitOutput> {
    return this.invocation(ctx, control => this.operations.commit(category, input, { ...ctx, ...control }))
  }

  close(): Promise<void> {
    if (this.closing) return this.closing
    const settled = this.lifetime.close()
    this.plans.invalidateAll()
    this.audit.close()
    this.closing = settled.then(() => { rmSync(this.workDir, { recursive: true, force: true }) })
    return this.closing
  }
}
