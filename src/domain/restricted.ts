/**
 * The methods an ordinary Google sign-in cannot run, and why. A leaf
 * module, so the scope table (scopes.ts), the catalog (manifest.ts) and the
 * config defaults can all use it. `test/scopes.test.ts` keeps each list
 * equal to the manifest's methods whose every scope has that restriction.
 */

/**
 * Why an ordinary sign-in cannot run a method:
 * - `app-only`: Google grants its scopes only to an app acting as itself
 *   (a Chat app or a Classroom add-on).
 * - `domain-wide-delegation`: Google grants its scopes only through
 *   domain-wide delegation, which a Workspace admin sets up.
 */
export type Restriction = "app-only" | "domain-wide-delegation"

const PREFIX = "https://www.googleapis.com/auth/"

/**
 * Scopes Google grants only to an app acting as itself (a Chat app, a Chat
 * import, or a Classroom add-on), never to a person's sign-in. No access
 * level requests them.
 */
export const APP_ONLY_SCOPES: readonly string[] = ["chat.bot", "chat.import", "classroom.addons.student", "classroom.addons.teacher"].map((name) => `${PREFIX}${name}`)

/**
 * Scopes Google grants only through domain-wide delegation, never through a
 * person's own consent: asking for one makes Google refuse the whole
 * sign-in with invalid_scope. No access level requests them; an account
 * whose admin has set up delegation adds them in `accounts.<alias>.scopes`.
 */
export const DELEGATION_SCOPES: readonly string[] = ["keep", "keep.readonly"].map((name) => `${PREFIX}${name}`)

/** Methods whose every scope is app-only, so no user sign-in can run them. */
export const APP_ONLY_METHODS = [
  // chat: a Chat app's own credentials
  "chat.spaces.completeImport", "chat.spaces.messages.attachments.get", "chat.spaces.messages.replaceCards",
  // classroom: a Classroom add-on's own credentials
  "classroom.courses.announcements.addOnAttachments.create", "classroom.courses.announcements.addOnAttachments.delete",
  "classroom.courses.announcements.addOnAttachments.get", "classroom.courses.announcements.addOnAttachments.list",
  "classroom.courses.announcements.addOnAttachments.patch", "classroom.courses.announcements.getAddOnContext",
  "classroom.courses.courseWork.addOnAttachments.create", "classroom.courses.courseWork.addOnAttachments.delete",
  "classroom.courses.courseWork.addOnAttachments.get", "classroom.courses.courseWork.addOnAttachments.list",
  "classroom.courses.courseWork.addOnAttachments.patch", "classroom.courses.courseWork.addOnAttachments.studentSubmissions.patch",
  "classroom.courses.courseWork.getAddOnContext", "classroom.courses.courseWorkMaterials.addOnAttachments.create",
  "classroom.courses.courseWorkMaterials.addOnAttachments.delete", "classroom.courses.courseWorkMaterials.addOnAttachments.get",
  "classroom.courses.courseWorkMaterials.addOnAttachments.list", "classroom.courses.courseWorkMaterials.addOnAttachments.patch",
  "classroom.courses.courseWorkMaterials.getAddOnContext", "classroom.courses.posts.addOnAttachments.create",
  "classroom.courses.posts.addOnAttachments.delete", "classroom.courses.posts.addOnAttachments.get",
  "classroom.courses.posts.addOnAttachments.list", "classroom.courses.posts.addOnAttachments.patch",
  "classroom.courses.posts.addOnAttachments.studentSubmissions.patch", "classroom.courses.posts.getAddOnContext",
] as const

/** Methods whose every scope needs domain-wide delegation: every Keep method. */
export const DELEGATION_METHODS = [
  "keep.media.download", "keep.notes.create", "keep.notes.delete", "keep.notes.get", "keep.notes.list",
  "keep.notes.permissions.batchCreate", "keep.notes.permissions.batchDelete",
] as const

/**
 * Services none of whose methods an ordinary sign-in can run, because every
 * one needs domain-wide delegation. The default account leaves them out;
 * an account that enables one is told so in status and /gws-doctor unless
 * its scopes add a delegation scope.
 */
export const DELEGATION_SERVICES: readonly string[] = ["keep"]

const RESTRICTIONS: ReadonlyMap<string, Restriction> = new Map<string, Restriction>([
  ...APP_ONLY_METHODS.map((id) => [id, "app-only"] as const),
  ...DELEGATION_METHODS.map((id) => [id, "domain-wide-delegation"] as const),
])

/** Why an ordinary sign-in cannot run the method; undefined when it can. */
export function restriction(operation: string): Restriction | undefined {
  return RESTRICTIONS.get(operation)
}

/** True when only an app's own credentials can run the method. */
export function appOnly(operation: string): boolean {
  return RESTRICTIONS.get(operation) === "app-only"
}

/** True when the scopes include one Google grants only through domain-wide delegation. */
function addsDelegationScope(scopes: readonly string[]): boolean {
  return scopes.some((scope) => DELEGATION_SCOPES.includes(scope))
}

/**
 * The enabled services that need domain-wide delegation, when the account's
 * scopes add no delegation scope: none of their methods can run, and status,
 * the sign-in form and /gws-doctor say why.
 */
export function delegationRequired(services: readonly string[], scopes: readonly string[]): string[] {
  return addsDelegationScope(scopes) ? [] : services.filter((service) => DELEGATION_SERVICES.includes(service))
}

/** The catalog and schema marks for a method: `appOnly` for an app-only method, and the `restriction` for either kind. */
export function restrictionMarks(operation: string): { appOnly?: true; restriction?: Restriction } {
  const reason = restriction(operation)
  if (!reason) return {}
  return reason === "app-only" ? { appOnly: true, restriction: reason } : { restriction: reason }
}
