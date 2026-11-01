import type { ResolvedSchema } from "./contract.js"
import { GwsError } from "./errors.js"

/**
 * Method schemas as reported by `gws schema <id>`. The manifest carries the
 * coverage facts (HTTP method, scopes); a resolved schema supplies the full
 * parameter and request metadata for one operation.
 */

/** Parse `gws schema` stdout (which may carry a text preamble) into a ResolvedSchema. */
export function parseSchemaOutput(id: string, stdout: string, stderr: string): ResolvedSchema {
  const start = stdout.indexOf("{")
  if (start < 0) {
    throw new GwsError("SCHEMA_INVALID", `gws schema ${id} returned no JSON${stderr.length ? `: ${stderr.slice(0, 300)}` : ""}`)
  }
  const raw = JSON.parse(stdout.slice(start)) as {
    error?: { message?: string }
    httpMethod?: string
    path?: string
    scopes?: string[]
    parameterOrder?: string[]
    parameters?: Record<string, unknown>
    requestBody?: unknown
    response?: unknown
  }
  if (raw.error) throw new GwsError("SCHEMA_NOT_FOUND", raw.error.message ?? id)
  return {
    id,
    httpMethod: String(raw.httpMethod ?? "UNKNOWN").toUpperCase(),
    path: raw.path ?? null,
    scopes: raw.scopes ?? [],
    parameterOrder: raw.parameterOrder ?? [],
    parameters: raw.parameters ?? {},
    requestBody: raw.requestBody,
    response: raw.response,
  }
}
