import { auditErrorCode, type Audit } from "../domain/audit.js"
import { appOnly } from "../domain/app-only.js"
import { effectiveCategory, isCommittable } from "../domain/classify.js"
import { buildCommand, itemCap, wantsPages } from "../domain/command.js"
import type { CommitOutput, PlanOutput, ReadOutput, RequestInput, SchemaOutput } from "../domain/contract.js"
import { GwsError, throwIfCancelled } from "../domain/errors.js"
import { hasFiles, type FileLimits, type FileSpecs, type PlannedFiles, type StagedInput } from "../domain/files.js"
import { helperAdapter, type HelperAdapter } from "../domain/helpers.js"
import { commandIndex, HELPER_ALTERNATIVES, helperInput, resolveOperation } from "../domain/manifest.js"
import type { PlanStore } from "../domain/plans.js"
import { evaluatePolicy, type PolicyDecision } from "../domain/policy.js"
import { capPageItems, inlineCap, isApiError, parseResult, processError, redactDryRun } from "../domain/result.js"
import type { BuiltCommand, Category, CommitCategory, HelperEntry, MethodEntry, Plan, PluginConfig, Request } from "../domain/types.js"
import type { SchemaClient } from "../process/schema.js"
import { Stage, checkDestination } from "../process/staging.js"
import { report, type Accounts, type CallContext } from "./accounts.js"

/**
 * The operation pipeline: resolve → classify → policy → build → run →
 * parse, for schema, read, plan, and commit, plus plan storage and audit.
 * It knows nothing about OpenCode; `src/host/` adapts it to tools.
 */

/** A resolved, policy-checked request: what a permission prompt names. */
export interface Target {
  account: string
  operation: string
  service: string
  category: Category
}

/** A resolved schema request: what the gws.schema permission prompt names. */
export interface SchemaTarget extends Pick<Target, "account" | "operation" | "service"> {
  entry?: MethodEntry
  helper?: HelperEntry
}

/** The runtime state operations read; supplied by `Runtime`. */
interface OperationsContext {
  readonly config: PluginConfig
  readonly plans: PlanStore
  readonly workDir: string
  readonly schema: SchemaClient
  readonly audit: Audit
  assertActive(signal?: AbortSignal): void
  isVisible(service: string): boolean
}

/** A request resolved against the config and the manifest. */
interface Resolved {
  request: Request
  entry: MethodEntry
  helper?: HelperAdapter
}

/** Request fields a helper does not take: its flags go in `input`. */
const METHOD_FIELDS = ["params", "body", "fields", "pagination", "upload", "download"] as const

const PLAN_INSTEAD = "Call gws_plan with the same request, then commit with the tool named by the plan's category."

export class Operations {
  constructor(
    private readonly runtime: OperationsContext,
    private readonly accounts: Accounts,
  ) {}

  /** The configured account a call names, or the only one when it names none. */
  private account(alias: string | undefined): string {
    const aliases = Object.keys(this.runtime.config.accounts)
    if (alias === undefined) {
      if (aliases.length === 1) return aliases[0]!
      throw new GwsError("ACCOUNT_REQUIRED", `${aliases.length} accounts are configured (${aliases.join(", ")}); the call must name one`)
    }
    if (!this.runtime.config.accounts[alias]) {
      throw new GwsError("ACCOUNT_UNKNOWN", `'${alias}' is not configured`, { next: `Pass one of the configured accounts: ${aliases.join(", ")}.` })
    }
    return alias
  }

  /** A manifest operation by id, or OPERATION_UNKNOWN. */
  private operation(id: string): { method: MethodEntry } | { helper: HelperEntry } {
    const found = resolveOperation(id)
    if (!found) throw new GwsError("OPERATION_UNKNOWN", `'${id}' is not in the gws manifest`)
    return found
  }

  private visible(service: string): void {
    if (!this.runtime.isVisible(service)) {
      throw new GwsError("POLICY_DENIED", `service '${service}' is not in the model-facing services list`, {
        next: "Tell the user; they can add the service to the plugin's services option.",
      })
    }
  }

  private resolve(input: RequestInput): Resolved {
    this.runtime.assertActive()
    const request: Request = { ...input, account: this.account(input.account) }
    const found = this.operation(request.operation)
    if ("method" in found) {
      if (request.input !== undefined) {
        throw new GwsError("GWS_VALIDATION_ERROR", `'${found.method.id}' is a method and takes params and body, not input`)
      }
      this.visible(found.method.service)
      return { request, entry: found.method }
    }
    const { helper } = found
    const adapter = helperAdapter(helper.id)
    if (!adapter) {
      const alternative = HELPER_ALTERNATIVES[helper.id]
      throw new GwsError("HELPER_UNSUPPORTED", `'${helper.id}' has no adapter yet; it is cataloged but not executable`, {
        ...(alternative ? { next: `Use the method "${alternative}" instead; gws_schema shows its parameters.` } : {}),
      })
    }
    const extra = METHOD_FIELDS.filter((field) => request[field] !== undefined)
    if (extra.length > 0) {
      throw new GwsError("GWS_VALIDATION_ERROR", `'${helper.id}' is a helper and takes its flags in input, not ${extra.join(", ")}`, {
        next: `Move the flags into input; gws_schema with operation "${helper.id}" shows them.`,
      })
    }
    this.visible(helper.service)
    // Check the flags here, so bad input is a GWS_VALIDATION_ERROR before any assert or spawn, not a ZodError from build.
    const flags = adapter.inputSchema.safeParse(request.input ?? {})
    if (!flags.success) {
      const issues = flags.error.issues.map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`).join("; ")
      throw new GwsError("GWS_VALIDATION_ERROR", `'${helper.id}' input: ${issues}`, {
        next: `Fix the input; gws_schema with operation "${helper.id}" shows its flags.`,
      })
    }
    return { request, entry: helperAsEntry(helper), helper: adapter }
  }

  private gate(resolved: Resolved, mode: "read" | "plan"): { category: Category; decision: PolicyDecision } {
    const { entry, helper, request } = resolved
    if (mode === "read") {
      if (helper) {
        if (helper.category !== "read") throw new GwsError("POLICY_DENIED", `helper '${helper.id}' is ${helper.category}, not read`, { next: PLAN_INSTEAD })
      } else {
        const category = effectiveCategory(entry, request)
        if (category !== "read") {
          throw new GwsError("POLICY_DENIED", `'${entry.id}' is ${category}; use gws_plan and the matching commit tool`, { next: PLAN_INSTEAD })
        }
      }
      const decision = evaluatePolicy(this.runtime.config, entry, "read", request)
      if (decision.effect === "deny") throw new GwsError("POLICY_DENIED", decision.violations.join("; "))
      return { category: "read", decision }
    }
    const category = helper ? helper.category : effectiveCategory(entry, request)
    if (!isCommittable(category)) {
      throw new GwsError("POLICY_DENIED", `'${entry.id}' is ${category} and cannot be planned for commit`, {
        next: category === "read" ? "Run it with gws_read." : "Tell the user the plugin never runs it.",
      })
    }
    const decision = evaluatePolicy(this.runtime.config, entry, category, request)
    if (decision.effect === "deny") throw new GwsError("POLICY_DENIED", decision.violations.join("; "))
    // Defense in depth: the policy decision above already enforces both
    // fences, but admin planning must never proceed on an allow alone.
    if (category === "admin" && (!this.runtime.config.admin.enabled || decision.effect !== "allow")) {
      throw new GwsError("POLICY_DENIED", "admin operations require admin.enabled, an allowed service, and a reason when one is required")
    }
    return { category, decision }
  }

  /**
   * Resolve and policy-check a request without running anything, so the
   * host can ask for permission on the exact account and operation first.
   */
  inspect(input: RequestInput, mode: "read" | "plan"): Target {
    const resolved = this.resolve(input)
    const { category } = this.gate(resolved, mode)
    return {
      account: resolved.request.account,
      operation: resolved.entry.id,
      service: resolved.entry.service,
      category,
    }
  }

  /**
   * Resolve a schema request and check that its service is enabled for the
   * account and model-facing, without running anything.
   */
  inspectSchema(alias: string | undefined, operation: string): SchemaTarget {
    this.runtime.assertActive()
    const account = this.account(alias)
    const profile = this.runtime.config.accounts[account]!
    const found = this.operation(operation)
    const target: SchemaTarget =
      "method" in found
        ? { account, operation: found.method.id, service: found.method.service, entry: found.method }
        : { account, operation: found.helper.id, service: found.helper.service, helper: found.helper }
    if (!profile.enabledServices.includes(target.service)) {
      throw new GwsError("POLICY_DENIED", `service '${target.service}' is not enabled for '${account}'`, {
        next: `Use an account that enables ${target.service}, or ask the user to add it to accounts.${account}.enabledServices.`,
      })
    }
    this.visible(target.service)
    return target
  }

  /** Describe an inspected operation: `gws schema` for a method; the manifest entry and input flags for a helper. */
  async describe(target: SchemaTarget, ctx: Pick<CallContext, "signal" | "progress">): Promise<SchemaOutput> {
    if (target.helper) {
      const input = helperInput(target.helper.id)
      return { ok: true, account: target.account, helper: { ...target.helper, ...(input === undefined ? {} : { input }) } }
    }
    const entry = target.entry!
    report(ctx, { status: "running", operation: entry.id })
    const schema = await this.runtime.schema.resolve(entry.service, [...entry.path, entry.method], ctx.signal)
    this.runtime.assertActive(ctx.signal)
    return { ok: true, account: target.account, schema, ...(appOnly(entry.id) ? { appOnly: true as const } : {}) }
  }

  /** Validate a commit against its stored plan without consuming it. */
  inspectPlan(category: CommitCategory, input: { planId: string }, ctx: Pick<CallContext, "sessionId" | "agentId">): Plan {
    this.runtime.assertActive()
    return this.runtime.plans.check(input.planId, { sessionId: ctx.sessionId, agentId: ctx.agentId, category })
  }

  async read(input: RequestInput, ctx: CallContext): Promise<ReadOutput> {
    const resolved = this.resolve(input)
    const { entry, helper, request } = resolved
    const started = Date.now()
    try {
      const { decision } = this.gate(resolved, "read")
      const limits = { maxPages: decision.constraints.maxPages, maxItems: decision.constraints.maxItems }
      const paged = !helper && wantsPages(request)
      const argv = helper
        ? helper.build(request.input ?? {}, request).argv
        : buildCommand(entry, request, this.runtime.config, { dryRun: false, category: "read", limits }).argv
      const result = await this.accounts.run(argv, request.account, entry.id, ctx, { paged, scopes: entry.scopes })
      report(ctx, { status: "parsing", operation: entry.id })
      this.runtime.assertActive(ctx.signal)
      const parsed = parseResult(result, {
        maxInlineBytes: this.runtime.config.execution.maxInlineBytes,
        mode: helper ? undefined : request.response?.mode,
        requestedInlineBytes: helper ? undefined : request.response?.maxInlineBytes,
      })
      // Text helpers (+triage, +read in text mode) are valid output, not
      // JSON parse failures; a helper fails only on exit code or API error.
      const failed = helper ? result.exitCode !== 0 || isApiError(parsed.data) : !parsed.ok
      if (failed) throw processError(result, parsed, this.accounts.remediation(request.account, entry.scopes))
      const pages = paged ? capPageItems(parsed.data, itemCap(request, limits)) : undefined
      const cap = inlineCap(this.runtime.config.execution.maxInlineBytes, request.response?.mode, request.response?.maxInlineBytes)
      const truncated = pages ? Buffer.byteLength(JSON.stringify(pages.data)) > cap : parsed.truncated
      this.runtime.audit.emit({
        event: helper ? "helper.read" : "operation.read",
        outcome: "success",
        account: request.account,
        category: "read",
        operation: entry.id,
        durationMs: Date.now() - started,
        caller: ctx.caller,
      })
      return {
        ok: true,
        operation: entry.id,
        category: "read",
        data: helper ? (parsed.data ?? parsed.raw ?? result.stdout.toString("utf8")) : pages ? pages.data : parsed.data,
        truncated,
        diagnostics: parsed.diagnostics,
        pagination: pages ? { pages: pages.pages, items: pages.items, capped: pages.capped } : undefined,
        trust: { workspaceContent: "untrusted" },
      }
    } catch (error) {
      this.runtime.audit.emit({ event: "operation.read", outcome: "error", account: request.account, operation: entry.id, durationMs: Date.now() - started, errorCode: auditErrorCode(error), caller: ctx.caller })
      throw error
    }
  }

  async plan(input: RequestInput, ctx: CallContext): Promise<PlanOutput> {
    const resolved = this.resolve(input)
    const { entry, helper, request } = resolved
    const started = Date.now()
    const { category, decision } = this.gate(resolved, "plan")
    const commitCategory = category as CommitCategory
    const limits = fileLimits(decision)

    let dryRunArgv: string[]
    let commitArgv: string[]
    let preview: BuiltCommand["preview"]
    let files: FileSpecs | undefined
    if (helper) {
      const built = helper.build(request.input ?? {}, request)
      dryRunArgv = [...built.argv, "--dry-run"]
      commitArgv = built.argv
      preview = built.preview
      files = built.files
    } else {
      const dry = buildCommand(entry, request, this.runtime.config, { dryRun: true, category })
      const commit = buildCommand(entry, request, this.runtime.config, { dryRun: false, category })
      dryRunArgv = dry.argv
      commitArgv = commit.argv
      preview = commit.preview
      files = commit.files
    }

    // Refuse a bad destination before the dry run, and fingerprint every
    // input: the commit re-stages the same paths and must find the same bytes.
    if (files?.output) await checkDestination(files.output, limits)
    let planned: PlannedFiles | undefined
    let parsed: ReturnType<typeof parseResult>
    const stage = hasFiles(files) ? await Stage.create(this.runtime.workDir, ctx.signal) : undefined
    try {
      const inputs = stage && files ? await stage.stageInputs(files.inputs, limits) : []
      if (stage && files?.output) await stage.prepareOutput(files.output)
      if (files && hasFiles(files)) planned = { inputs, output: files.output, limits }
      const dry = await this.accounts.run(dryRunArgv, request.account, entry.id, ctx, { scopes: entry.scopes, dryRun: true, cwd: stage?.dir })
      report(ctx, { status: "parsing", operation: entry.id })
      parsed = parseResult(dry, { maxInlineBytes: this.runtime.config.execution.maxInlineBytes })
      if (dry.exitCode !== 0 || !parsed.ok) throw processError(dry, parsed, this.accounts.remediation(request.account, entry.scopes))
    } finally {
      await stage?.dispose()
    }
    // A plan created after the caller gave up would be an orphan.
    throwIfCancelled(ctx.signal)

    // The reason is operator context, not a gws argument: it lives only in
    // the preview and the plan of any category; audit never stores this free text.
    const reason = request.reason?.trim()
    const planPreview = reason ? { ...preview, reason } : preview

    const plan = this.runtime.plans.create({
      account: request.account,
      sessionId: ctx.sessionId,
      agentId: ctx.agentId,
      category: commitCategory,
      operation: entry.id,
      service: entry.service,
      argv: commitArgv,
      preview: planPreview,
      files: planned,
      ttlSeconds: this.runtime.config.policy.planTtlSeconds,
    })
    this.runtime.audit.emit({
      event: "operation.plan",
      outcome: "success",
      account: request.account,
      category,
      operation: entry.id,
      durationMs: Date.now() - started,
      caller: ctx.caller,
    })
    return {
      ok: true,
      planId: plan.id,
      expiresAt: new Date(plan.expiresAt).toISOString(),
      category: commitCategory,
      preview: planPreview,
      dryRun: redactDryRun(parsed.data),
    }
  }

  async commit(category: CommitCategory, input: { planId: string }, ctx: CallContext): Promise<CommitOutput> {
    const existing = this.inspectPlan(category, input, ctx)
    // Refuse before acquiring, so a call cancelled while waiting for
    // approval, or blocked by a file that appeared since planning, leaves
    // the plan ready.
    throwIfCancelled(ctx.signal)
    if (existing.files?.output) await checkDestination(existing.files.output, existing.files.limits)
    this.runtime.assertActive(ctx.signal)
    const plan: Plan = this.runtime.plans.acquire(input.planId, {
      sessionId: ctx.sessionId,
      agentId: ctx.agentId,
      account: existing.account,
      category,
    })
    const started = Date.now()
    let stage: Stage | undefined
    let receipt: CommitOutput | undefined
    try {
      if (plan.files) stage = await Stage.create(this.runtime.workDir, ctx.signal)
      if (stage && plan.files) {
        const staged = await stage.stageInputs(plan.files.inputs, plan.files.limits)
        refuseChanged(plan.files.inputs, staged)
        if (plan.files.output) await stage.prepareOutput(plan.files.output)
      }
      const scopes = commandIndex().methods.get(plan.operation)?.scopes
      const result = await this.accounts.run(plan.argv, plan.account, plan.operation, ctx, { scopes, cwd: stage?.dir })
      report(ctx, { status: "parsing", operation: plan.operation })
      const parsed = parseResult(result, { maxInlineBytes: this.runtime.config.execution.maxInlineBytes })
      if (!parsed.ok) throw processError(result, parsed, this.accounts.remediation(plan.account, scopes))
      // The change is applied once gws succeeds; a delivery failure after
      // that is reported but cannot be retried with the same plan.
      const delivered = stage && plan.files?.output ? await stage.deliver(plan.files.output, plan.files.limits) : undefined
      const file = delivered ? { path: delivered.path, bytes: delivered.bytes, sha256: delivered.sha256 } : undefined
      this.runtime.plans.complete(plan.id)
      this.runtime.audit.emit({
        event: "operation.commit",
        outcome: "success",
        account: plan.account,
        category,
        operation: plan.operation,
        durationMs: Date.now() - started,
      })
      receipt = { ok: true, planId: plan.id, category, operation: plan.operation, result: parsed.data ?? parsed.raw, file, ...(delivered?.cleanupDegraded ? { cleanupDegraded: true } : {}) }
      return receipt
    } catch (error) {
      this.runtime.plans.release(plan.id)
      this.runtime.audit.emit({
        event: "operation.commit",
        outcome: "error",
        account: plan.account,
        category,
        operation: plan.operation,
        durationMs: Date.now() - started,
        errorCode: auditErrorCode(error),
      })
      if (ctx.signal?.aborted) {
        throw new GwsError(
          "CANCELLED",
          "the commit was stopped while gws was running; the change may or may not have been applied. Verify with gws_read before planning again",
          { next: "Tell the user the change may have been applied; do not commit it again." },
        )
      }
      throw error
    } finally {
      try { await stage?.dispose() } catch { if (receipt) receipt.cleanupDegraded = true }
    }
  }
}

function fileLimits(decision: PolicyDecision): FileLimits {
  const { maxUploadBytes, maxDownloadBytes, readRoots, writeRoots } = decision.constraints
  return { maxUploadBytes, maxDownloadBytes, readRoots, writeRoots }
}

function refuseChanged(planned: readonly StagedInput[], staged: readonly StagedInput[]): void {
  for (const [index, expected] of planned.entries()) {
    const actual = staged[index]
    if (!actual || actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256) {
      throw new GwsError("UPLOAD_CHANGED", `'${expected.source}' changed after the plan was created; create a new plan`)
    }
  }
}

function helperAsEntry(helper: { id: string; service: string; category: string; name: string }): MethodEntry {
  return {
    id: helper.id,
    service: helper.service,
    path: [],
    method: helper.name,
    httpMethod: "HELPER",
    pathTemplate: null,
    scopes: [],
    category: helper.category as MethodEntry["category"],
  }
}
