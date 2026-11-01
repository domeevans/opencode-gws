import { commandIndex } from "./manifest.js"
import type { AccessLevel } from "./types.js"

/**
 * Least-privilege OAuth scopes: the one table of what each access level
 * requests per service. A sign-in is read-only unless the user chooses
 * write, and the form lists these exact scopes before consent.
 *
 * `test/scopes.test.ts` checks the table against the manifest: every read
 * method is covered by its service's read set and every change by its write
 * set, except the methods listed below, which stay outside both levels on
 * purpose (sensitive or narrow scopes such as mail settings, delegation,
 * permanent delete, Classroom rosters and add-ons, or the directory).
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
  gmail: { read: ["gmail.readonly"], write: ["gmail.modify"] },
  drive: { read: ["drive.readonly"], write: ["drive"] },
  calendar: { read: ["calendar.readonly"], write: ["calendar"] },
  docs: { read: ["documents.readonly"], write: ["documents"] },
  sheets: { read: ["spreadsheets.readonly"], write: ["spreadsheets"] },
  slides: { read: ["presentations.readonly"], write: ["presentations"] },
  tasks: { read: ["tasks.readonly"], write: ["tasks"] },
  people: { read: ["contacts.readonly"], write: ["contacts"] },
  chat: {
    read: ["chat.spaces.readonly", "chat.messages.readonly", "chat.memberships.readonly"],
    write: ["chat.spaces", "chat.messages", "chat.memberships"],
  },
  classroom: {
    read: ["classroom.courses.readonly", "classroom.coursework.me.readonly", "classroom.announcements.readonly"],
    write: ["classroom.courses", "classroom.coursework.me", "classroom.announcements"],
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
  // Model Armor needs cloud-platform, which no access level requests: add it to the account's `scopes`.
  modelarmor: { read: [], write: [] },
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
  return names.map((name) => `${SCOPE_PREFIX}${name}`)
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

/** Read methods only the write level covers: they need a Read and write sign-in. */
export const WRITE_ACCESS_READS: ReadonlySet<string> = new Set([
  "calendar.acl.list",
  "drive.files.generateIds",
  "sheets.spreadsheets.developerMetadata.get",
  "sheets.spreadsheets.developerMetadata.search",
  "sheets.spreadsheets.getByDataFilter",
  "sheets.spreadsheets.values.batchGetByDataFilter",
])

/**
 * Methods neither access level covers. Each needs one of its manifest scopes
 * in the account's `scopes`, which every sign-in then requests and shows.
 */
export const EXTRA_SCOPE_METHODS: ReadonlySet<string> = new Set([
  // chat
  "chat.customEmojis.create", "chat.customEmojis.delete", "chat.customEmojis.get", "chat.customEmojis.list", "chat.spaces.completeImport",
  "chat.spaces.delete", "chat.spaces.messages.attachments.get", "chat.spaces.messages.replaceCards", "chat.users.availability.get",
  "chat.users.availability.markAsActive", "chat.users.availability.markAsAway", "chat.users.availability.markAsDoNotDisturb",
  "chat.users.availability.patch", "chat.users.sections.create", "chat.users.sections.delete", "chat.users.sections.items.list",
  "chat.users.sections.items.move", "chat.users.sections.list", "chat.users.sections.patch", "chat.users.sections.position",
  "chat.users.spaces.getSpaceReadState", "chat.users.spaces.spaceNotificationSetting.get",
  "chat.users.spaces.spaceNotificationSetting.patch", "chat.users.spaces.threads.getThreadReadState",
  "chat.users.spaces.updateSpaceReadState",
  // classroom
  "classroom.courses.announcements.addOnAttachments.create", "classroom.courses.announcements.addOnAttachments.delete",
  "classroom.courses.announcements.addOnAttachments.get", "classroom.courses.announcements.addOnAttachments.list",
  "classroom.courses.announcements.addOnAttachments.patch", "classroom.courses.announcements.getAddOnContext",
  "classroom.courses.courseWork.addOnAttachments.create", "classroom.courses.courseWork.addOnAttachments.delete",
  "classroom.courses.courseWork.addOnAttachments.get", "classroom.courses.courseWork.addOnAttachments.list",
  "classroom.courses.courseWork.addOnAttachments.patch", "classroom.courses.courseWork.addOnAttachments.studentSubmissions.patch",
  "classroom.courses.courseWork.create", "classroom.courses.courseWork.delete", "classroom.courses.courseWork.getAddOnContext",
  "classroom.courses.courseWork.modifyAssignees", "classroom.courses.courseWork.patch", "classroom.courses.courseWork.rubrics.create",
  "classroom.courses.courseWork.rubrics.delete", "classroom.courses.courseWork.rubrics.patch",
  "classroom.courses.courseWork.studentSubmissions.return", "classroom.courses.courseWork.updateRubric",
  "classroom.courses.courseWorkMaterials.addOnAttachments.create", "classroom.courses.courseWorkMaterials.addOnAttachments.delete",
  "classroom.courses.courseWorkMaterials.addOnAttachments.get", "classroom.courses.courseWorkMaterials.addOnAttachments.list",
  "classroom.courses.courseWorkMaterials.addOnAttachments.patch", "classroom.courses.courseWorkMaterials.create",
  "classroom.courses.courseWorkMaterials.delete", "classroom.courses.courseWorkMaterials.get",
  "classroom.courses.courseWorkMaterials.getAddOnContext", "classroom.courses.courseWorkMaterials.list",
  "classroom.courses.courseWorkMaterials.patch", "classroom.courses.posts.addOnAttachments.create",
  "classroom.courses.posts.addOnAttachments.delete", "classroom.courses.posts.addOnAttachments.get",
  "classroom.courses.posts.addOnAttachments.list", "classroom.courses.posts.addOnAttachments.patch",
  "classroom.courses.posts.addOnAttachments.studentSubmissions.patch", "classroom.courses.posts.getAddOnContext",
  "classroom.courses.studentGroups.create", "classroom.courses.studentGroups.delete", "classroom.courses.studentGroups.list",
  "classroom.courses.studentGroups.patch", "classroom.courses.studentGroups.studentGroupMembers.create",
  "classroom.courses.studentGroups.studentGroupMembers.delete", "classroom.courses.studentGroups.studentGroupMembers.list",
  "classroom.courses.students.create", "classroom.courses.students.delete", "classroom.courses.students.get",
  "classroom.courses.students.list", "classroom.courses.teachers.create", "classroom.courses.teachers.delete",
  "classroom.courses.teachers.get", "classroom.courses.teachers.list", "classroom.courses.topics.create",
  "classroom.courses.topics.delete", "classroom.courses.topics.get", "classroom.courses.topics.list", "classroom.courses.topics.patch",
  "classroom.invitations.accept", "classroom.invitations.create", "classroom.invitations.delete", "classroom.invitations.get",
  "classroom.invitations.list", "classroom.userProfiles.get", "classroom.userProfiles.guardianInvitations.create",
  "classroom.userProfiles.guardianInvitations.get", "classroom.userProfiles.guardianInvitations.list",
  "classroom.userProfiles.guardianInvitations.patch", "classroom.userProfiles.guardians.delete", "classroom.userProfiles.guardians.get",
  "classroom.userProfiles.guardians.list",
  // drive
  "drive.apps.list",
  // gmail: permanent delete, settings, forwarding, and delegation
  "gmail.users.messages.batchDelete", "gmail.users.messages.delete", "gmail.users.settings.cse.identities.create",
  "gmail.users.settings.cse.identities.delete", "gmail.users.settings.cse.identities.patch", "gmail.users.settings.cse.keypairs.create",
  "gmail.users.settings.cse.keypairs.disable", "gmail.users.settings.cse.keypairs.enable", "gmail.users.settings.cse.keypairs.obliterate",
  "gmail.users.settings.delegates.create", "gmail.users.settings.delegates.delete", "gmail.users.settings.filters.create",
  "gmail.users.settings.filters.delete", "gmail.users.settings.forwardingAddresses.create",
  "gmail.users.settings.forwardingAddresses.delete", "gmail.users.settings.sendAs.create", "gmail.users.settings.sendAs.delete",
  "gmail.users.settings.sendAs.patch", "gmail.users.settings.sendAs.smimeInfo.delete", "gmail.users.settings.sendAs.smimeInfo.insert",
  "gmail.users.settings.sendAs.smimeInfo.setDefault", "gmail.users.settings.sendAs.update", "gmail.users.settings.sendAs.verify",
  "gmail.users.settings.updateAutoForwarding", "gmail.users.settings.updateImap", "gmail.users.settings.updateLanguage",
  "gmail.users.settings.updatePop", "gmail.users.settings.updateVacation", "gmail.users.threads.delete",
  // people: other contacts and the organisation directory
  "people.otherContacts.list", "people.otherContacts.search", "people.people.listDirectoryPeople", "people.people.searchDirectoryPeople",
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
const MAX_SCOPES = 64

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
