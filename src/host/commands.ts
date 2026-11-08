import { DELEGATION_LABEL, PERMISSIONS_LABEL, SHADOWED_LABEL, SHELL_LABEL, accessText, shadowedText, shellText, connectionLabel, delegationText, openCodeLabel, type GwsAccount, type GwsStatus } from "../rpc.js"
import type { PluginContext } from "./context.js"
import type { DoctorOutcome, DoctorTarget } from "../auth/doctor.js"
import { GOOGLE_LINKS, enableApisUrl } from "../auth/setup.js"
import { Lifecycle } from "../domain/lifecycle.js"
import { redactedPreview, type RedactedPreview } from "../domain/plans.js"
import { adminAccountStep } from "../domain/result.js"
import { shortScope } from "../domain/scopes.js"
import type { CommitCategory, Plan } from "../domain/types.js"

/**
 * `/gws-status` and `/gws-doctor`. Each posts a synthetic message with
 * `resume: false`: no model turn starts. The one-line `description` is
 * what the transcript shows; the full `text` is a redacted view that
 * reaches the model as context on the next turn. No command can approve
 * or commit a plan.
 */

export const COMMANDS = {
  status: { name: "gws-status", description: "Google Workspace: sign-in, access, pending plans, setup steps, and unguarded agents" },
  doctor: { name: "gws-doctor", description: "Google Workspace: check every account's services with one small read each" },
} as const

/** The redacted plan view /gws-status posts: never argv, params, url, a body, or a token. */
interface PlanSummary {
  planId: string
  sessionID: string
  category: CommitCategory
  operation: string
  account: string
  preview: RedactedPreview
  /** ISO timestamp. */
  createdAt: string
  /** ISO timestamp after which the plan cannot be committed. */
  expiresAt: string
}

/** What /gws-doctor runs: the runtime's probes, one per account and enabled service. */
interface DoctorSource {
  doctorTargets(): DoctorTarget[]
  probe(target: DoctorTarget, ctx: { sessionId: string; signal?: AbortSignal }): Promise<DoctorOutcome>
}

interface CommandSources {
  status: (signal?: AbortSignal) => Promise<GwsStatus>
  plans: (sessionID: string) => PlanSummary[]
  doctor: DoctorSource
}

export function planSummary(plan: Plan): PlanSummary {
  return {
    planId: plan.id,
    sessionID: plan.sessionId,
    category: plan.category,
    operation: plan.operation,
    account: plan.account,
    preview: redactedPreview(plan),
    createdAt: new Date(plan.createdAt).toISOString(),
    expiresAt: new Date(plan.expiresAt).toISOString(),
  }
}

/** One line for the transcript entry. */
export function summarizeStatus(status: GwsStatus, plans: readonly PlanSummary[] = []): string {
  const pending = plans.length > 0 ? ` · ${plans.length} pending plan${plans.length === 1 ? "" : "s"}` : ""
  return `${accountSummary(status)}${pending}`
}

function accountSummary(status: GwsStatus): string {
  if (status.accounts.length === 0) return "Google Workspace: no accounts configured"
  const signIn = status.accounts.filter((account) => connectionLabel(account) === "sign-in required").map((account) => account.alias)
  if (signIn.length > 0) return `Google Workspace: sign-in required for ${signIn.join(", ")}`
  const unset = status.accounts.filter((account) => connectionLabel(account) === "not configured").map((account) => account.alias)
  if (unset.length > 0) return `Google Workspace: not configured: ${unset.join(", ")}`
  const missing = status.accounts.filter((account) => (account.missingScopes?.length ?? 0) > 0).map((account) => account.alias)
  if (missing.length > 0) return `Google Workspace: ${missing.join(", ")} did not grant every scope`
  return `Google Workspace: ${status.accounts.length} account${status.accounts.length === 1 ? "" : "s"} connected`
}

function clientLabel(account: GwsAccount): string | undefined {
  if (account.mode !== "interactive") return undefined
  switch (account.clientSource) {
    case "account":
      return `from accounts.${account.alias}.oauthClient`
    case "plugin":
      return "from the plugin's oauthClient option"
    case "pasted":
      return "entered at sign-in"
    default:
      return "none yet"
  }
}

function scopeList(scopes: readonly string[]): string {
  return scopes.map(shortScope).join(", ") || "none"
}

/** One account's rows: Connection, Account, Access, then the client, services and scopes. */
function accountLines(account: GwsAccount): string[] {
  const credential = account.mode === "credentials_file" ? "credentials file" : account.mode === "access_token" ? "access token" : "OpenCode sign-in"
  const lines = [`Connection: ${connectionLabel(account)}`, `Account: ${account.alias} (${credential})`]
  if (account.mode === "interactive") lines.push(`Access: ${account.access === "write" ? "read and write" : "read-only"}`)
  const client = clientLabel(account)
  if (client) lines.push(`Client: ${client}`)
  lines.push(`Services: ${account.services.join(", ") || "none"}`)
  if (account.grantedScopes) lines.push(`Granted scopes: ${scopeList(account.grantedScopes)}`)
  if (account.missingScopes?.length) lines.push(`Scopes not granted: ${scopeList(account.missingScopes)}`)
  if (account.delegationRequired?.length) lines.push(`${DELEGATION_LABEL}: ${delegationText(account)}`)
  return lines
}

/**
 * The status model as plain text, in the shared row order: each account's
 * Connection, Account and Access rows (with its client, services and
 * scopes), the setup steps and pending plans, then Tools, Agents without
 * default rules, OpenCode, and exactly one Next step.
 */
export function formatStatus(status: GwsStatus, plans: readonly PlanSummary[] = [], now = Date.now()): string {
  const lines = ["Google Workspace status", ""]
  if (status.accounts.length === 0) lines.push("Connection: not configured", "Account: none", "")
  for (const account of status.accounts) lines.push(...accountLines(account), "")
  const setup = setupSteps(status)
  if (setup.length > 0) lines.push(...setup, "")
  lines.push(...planLines(plans, now), "")
  if (status.shadowedSkills?.length) lines.push(`${SHADOWED_LABEL}: ${shadowedText(status)}`)
  if (status.shellSkills?.length) lines.push(`${SHELL_LABEL}: ${shellText(status)}`)
  lines.push(`Tools: gws tools for ${status.services.join(", ") || "no services"} (${status.gws.version})`)
  lines.push(`${PERMISSIONS_LABEL}: ${accessText(status)}`)
  if (status.unguardedAgents.length === 0) {
    lines.push("Agents without default rules: none")
  } else {
    lines.push(`Agents without default rules: ${status.unguardedAgents.join(", ")}`, status.permissionsBlock ?? "")
  }
  if (status.auditDegraded) lines.push("Audit: some records could not be saved, so the audit log may be incomplete.")
  lines.push(`OpenCode: ${openCodeLabel(status)}`, `Next step: ${status.nextStep}`)
  return lines.join("\n")
}

/** This session's pending plans, redacted. */
function planLines(plans: readonly PlanSummary[], now: number): string[] {
  const lines: string[] = []
  if (plans.length === 0) {
    lines.push("No pending plans in this session.")
  } else {
    lines.push(`Pending plans in this session (${plans.length}):`)
    for (const plan of plans) {
      const details = [
        plan.preview.recipients?.length ? `to ${plan.preview.recipients.join(", ")}` : undefined,
        plan.preview.recipientsUnknown ? `recipients unknown: ${plan.preview.recipientsUnknown}` : undefined,
        plan.preview.destination ? `destination ${plan.preview.destination}` : undefined,
        plan.preview.bodySummary ? `body ${plan.preview.bodySummary}` : undefined,
        `expires ${remaining(plan.expiresAt, now)}`,
      ].filter(Boolean)
      lines.push(`- ${plan.category} ${plan.operation} as ${plan.account}: ${details.join(" · ")} (${plan.planId})`)
    }
    lines.push("Approval happens only in the OpenCode permission prompt when the agent commits a plan. Pending plans expire automatically.")
  }
  return lines
}

function remaining(expiresAt: string, now: number): string {
  const seconds = Math.max(0, Math.round((Date.parse(expiresAt) - now) / 1000))
  if (seconds === 0) return "now"
  return seconds >= 60 ? `in ${Math.floor(seconds / 60)}m ${seconds % 60}s` : `in ${seconds}s`
}

function connect(account: GwsAccount, several: boolean): string {
  const name = several ? `Google Workspace (${account.alias})` : "Google Workspace"
  return `run /connect and choose ${name}, or run opencode auth login ${account.integrationID}`
}

/** The Google Cloud steps, for interactive accounts that have no client yet. */
function setupSteps(status: GwsStatus): string[] {
  const needs = status.accounts.filter((account) => account.mode === "interactive" && !account.connected && !account.clientSource)
  if (needs.length === 0) return []
  const several = status.accounts.filter((account) => account.mode === "interactive").length > 1
  return [
    `Set up an OAuth client for ${needs.map((account) => account.alias).join(", ")}: create your own Desktop app client, or ask your administrator for one.`,
    "1. Enable the APIs in a Google Cloud project you own:",
    ...needs.map((account) => `   - ${account.alias} (${account.services.join(", ")}): ${enableApisUrl(account.services)}`),
    `2. Configure the OAuth consent screen: ${GOOGLE_LINKS.branding} and ${GOOGLE_LINKS.audience}.`,
    "   - Prefer the Internal user type when the project belongs to your Google Workspace organisation: only your organisation can sign in, and Google does not review the app.",
    `   - An External app left in Testing status gets refresh tokens that expire after 7 days, so you would sign in again every week (${GOOGLE_LINKS.refreshTokenExpiry}). Setting it In production avoids that expiry, at the cost of an unverified-app warning.`,
    `3. Create an OAuth client of type Desktop app at ${GOOGLE_LINKS.clients} (${GOOGLE_LINKS.desktopClientGuide}). A Web client works only with a redirectUri registered on it, for OpenCode on another machine.`,
    `4. To sign in, ${needs.map((account) => connect(account, several)).join("; ")}. Enter its client ID and secret in the sign-in form and choose the access; every change is still a plan, and a commit asks only at ask-changes.`,
    "5. Run /gws-doctor to check each service.",
    "The client and tokens are kept with the sign-in in OpenCode's credential store; the plugin writes no credential files.",
  ]
}

function nextFor(outcome: DoctorOutcome): string | undefined {
  switch (outcome.status) {
    case "API_DISABLED":
      return `enable it at ${outcome.enableUrl}, wait about a minute, and run /gws-doctor again`
    case "DENIED":
      return "allow gws.read for this account in your permissions, or skip the check"
    case "ADMIN_PRIVILEGE_REQUIRED":
      return adminAccountStep(outcome.account, outcome.service)
    default:
      return undefined
  }
}

function formatDoctor(outcomes: readonly DoctorOutcome[]): string {
  const lines = ["Google Workspace doctor", ""]
  if (outcomes.length === 0) lines.push("No account enables a service.")
  for (const outcome of outcomes) {
    const next = nextFor(outcome)
    const text = [outcome.detail, next ? `Next step: ${next.charAt(0).toUpperCase()}${next.slice(1)}` : undefined].filter(Boolean).join(". ")
    lines.push(`- ${outcome.account} ${outcome.service}: ${outcome.status}${text ? ` · ${text}` : ""}`)
  }
  return lines.join("\n")
}

/** One line for the transcript entry. */
function summarizeDoctor(outcomes: readonly DoctorOutcome[]): string {
  const ok = outcomes.filter((outcome) => outcome.status === "OK").length
  const attention = outcomes.filter((outcome) => outcome.status !== "OK" && outcome.status !== "SKIPPED").length
  return `Google Workspace doctor: ${ok} OK${attention ? ` · ${attention} need${attention === 1 ? "s" : ""} attention` : ""}`
}

export async function registerCommands(ctx: PluginContext, sources: CommandSources, signal?: AbortSignal): Promise<() => Promise<void>> {
  const lifetime = new Lifecycle()
  const post = (sessionID: string, delivery: "steer" | "queue", text: string, description: string, command: string) =>
    lifetime.wait(() => ctx.session.synthetic({
      sessionID,
      text,
      description,
      metadata: { source: "opencode-gws", command },
      delivery,
      resume: false,
    }), signal)

  /**
   * Each probe is a real read as the account, so it asks for gws.read on
   * `<account>:<operation>` first, like gws_read. A refusal stops the run;
   * an account that is not signed in is reported once.
   */
  const doctor = async (sessionID: string): Promise<DoctorOutcome[]> => {
    const outcomes: DoctorOutcome[] = []
    const signedOut = new Set<string>()
    for (const target of sources.doctor.doctorTargets()) {
      if (signedOut.has(target.account)) continue
      if (target.operation) {
        try {
          await lifetime.wait(() => ctx.permission.assert({ sessionID, action: "gws.read", resources: [`${target.account}:${target.operation}`] }), signal)
        } catch {
          lifetime.assert(signal)
          outcomes.push({ ...target, status: "DENIED", detail: "a permission rule or reply refused gws.read" })
          break
        }
      }
      const outcome = await sources.doctor.probe(target, { sessionId: sessionID, signal })
      outcomes.push(outcome)
      if (outcome.status === "AUTH_REQUIRED") signedOut.add(target.account)
    }
    return outcomes
  }

  await ctx.command.transform((editor) => {
    editor.add({
      ...COMMANDS.status,
      execute: async ({ sessionID, delivery }) => {
        const status = await lifetime.wait((settled) => sources.status(settled), signal)
        const plans = sources.plans(sessionID)
        await post(sessionID, delivery, formatStatus(status, plans), summarizeStatus(status, plans), COMMANDS.status.name)
      },
    })
    editor.add({
      ...COMMANDS.doctor,
      execute: async ({ sessionID, delivery }) => {
        lifetime.assert(signal)
        const outcomes = await doctor(sessionID)
        await post(sessionID, delivery, formatDoctor(outcomes), summarizeDoctor(outcomes), COMMANDS.doctor.name)
      },
    })
  })
  return () => lifetime.close()
}
