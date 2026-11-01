/**
 * Onboarding for people the organisation's OAuth client does not cover:
 * the Google Cloud links /gws-status posts and /gws-doctor points to.
 */

/** The Google APIs each service calls. A composite service needs its parts' APIs. */
const SERVICE_APIS: Readonly<Record<string, readonly string[]>> = {
  gmail: ["gmail.googleapis.com"],
  drive: ["drive.googleapis.com"],
  calendar: ["calendar-json.googleapis.com"],
  docs: ["docs.googleapis.com"],
  sheets: ["sheets.googleapis.com"],
  slides: ["slides.googleapis.com"],
  tasks: ["tasks.googleapis.com"],
  people: ["people.googleapis.com"],
  chat: ["chat.googleapis.com"],
  classroom: ["classroom.googleapis.com"],
  forms: ["forms.googleapis.com"],
  meet: ["meet.googleapis.com"],
  keep: ["keep.googleapis.com"],
  "admin-reports": ["admin.googleapis.com"],
  script: ["script.googleapis.com"],
  events: ["workspaceevents.googleapis.com"],
  modelarmor: ["modelarmor.googleapis.com"],
  workflow: ["gmail.googleapis.com", "calendar-json.googleapis.com", "tasks.googleapis.com", "drive.googleapis.com"],
}

/** One link that enables every API the services call, in a project the user picks. */
export function enableApisUrl(services: readonly string[]): string {
  const apis = [...new Set(services.flatMap((service) => SERVICE_APIS[service] ?? []))]
  return `https://console.cloud.google.com/flows/enableapi?apiid=${apis.join(",")}`
}

/** Google Auth platform pages in the Cloud console, and Google's own guidance. */
export const GOOGLE_LINKS = {
  branding: "https://console.developers.google.com/auth/branding",
  audience: "https://console.developers.google.com/auth/audience",
  clients: "https://console.developers.google.com/auth/clients",
  desktopClientGuide: "https://developers.google.com/workspace/guides/create-credentials#desktop-app",
  /** External apps in Testing get refresh tokens that expire after 7 days. */
  refreshTokenExpiry: "https://developers.google.com/identity/protocols/oauth2#expiration",
} as const
