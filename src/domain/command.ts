import { isAbsolute } from "node:path"
import type { BuiltCommand, MethodEntry, PluginConfig, Request } from "./types.js"
import { canonicalJson } from "./digest.js"
import { GwsError } from "./errors.js"
import { inputFiles, outputRel, type FileSpecs } from "./files.js"
import { recipientLabels, scanRecipients } from "./recipients.js"

/**
 * Argv builder for Discovery methods. The model never supplies argv: every
 * element is derived from a manifest entry and a validated request.
 */

/** True when the request asks gws to follow `nextPageToken` (NDJSON, one line per page). */
export function wantsPages(request: Request): boolean {
  const pagination = request.pagination ?? {}
  return pagination.all === true || pagination.maxPages !== undefined || pagination.maxItems !== undefined
}

/** Effective pagination limits: execution limits tightened by matching policy rules. */
interface PageLimits {
  maxPages: number
  maxItems: number
}

/** The item cap for a paginated read: the request's maxItems, never above the policy limit. */
export function itemCap(request: Request, limits: PageLimits): number {
  const requested = request.pagination?.maxItems
  return requested === undefined ? limits.maxItems : Math.min(requested, limits.maxItems)
}

/** A page-size parameter the request already sets, used to stop fetching once maxItems is covered. */
function pageSize(params: Record<string, unknown>): number | undefined {
  for (const key of ["maxResults", "pageSize"]) {
    const value = Number(params[key])
    if (Number.isInteger(value) && value > 0) return value
  }
  return undefined
}

/** Services whose list responses hold their entries in `items`, not in a field named after the resource. */
const ITEMS_LISTS = new Set(["calendar", "tasks", "admin-reports"])

/** The pause between pages when a read sets no pagination.delayMs. */
const PAGE_DELAY_MS = 100

/** An example mask for a list or search, from the service's own resource name: the entries' field, then the page token. */
export function maskExample(entry: Pick<MethodEntry, "id" | "service">): string {
  const resource = entry.id.split(".").at(-2)
  return `${resource && !ITEMS_LISTS.has(entry.service) ? resource : "items"}(id),nextPageToken`
}

export function buildCommand(
  entry: MethodEntry,
  request: Request,
  config: PluginConfig,
  options: { dryRun: boolean; category?: BuiltCommand["category"]; limits?: PageLimits },
): BuiltCommand {
  const params: Record<string, unknown> = { ...(request.params ?? {}) }
  if (request.fields !== undefined && params["fields"] === undefined) params["fields"] = request.fields

  if ((entry.method === "list" || entry.method === "search") && typeof params["fields"] !== "string") {
    throw new GwsError(
      "GWS_VALIDATION_ERROR",
      `field mask required for ${entry.id}; pass fields or params.fields (e.g. "${maskExample(entry)}")`,
      { next: "Retry with fields naming only what the user needs; gws_schema shows the response fields." },
    )
  }
  if (request.upload && entry.httpMethod === "GET") {
    throw new GwsError("GWS_VALIDATION_ERROR", `${entry.id} is a read and cannot upload media`)
  }
  if (request.download && options.category === "read") {
    throw new GwsError("GWS_VALIDATION_ERROR", "persistent downloads commit through gws_export, not gws_read", {
      next: "Plan the download with gws_plan, then commit it with gws_export.",
    })
  }
  for (const path of [request.upload?.path, request.download?.path]) {
    if (path !== undefined && !isAbsolute(path)) throw new GwsError("GWS_VALIDATION_ERROR", `'${path}' must be an absolute path`)
  }

  // gws only accepts file paths inside its cwd: argv names the staged copy.
  const files: FileSpecs = { inputs: inputFiles(request.upload ? [request.upload.path] : []) }
  if (request.download) {
    files.output = { destination: request.download.path, rel: outputRel(request.download.path), overwrite: request.download.overwrite === true }
  }

  const argv = [entry.service, ...entry.path, entry.method]
  if (Object.keys(params).length > 0) argv.push("--params", canonicalJson(params))
  if (request.body !== undefined) argv.push("--json", canonicalJson(request.body))
  if (request.upload) {
    argv.push("--upload", files.inputs[0]!.rel)
    if (request.upload.mime) argv.push("--upload-content-type", request.upload.mime)
  }
  if (files.output) {
    argv.push("--output", files.output.rel)
  }

  const pagination = request.pagination ?? {}
  if (wantsPages(request)) {
    const limits = options.limits ?? { maxPages: config.execution.maxPages, maxItems: config.execution.maxItems }
    let pages = Math.min(pagination.maxPages ?? limits.maxPages, limits.maxPages)
    const size = pageSize(params)
    if (pagination.maxItems !== undefined && size !== undefined) pages = Math.min(pages, Math.ceil(itemCap(request, limits) / size))
    const delay = Math.max(pagination.delayMs ?? PAGE_DELAY_MS, 0)
    argv.push("--page-all", "--page-limit", String(pages), "--page-delay", String(delay))
  }
  argv.push("--format", "json")
  if (options.dryRun) argv.push("--dry-run")

  const category = (options.category ?? entry.category) as BuiltCommand["category"]
  return {
    argv,
    category,
    service: entry.service,
    operation: entry.id,
    files,
    preview: {
      method: entry.httpMethod,
      url: entry.pathTemplate,
      params: redactParams(params),
      bodySummary: request.body === undefined ? undefined : summarizeBody(request.body),
      recipients: recipientLabels(scanRecipients(request)),
      uploads: request.upload ? [request.upload.path] : undefined,
      destination: request.download?.path,
      overwrite: request.download?.overwrite === true ? true : undefined,
      account: request.account,
      category,
    },
  }
}

function redactParams(params: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(params)) {
    if (/token|secret|password|authorization|raw/i.test(key)) out[key] = "[redacted]"
    else out[key] = value
  }
  return out
}

function summarizeBody(body: unknown): string {
  if (body === null || typeof body !== "object") return `[${typeof body}]`
  const keys = Object.keys(body as Record<string, unknown>)
  const bytes = Buffer.byteLength(canonicalJson(body))
  return `object(${keys.join(", ")}) ${bytes} bytes`
}
