/**
 * The methods no person's sign-in can run, because Google grants their
 * scopes only to an app acting as itself. A leaf module, so both the scope
 * table (scopes.ts) and the catalog (manifest.ts) can use it.
 * `test/scopes.test.ts` keeps the list equal to the manifest's methods whose
 * every scope is app-only.
 */

/**
 * Scopes Google grants only to an app acting as itself (a Chat app, a Chat
 * import, or a Classroom add-on), never to a person's sign-in. No access
 * level requests them.
 */
export const APP_ONLY_SCOPES: readonly string[] = ["chat.bot", "chat.import", "classroom.addons.student", "classroom.addons.teacher"].map(
  (name) => `https://www.googleapis.com/auth/${name}`,
)

/**
 * Methods whose every scope is app-only, so no user sign-in can run them.
 * `gws_catalog` and `gws_schema` mark them `appOnly`; the scope check
 * refuses them with a next step that says so.
 */
export const USER_UNUSABLE_METHODS = [
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

export type UserUnusableMethod = (typeof USER_UNUSABLE_METHODS)[number]

const UNUSABLE: ReadonlySet<string> = new Set(USER_UNUSABLE_METHODS)

/** True when only an app's own credentials can run the method. */
export function appOnly(operation: string): boolean {
  return UNUSABLE.has(operation)
}
