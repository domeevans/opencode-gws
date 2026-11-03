import { commandIndex } from "./manifest.js"
import type { AccessLevel } from "./types.js"

/**
 * OAuth scopes: the one table of what each access level requests per
 * service, and the form lists these exact scopes before consent.
 *
 * Read-only requests only scopes that cannot change, send, share, or
 * delete, and every read with a read-only scope runs on it. Read and write requests everything the service's methods can use
 * with a user's sign-in, mail settings, permanent delete and Classroom
 * rosters included, so a granted write sign-in never blocks a method on a
 * scope. Safety rests on plan, ask, and commit, not on the grant.
 *
 * `test/scopes.test.ts` checks the table against the manifest: every read
 * method is covered by its service's read set (except WRITE_ACCESS_READS)
 * and every method that can run by its write set, except the methods only
 * an app's own credentials can run (USER_UNUSABLE_METHODS).
 */

export const SCOPE_PREFIX = "https://www.googleapis.com/auth/"

/** Requested by every sign-in, so the signed-in identity is known. */
export const IDENTITY_SCOPES: readonly string[] = ["openid", `${SCOPE_PREFIX}userinfo.email`, `${SCOPE_PREFIX}userinfo.profile`]

interface ServiceScopes {
  /** Read-only access: no scope here can change, send, share, or delete. */
  readonly read: readonly string[]
  /** Read and write access: covers the service's reads too. */
  readonly write: readonly string[]
}

const DIRECT: Readonly<Record<string, { read: string[]; write: string[] }>> = {
  // Write adds mail settings, forwarding and delegation, and permanent delete (only the full-mailbox scope allows it).
  gmail: { read: ["gmail.readonly"], write: ["gmail.modify", "gmail.settings.basic", "gmail.settings.sharing", "https://mail.google.com/"] },
  drive: { read: ["drive.readonly", "drive.apps.readonly"], write: ["drive", "drive.apps.readonly"] },
  calendar: { read: ["calendar.readonly", "calendar.acls.readonly"], write: ["calendar"] },
  docs: { read: ["documents.readonly"], write: ["documents"] },
  sheets: { read: ["spreadsheets.readonly"], write: ["spreadsheets"] },
  slides: { read: ["presentations.readonly"], write: ["presentations"] },
  tasks: { read: ["tasks.readonly"], write: ["tasks"] },
  // Other contacts and the organisation directory are read-only scopes, so read and write both request them.
  people: { read: ["contacts.readonly", "contacts.other.readonly", "directory.readonly"], write: ["contacts", "contacts.other.readonly", "directory.readonly"] },
  chat: {
    read: [
      "chat.spaces.readonly",
      "chat.messages.readonly",
      "chat.memberships.readonly",
      "chat.customemojis.readonly",
      "chat.users.availability.readonly",
      "chat.users.readstate.readonly",
      "chat.users.sections.readonly",
    ],
    write: [
      "chat.spaces",
      "chat.messages",
      "chat.memberships",
      "chat.delete",
      "chat.customemojis",
      "chat.users.availability",
      "chat.users.readstate",
      "chat.users.sections",
      "chat.users.spacesettings",
    ],
  },
  classroom: {
    read: [
      "classroom.courses.readonly",
      "classroom.coursework.me.readonly",
      "classroom.announcements.readonly",
      "classroom.courseworkmaterials.readonly",
      "classroom.guardianlinks.students.readonly",
      "classroom.rosters.readonly",
      "classroom.topics.readonly",
    ],
    write: [
      "classroom.courses",
      "classroom.coursework.me",
      "classroom.announcements",
      "classroom.coursework.students",
      "classroom.courseworkmaterials",
      "classroom.guardianlinks.students",
      "classroom.rosters",
      "classroom.topics",
    ],
  },
  // Form responses have no write scope; write keeps reading them.
  forms: { read: ["forms.body.readonly", "forms.responses.readonly"], write: ["forms.body", "forms.responses.readonly", "drive.file"] },
  // meetings.space.created reaches only spaces this client created; write keeps reading the others.
  meet: { read: ["meetings.space.readonly"], write: ["meetings.space.created", "meetings.space.readonly"] },
  keep: { read: ["keep.readonly"], write: ["keep"] },
  // Reports are read-only at both levels.
  "admin-reports": {
    read: ["admin.reports.audit.readonly", "admin.reports.usage.readonly"],
    write: ["admin.reports.audit.readonly", "admin.reports.usage.readonly"],
  },
  // script.processes and script.metrics only view; deployments are never requested.
  script: { read: ["script.projects.readonly", "script.processes", "script.metrics"], write: ["script.projects", "script.processes", "script.metrics"] },
  // Model Armor has no read-only scope; write requests cloud-platform.
  modelarmor: { read: [], write: ["cloud-platform"] },
}

/** Services whose operations call other services get the union of those services' sets. */
const COMPOSITE: Readonly<Record<string, readonly string[]>> = {
  events: ["chat", "drive", "meet"],
  workflow: ["gmail", "calendar", "tasks", "drive"],
}

function unique(values: Iterable<string>): string[] {
  return [...new Set(values)]
}

function expand(names: readonly string[]): string[] {
  return names.map((name) => (name.startsWith("https://") ? name : `${SCOPE_PREFIX}${name}`))
}

export const ACCESS_SCOPES: Readonly<Record<string, ServiceScopes>> = Object.fromEntries([
  ...Object.entries(DIRECT).map(([service, sets]) => [service, { read: expand(sets.read), write: expand(sets.write) }] as const),
  ...Object.entries(COMPOSITE).map(([service, parts]) => [
    service,
    {
      read: unique(parts.flatMap((part) => expand(DIRECT[part]!.read))),
      write: unique(parts.flatMap((part) => expand(DIRECT[part]!.write))),
    },
  ] as const),
])

/** Read methods only the write level covers, because no read-only scope can run them: they need a Read and write sign-in. */
export const WRITE_ACCESS_READS: ReadonlySet<string> = new Set([
  "chat.users.spaces.spaceNotificationSetting.get",
  "drive.files.generateIds",
  "sheets.spreadsheets.developerMetadata.get",
  "sheets.spreadsheets.developerMetadata.search",
  "sheets.spreadsheets.getByDataFilter",
  "sheets.spreadsheets.values.batchGetByDataFilter",
])

/** A service's scope sets; a service outside the table requests nothing. */
export function serviceScopes(service: string): ServiceScopes {
  return ACCESS_SCOPES[service] ?? { read: [], write: [] }
}

/** Short scope names become scope URLs: `gmail.readonly` → `https://www.googleapis.com/auth/gmail.readonly`. */
export function scopeUrl(value: string): string {
  const scope = value.trim()
  if (scope === "openid" || /^https:\/\/\S+$/i.test(scope)) return scope
  if (/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(scope)) return `${SCOPE_PREFIX}${scope}`
  throw new Error(`'${value}' is not an OAuth scope; use a scope URL or a short name such as gmail.readonly`)
}

/** Scope URLs without the common prefix, for display: `gmail.readonly`. */
export function shortScope(scope: string): string {
  return scope.startsWith(SCOPE_PREFIX) ? scope.slice(SCOPE_PREFIX.length) : scope
}

/** One service's access under an account's `access` setting; services a map omits are read. */
export function accessFor(access: AccessLevel | Readonly<Record<string, AccessLevel>>, service: string): AccessLevel {
  return typeof access === "string" ? access : (access[service] ?? "read")
}

/** Google accepts at most this many scopes in one authorization request. */
export const MAX_SCOPES = 64

/**
 * The scopes one sign-in requests: each service's set for its access, the
 * account's extra scopes, and the identity scopes, without duplicates.
 */
export function requestedScopes(
  services: readonly string[],
  access: AccessLevel | Readonly<Record<string, AccessLevel>>,
  extra: readonly string[] = [],
): string[] {
  const scopes = unique([...services.flatMap((service) => serviceScopes(service)[accessFor(access, service)]), ...extra, ...IDENTITY_SCOPES])
  if (scopes.length > MAX_SCOPES) throw new Error(`a sign-in can request at most ${MAX_SCOPES} scopes; this one needs ${scopes.length}`)
  return scopes
}

/** The scopes a token response granted: Google's space-separated `scope` field. */
export function grantedScopes(value: unknown): string[] | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined
  return unique(value.trim().split(/\s+/))
}

/**
 * The scopes that let an operation run, any one of which is enough: a
 * method's manifest scopes, or for a helper its service's set for the
 * helper's category. Empty when nothing is known, so nothing is checked.
 */
export function acceptedScopes(operation: string): readonly string[] {
  const index = commandIndex()
  const method = index.methods.get(operation)
  if (method) return method.scopes
  const helper = index.helpers.get(operation)
  if (!helper) return []
  const sets = serviceScopes(helper.service)
  return helper.category === "read" ? unique([...sets.read, ...sets.write]) : sets.write
}

/** True when the grant includes one of the accepted scopes (or nothing is required). */
export function grants(accepted: readonly string[], granted: readonly string[]): boolean {
  return accepted.length === 0 || accepted.some((scope) => granted.includes(scope))
}
