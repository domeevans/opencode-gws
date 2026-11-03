import type { AuthProblemCode } from "./auth-state.js"
import { GwsError } from "./errors.js"
import type { ProcessResult } from "./types.js"

/** Interpret a finished `gws` process: JSON/NDJSON parsing, API errors, and error codes. */

/** True when a gws payload is an API error object (even if exit code is 0). */
export function isApiError(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(isApiError)
  if (!value || typeof value !== "object") return false
  const record = value as Record<string, unknown>
  return "error" in record && record.error !== null && typeof record.error === "object"
}

interface ParsedResult {
  ok: boolean
  data?: unknown
  raw?: string
  truncated: boolean
  diagnostics: { exitCode: number | null; durationMs: number; bytes: number }
}

function parseJson(text: string): unknown {
  const lines = text.split("\n")
  const start = lines.findIndex((line) => /^[[{]/.test(line.trim()))
  if (start < 0) return undefined
  const candidate = lines.slice(start).join("\n").trim()
  try {
    return JSON.parse(candidate)
  } catch {
    // NDJSON: parse only lines that are actual JSON values. Text tables
    // can contain "[ALERT ...]" subjects that must not be treated as JSON.
    const parsed: unknown[] = []
    for (const line of lines.slice(start)) {
      const value = line.trim()
      if (!/^[[{]/.test(value)) continue
      try {
        parsed.push(JSON.parse(value))
      } catch {
        /* not JSON; keep scanning */
      }
    }
    return parsed.length > 0 ? parsed : undefined
  }
}

type ResponseMode = "summary" | "full"

/**
 * Inline byte cap for a read: "full" raises the configured cap to 5 MiB, and
 * a requested cap can only lower the result.
 */
export function inlineCap(maxInlineBytes: number, mode?: ResponseMode, requested?: number): number {
  const base = mode === "full" ? Math.max(maxInlineBytes, 5 * 1024 * 1024) : maxInlineBytes
  return requested === undefined ? base : Math.min(base, requested)
}

export function parseResult(
  result: ProcessResult,
  options: { maxInlineBytes: number; mode?: ResponseMode; requestedInlineBytes?: number },
): ParsedResult {
  const text = result.stdout.toString("utf8")
  const parsed = parseJson(text)
  const serialized = parsed === undefined ? text : JSON.stringify(parsed)
  const bytes = Buffer.byteLength(serialized)
  const cap = inlineCap(options.maxInlineBytes, options.mode, options.requestedInlineBytes)
  const truncated = bytes > cap
  const empty = text.trim().length === 0
  return {
    // A successful DELETE commonly returns 204 with no body. Empty output
    // with exit 0 is success; non-JSON text is not a JSON result.
    ok: result.exitCode === 0 && (empty || (parsed !== undefined && !isApiError(parsed))),
    data: parsed,
    raw: parsed === undefined ? text.slice(0, cap) : undefined,
    truncated,
    diagnostics: { exitCode: result.exitCode, durationMs: result.durationMs, bytes },
  }
}

interface PagedData {
  /** One element per page. */
  data: unknown[]
  pages: number
  /** Items kept across pages; absent when a page has no single item array. */
  items?: number
  /** True when items or pages were dropped to honour the item cap. */
  capped: boolean
}

/** A page's item array key: `items` when it is an array, else the only top-level array. */
function itemKey(page: unknown): string | undefined {
  if (!page || typeof page !== "object" || Array.isArray(page)) return undefined
  const record = page as Record<string, unknown>
  if (Array.isArray(record["items"])) return "items"
  const arrays = Object.keys(record).filter((key) => Array.isArray(record[key]))
  return arrays.length === 1 ? arrays[0] : undefined
}

/**
 * Normalise paginated gws output (NDJSON, one line per page) to one array
 * element per page, then keep at most `maxItems` items. A page cut short
 * loses its `nextPageToken`, which would otherwise skip the dropped items;
 * later pages are dropped. A page with no recognisable item array (and an
 * empty page, which has none) disables counting rather than guessing.
 */
export function capPageItems(data: unknown, maxItems: number): PagedData {
  const pages = data === undefined ? [] : Array.isArray(data) ? data : [data]
  const keys = pages.map((page) => itemKey(page) ?? (isEmptyPage(page) ? null : undefined))
  if (keys.some((key) => key === undefined)) return { data: pages, pages: pages.length, capped: false }
  const kept: unknown[] = []
  let items = 0
  let capped = false
  for (const [index, page] of pages.entries()) {
    if (items >= maxItems) {
      capped = true
      break
    }
    const key = keys[index]
    if (!key) {
      kept.push(page)
      continue
    }
    const record = page as Record<string, unknown>
    const list = record[key] as unknown[]
    const room = maxItems - items
    if (list.length > room) {
      const { nextPageToken: _dropped, ...rest } = record
      kept.push({ ...rest, [key]: list.slice(0, room) })
      items += room
      capped = true
      break
    }
    kept.push(page)
    items += list.length
  }
  return { data: kept, pages: kept.length, items, capped }
}

/** A page with no array at all (e.g. `{"resultSizeEstimate":0}`) holds zero items. */
function isEmptyPage(page: unknown): boolean {
  if (!page || typeof page !== "object" || Array.isArray(page)) return false
  return !Object.values(page as Record<string, unknown>).some(Array.isArray)
}

/** Remove request bodies from a --dry-run payload before it reaches the model. */
export function redactDryRun(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactDryRun)
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (/^(body|raw|content)$/i.test(key)) out[key] = "[redacted]"
      else out[key] = redactDryRun(child)
    }
    return out
  }
  return value
}

interface ApiErrorPayload {
  code?: number
  message?: string
  status?: string
  reason?: string
  errors?: Array<{ reason?: string }>
  details?: Array<{ reason?: string }>
  /** gws adds the console link when an API is not enabled. */
  enable_url?: string
}

function apiErrorOf(result: ProcessResult, parsed?: ParsedResult): ApiErrorPayload | undefined {
  const data = parsed ? parsed.data : parseJson(result.stdout.toString("utf8"))
  const found = Array.isArray(data) ? data.find(isApiError) : data
  if (!isApiError(found)) return undefined
  return (found as { error: ApiErrorPayload }).error
}

function stderrText(result: ProcessResult): string {
  return result.stderr
    .toString("utf8")
    .split("\n")
    .filter((line) => line.trim() && !/^Using keyring backend:/i.test(line))
    .join("\n")
    .trim()
}

/** gws exit codes other than 1, Google's API errors (`gws --help`, EXIT CODES). */
const EXIT = { auth: 2, validation: 3, discovery: 4, internal: 5 } as const

const SCOPE_REASONS = new Set(["ACCESS_TOKEN_SCOPE_INSUFFICIENT", "insufficientPermissions"])

/**
 * The Admin SDK's answers to a valid sign-in whose account lacks an admin
 * privilege: Reports' "Access denied. You are not authorized to read
 * activity records.", the Directory's "Not Authorized to access this
 * resource/api", and their kin. Google sends some as 401 with reason
 * authError, the same code and reason as a bad token; only the message
 * tells them apart.
 */
const PRIVILEGE_REFUSALS = /\bnot authori[sz]ed to (?:read|access|view|list|use|manage|perform)\b|\bcaller does not have access to the customers? reporting data\b/i

/**
 * True when Google authenticated the sign-in but refused the call because
 * the account lacks an admin privilege (`ADMIN_PRIVILEGE_REQUIRED`). Not a
 * sign-in problem: signing in again as the same account cannot help, so
 * the account is never marked as needing sign-in. A gws auth error (exit
 * 2) and invalid_grant are token failures, never a refusal.
 */
export function privilegeRefused(result: ProcessResult, parsed?: ParsedResult): boolean {
  if (result.timedOut || result.outputCapped || result.exitCode === 0 || result.exitCode === EXIT.auth) return false
  const error = apiErrorOf(result, parsed)
  if (error?.code !== undefined && error.code !== 401 && error.code !== 403) return false
  const text = [error?.message, stderrText(result)].filter(Boolean).join("\n")
  return !/invalid_grant/i.test(text) && PRIVILEGE_REFUSALS.test(text)
}

/** The Workspace admin privilege a service's API needs, as the Admin console names it. */
const ADMIN_PRIVILEGES: Readonly<Record<string, string>> = { "admin-reports": "Reports" }

/** "the Reports privilege" for admin-reports; "the admin privilege it needs" otherwise. */
export function privilegeName(service?: string): string {
  const name = service ? ADMIN_PRIVILEGES[service] : undefined
  return name ? `the ${name} privilege` : "the admin privilege it needs"
}

/**
 * Classify a failed gws process as a sign-in problem. `AUTH_REQUIRED`: the
 * credential is missing, expired, or revoked (401, UNAUTHENTICATED,
 * invalid_grant). `AUTH_SCOPE_MISSING`: the credential works but lacks a
 * scope (403 insufficientPermissions / ACCESS_TOKEN_SCOPE_INSUFFICIENT).
 * An admin privilege refusal (`privilegeRefused`) is neither.
 */
export function authProblem(result: ProcessResult, parsed?: ParsedResult): AuthProblemCode | undefined {
  if (result.timedOut || result.outputCapped) return undefined
  if (privilegeRefused(result, parsed)) return undefined
  const error = apiErrorOf(result, parsed)
  if (result.exitCode === 0 && !error) return undefined
  const reasons = [error?.reason, ...(error?.errors ?? []).map((item) => item?.reason), ...(error?.details ?? []).map((item) => item?.reason)]
  const text = [error?.message, error?.status, stderrText(result)].filter(Boolean).join("\n")
  if (reasons.some((reason) => reason !== undefined && SCOPE_REASONS.has(reason)) || /insufficient authentication scopes|ACCESS_TOKEN_SCOPE_INSUFFICIENT/i.test(text)) {
    return "AUTH_SCOPE_MISSING"
  }
  if (
    error?.code === 401 ||
    error?.status === "UNAUTHENTICATED" ||
    reasons.includes("authError") ||
    /invalid_grant|\bUNAUTHENTICATED\b|^error\[auth\]/im.test(text)
  ) {
    return "AUTH_REQUIRED"
  }
  return undefined
}

/** Remediation appended to auth error codes; the runtime knows the account and operation. */
export interface AuthRemediation {
  signIn: string
  consent: string
  /** For ADMIN_PRIVILEGE_REQUIRED: sign in as an admin with the privilege, or stop enabling the service. */
  privilege: string
}

const GENERIC_REMEDIATION: AuthRemediation = {
  signIn: "sign in to the account again",
  consent: "sign in again and grant the scope this operation needs",
  privilege: "sign in with a Workspace admin account that has the admin privilege this operation needs, or remove the service from enabledServices",
}

const DISABLED_REASONS = new Set(["accessNotConfigured", "SERVICE_DISABLED"])
const CONSOLE_URL = /https:\/\/console\.(?:developers|cloud)\.google\.com\/[^\s"'<>)]+/

interface DisabledApi {
  /** Where to enable the API, from gws's `enable_url`, Google's message, or gws's stderr hint. */
  enableUrl?: string
  /** The Google Cloud project the API is disabled in. */
  project?: string
}

/** A failed call because the API is not enabled in the client's project, with what gws says about where to enable it. */
export function disabledApi(result: ProcessResult, parsed?: ParsedResult): DisabledApi | undefined {
  const error = apiErrorOf(result, parsed)
  const reasons = [error?.reason, ...(error?.errors ?? []).map((item) => item?.reason), ...(error?.details ?? []).map((item) => item?.reason)]
  const text = [error?.message, stderrText(result)].filter(Boolean).join("\n")
  if (!reasons.some((reason) => reason !== undefined && DISABLED_REASONS.has(reason)) && !/accessnotconfigured|has not been used|is disabled/i.test(text)) {
    return undefined
  }
  const enableUrl = (typeof error?.enable_url === "string" && CONSOLE_URL.test(error.enable_url) ? error.enable_url : CONSOLE_URL.exec(text)?.[0])?.replace(/[.,;]+$/, "")
  const project = (enableUrl ? /[?&]project=([\w.:-]+)/.exec(enableUrl)?.[1] : undefined) ?? /\bin project ([\w.:-]+)/.exec(text)?.[1]
  return { ...(enableUrl ? { enableUrl } : {}), ...(project ? { project } : {}) }
}

/**
 * Classify a failed gws process. Timeouts and output caps come first, then
 * an admin privilege refusal, then sign-in problems named by Google's error payload (which gws reports as
 * exit 1 or 2), a disabled API, and then gws's own exit code: 2 auth,
 * 3 validation, 4 Discovery, 5 internal. Anything else is Google's error.
 */
export function processError(result: ProcessResult, parsed: ParsedResult, remediation: AuthRemediation = GENERIC_REMEDIATION): GwsError {
  if (result.timedOut) return new GwsError("TIMEOUT", `gws did not finish within the configured execution.timeoutMs (${result.durationMs}ms elapsed)`)
  if (result.outputCapped) return new GwsError("OUTPUT_LIMIT", "gws output exceeded execution.maxStdoutBytes/maxStderrBytes; narrow fields or pagination")
  const stderr = stderrText(result)
  const payload = apiErrorOf(result, parsed)
  const message = payload?.message || stderr || "gws command failed"
  if (privilegeRefused(result, parsed)) {
    return new GwsError(
      "ADMIN_PRIVILEGE_REQUIRED",
      `Google accepted the sign-in but refused the call, because the account lacks a Workspace admin privilege; signing in again as the same account cannot help (gws: ${message.slice(0, 300)})`,
      { next: `${remediation.privilege.charAt(0).toUpperCase()}${remediation.privilege.slice(1)}.` },
    )
  }
  const problem = authProblem(result, parsed) ?? (result.exitCode === EXIT.auth ? "AUTH_REQUIRED" : undefined)
  if (problem === "AUTH_SCOPE_MISSING") {
    return new GwsError("AUTH_SCOPE_MISSING", `the credential lacks a scope for this operation; ${remediation.consent} (gws: ${message.slice(0, 300)})`)
  }
  if (problem === "AUTH_REQUIRED") {
    return new GwsError("AUTH_REQUIRED", `the Google Workspace sign-in is missing or no longer valid; ${remediation.signIn} (gws: ${message.slice(0, 300)})`)
  }
  const disabled = disabledApi(result, parsed)
  if (disabled) {
    const where = disabled.project ? ` for project ${disabled.project}` : ""
    const next = disabled.enableUrl
      ? `Ask the user to open ${disabled.enableUrl} and enable the API${where}, then wait about a minute and retry.`
      : `Ask the user to enable the API${where} in the Google Cloud console, then wait about a minute and retry.`
    return new GwsError("API_DISABLED", message.slice(0, 500), { next, ...(disabled.enableUrl ? { enableUrl: disabled.enableUrl } : {}) })
  }
  if (result.exitCode === EXIT.validation) return new GwsError("GWS_VALIDATION_ERROR", `gws rejected the request: ${message.slice(0, 500)}`)
  if (result.exitCode === EXIT.discovery) return new GwsError("GWS_DISCOVERY_ERROR", `gws could not load the API description: ${message.slice(0, 500)}`)
  if (result.exitCode === EXIT.internal) return new GwsError("GWS_INTERNAL_ERROR", `gws failed: ${message.slice(0, 500)}`)
  return new GwsError("GWS_API_ERROR", message.slice(0, 500))
}

/** The message of `processError`. */
export function errorFromProcess(result: ProcessResult, parsed: ParsedResult, remediation: AuthRemediation = GENERIC_REMEDIATION): string {
  return processError(result, parsed, remediation).message
}
