import { PACKAGE_NAME, PLUGIN_ID } from "../domain/version.js"

/**
 * The calls this plugin still answers under an old id, for one release. Jelly's Home calendar reads `calendar.today`
 * on the RPC named after the package; the source contract names one RPC per plugin, so the same read is now
 * `calendar_today` on the tools RPC (`gws.calendar.today` in `package.json` `sources`). The old method answers as
 * before until 0.1.0; once it is called, status says so in one line.
 */

let calendarToday = false

/** Records that the old `calendar.today` answered in this process. */
export const markCalendarTodayCalled = (): void => {
  calendarToday = true
}

/** Forgets the calls: a reload starts again, so the note appears once per run of the plugin. */
export const resetDeprecated = (): void => {
  calendarToday = false
}

/** The line status shows once the old method was called, or undefined. */
export function deprecatedNote(): string | undefined {
  if (!calendarToday) return undefined
  return `Deprecated method called: calendar.today on ${PACKAGE_NAME}. Use calendar_today on ${PLUGIN_ID}.tools instead; the old method works until 0.1.0.`
}
