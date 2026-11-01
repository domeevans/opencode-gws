import type { BuiltCommand, Category, MethodEntry, Request } from "./types.js"

/**
 * Category refinement on top of the generated manifest.
 *
 * The manifest classifies every command from its HTTP method, resource
 * path, and a curated override table. This layer only promotes a read to
 * an export when the caller asks for a persistent destination, promotes a
 * Calendar event write that emails attendees to a send or Drive trash to
 * a delete, and refuses
 * commands that the manifest marked denied or unparseable.
 */

const NOTIFYING_UPDATES = new Set(["all", "externalonly"])

function emailsAttendees(entry: MethodEntry, request: Request): boolean {
  if (entry.service !== "calendar" || entry.path.join(".") !== "events") return false
  const value = request.params?.["sendUpdates"]
  return typeof value === "string" && NOTIFYING_UPDATES.has(value.toLowerCase())
}

export function effectiveCategory(entry: MethodEntry, request: Request): Category {
  if (entry.category === "deny" || entry.schemaError) return "deny"
  if (entry.id === "drive.files.update" && request.body && typeof request.body === "object" && "trashed" in request.body && request.body.trashed === true) return "delete"
  if (request.download?.path && entry.category === "read") return "export"
  if (request.upload && entry.category === "read") return "deny"
  if (entry.category === "write" && emailsAttendees(entry, request)) return "send"
  return entry.category
}

export function isCommittable(category: Category): category is BuiltCommand["category"] {
  return ["write", "send", "share", "delete", "export", "admin"].includes(category)
}
