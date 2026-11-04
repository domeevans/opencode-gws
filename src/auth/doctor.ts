import { canonicalJson } from "../domain/digest.js"
import { commandIndex } from "../domain/manifest.js"
import { authProblem, parseResult, privilegeRefused } from "../domain/result.js"
import type { ProcessResult } from "../domain/types.js"
import { enableApisUrl } from "./setup.js"

/**
 * /gws-doctor: one cheap, field-masked read per enabled service, run as the
 * account, so a person can see which services work and what to fix.
 */

/** An id no document has: the API's "not found" still proves it answers. */
const NO_SUCH_ID = "gws-doctor-probe"

interface Probe {
  operation: string
  params: Record<string, unknown>
  /** Looks up NO_SUCH_ID, so "not found" means the API works. */
  notFoundIsOk?: boolean
}

const PROBES: Readonly<Record<string, Probe>> = {
  gmail: { operation: "gmail.users.getProfile", params: { userId: "me", fields: "emailAddress" } },
  drive: { operation: "drive.about.get", params: { fields: "user(emailAddress)" } },
  calendar: { operation: "calendar.calendarList.list", params: { maxResults: 1, fields: "items(id)" } },
  docs: { operation: "docs.documents.get", params: { documentId: NO_SUCH_ID, fields: "documentId" }, notFoundIsOk: true },
  sheets: { operation: "sheets.spreadsheets.get", params: { spreadsheetId: NO_SUCH_ID, fields: "spreadsheetId" }, notFoundIsOk: true },
  slides: { operation: "slides.presentations.get", params: { presentationId: NO_SUCH_ID, fields: "presentationId" }, notFoundIsOk: true },
  tasks: { operation: "tasks.tasklists.list", params: { maxResults: 1, fields: "items(id)" } },
  people: { operation: "people.people.connections.list", params: { resourceName: "people/me", pageSize: 1, personFields: "names", fields: "totalItems" } },
  chat: { operation: "chat.spaces.list", params: { pageSize: 1, fields: "spaces(name)" } },
  classroom: { operation: "classroom.courses.list", params: { pageSize: 1, fields: "courses(id)" } },
  forms: { operation: "forms.forms.get", params: { formId: NO_SUCH_ID, fields: "formId" }, notFoundIsOk: true },
  meet: { operation: "meet.conferenceRecords.list", params: { pageSize: 1, fields: "conferenceRecords(name)" } },
  keep: { operation: "keep.notes.list", params: { pageSize: 1, fields: "notes(name)" } },
  "admin-reports": { operation: "admin-reports.activities.list", params: { userKey: "all", applicationName: "login", maxResults: 1, fields: "items(id)" } },
  script: { operation: "script.processes.list", params: { pageSize: 1, fields: "processes(processType)" } },
}

export interface DoctorTarget {
  account: string
  service: string
  /**
   * The probe's operation id; absent when the service has no read-only
   * check (events, workflow, modelarmor) or needs domain-wide delegation the
   * account's scopes do not add.
   */
  operation?: string
  /** The service needs domain-wide delegation (Keep) and the account's scopes add none of its scopes, so no probe runs. */
  needsDelegation?: true
}

/**
 * DENIED: OpenCode refused the gws.read permission, so the probe did not
 * run. ADMIN_PRIVILEGE_REQUIRED: Google accepted the sign-in but the
 * account lacks the admin privilege the service needs.
 */
export type DoctorStatus = "OK" | "AUTH_REQUIRED" | "AUTH_SCOPE_MISSING" | "ADMIN_PRIVILEGE_REQUIRED" | "API_DISABLED" | "ERROR" | "SKIPPED" | "DENIED"

export interface DoctorOutcome extends DoctorTarget {
  status: DoctorStatus
  /** What happened and what to do, in one sentence. */
  detail?: string
  /** For API_DISABLED: where to enable the API. */
  enableUrl?: string
}

/** The probe target for one account's service; `needsDelegation` skips the probe, because no sign-in without delegation can pass it. */
export function doctorTarget(account: string, service: string, needsDelegation = false): DoctorTarget {
  if (needsDelegation) return { account, service, needsDelegation: true }
  const probe = PROBES[service]
  return probe ? { account, service, operation: probe.operation } : { account, service }
}

/** Why a target without a probe is SKIPPED. */
export function skipDetail(target: DoctorTarget): string {
  if (target.needsDelegation) {
    return `${target.service} needs domain-wide delegation, which a Workspace admin sets up; with it, add ${target.service} or ${target.service}.readonly to accounts.${target.account}.scopes and sign in again`
  }
  return "no read-only check exists for this service"
}

/** The gws argv for a target's probe. */
export function probeArgv(target: DoctorTarget): string[] {
  const probe = PROBES[target.service]
  const entry = probe ? commandIndex().methods.get(probe.operation) : undefined
  if (!probe || !entry) throw new Error(`OPERATION_UNKNOWN: No probe for '${target.service}'`)
  return [entry.service, ...entry.path, entry.method, "--params", canonicalJson(probe.params), "--format", "json"]
}

const DISABLED = /accessNotConfigured|SERVICE_DISABLED|has not been used in project|is disabled/i

/** Classify a probe's finished gws process. */
export function probeOutcome(target: DoctorTarget, result: ProcessResult): DoctorOutcome {
  const parsed = parseResult(result, { maxInlineBytes: 64 * 1024 })
  if (parsed.ok) return { ...target, status: "OK" }
  if (privilegeRefused(result, target.service, parsed)) {
    return { ...target, status: "ADMIN_PRIVILEGE_REQUIRED", detail: "Google accepted the sign-in, but the account lacks the Workspace admin privilege this service needs" }
  }
  const problem = authProblem(result, target.service, parsed)
  if (problem === "AUTH_REQUIRED") return { ...target, status: problem, detail: "Google rejected the sign-in" }
  if (problem === "AUTH_SCOPE_MISSING") return { ...target, status: problem, detail: "Google says the sign-in lacks a scope for this service" }
  const error = apiError(parsed.data)
  const text = `${error?.message ?? ""}\n${result.stderr.toString("utf8")}`
  if (DISABLED.test(text) || error?.reasons.some((reason) => DISABLED.test(reason))) {
    const enableUrl = /https:\/\/console\.(?:developers|cloud)\.google\.com\/\S+/.exec(text)?.[0]?.replace(/[.,)]+$/, "") ?? enableApisUrl([target.service])
    return { ...target, status: "API_DISABLED", detail: "the API is not enabled in the OAuth client's Google Cloud project", enableUrl }
  }
  if (PROBES[target.service]?.notFoundIsOk && (error?.code === 404 || error?.code === 400)) return { ...target, status: "OK" }
  return { ...target, status: "ERROR", detail: (error?.message ?? (result.stderr.toString("utf8").trim() || `gws exited with ${result.exitCode}`)).slice(0, 200) }
}

function apiError(data: unknown): { code?: number; message?: string; reasons: string[] } | undefined {
  const found = Array.isArray(data) ? data.find((item) => isRecord(item) && isRecord(item["error"])) : data
  if (!isRecord(found) || !isRecord(found["error"])) return undefined
  const error = found["error"]
  const reasons = [error["reason"], error["status"], ...listOf(error["errors"]), ...listOf(error["details"])].filter((value): value is string => typeof value === "string")
  return { code: typeof error["code"] === "number" ? error["code"] : undefined, message: typeof error["message"] === "string" ? error["message"] : undefined, reasons }
}

function listOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value.map((item) => (isRecord(item) ? item["reason"] : undefined)) : []
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
