/**
 * Every error the plugin raises, in one table: what the code means and
 * what to do next. A message reads `CODE: What happened. Next step: What
 * to do.` The tool adapter turns it into a Tool.Error with metadata
 * `{ code, next, enableUrl? }`, the audit keeps only the code, and the
 * error docs are generated from this table.
 *
 * This module imports nothing, so scripts can load it directly.
 */

interface ErrorEntry {
  /** What the code means, for people reading the docs. */
  meaning: string
  /** The default next step; a raise site may give a more specific one. */
  next: string
}

export const ErrorCode = {
  // ── Requests ──────────────────────────────────────────────────────────
  ACCOUNT_REQUIRED: {
    meaning: "More than one account is configured and the call named none.",
    next: "Pass account with one of the configured aliases; gws_status lists them.",
  },
  ACCOUNT_UNKNOWN: {
    meaning: "The account alias is not configured.",
    next: "Pass a configured alias; gws_status lists them.",
  },
  OPERATION_UNKNOWN: {
    meaning: "The operation id is not in the gws manifest.",
    next: "Find the exact method or helper id with gws_catalog, then retry.",
  },
  HELPER_UNSUPPORTED: {
    meaning: "The helper is in the catalog but cannot run.",
    next: "Use the Discovery method gws_catalog names as the helper's alternative.",
  },
  GWS_VALIDATION_ERROR: {
    meaning:
      "The request is malformed: a schema violation, a field helpers do not take, a missing field mask on list or search, a relative path, a download on gws_read, or arguments gws rejected.",
    next: "Fix the request as the message says; gws_schema shows the parameters and request body.",
  },
  POLICY_DENIED: {
    meaning:
      "Plugin policy refused the call: the category, the service, recipients, public sharing, the admin gate, or a path outside the allowed roots. A deny is final.",
    next: "Do not work around it. If the message says to use gws_plan, plan the change; otherwise tell the user, who can change the plugin policy.",
  },

  // ── Plans ─────────────────────────────────────────────────────────────
  PLAN_NOT_FOUND: {
    meaning: "No plan has this planId, or it was removed.",
    next: "Create a plan with gws_plan, then commit its planId.",
  },
  PLAN_ALREADY_USED: {
    meaning: "The plan was committed, or is being committed. Plans are single-use.",
    next: "Check the result of the earlier commit with gws_read before planning the change again.",
  },
  PLAN_EXPIRED: {
    meaning: "The plan's time limit passed, or a failed commit expired it.",
    next: "Check the current state with gws_read, then plan again and show the new preview.",
  },
  PLAN_CALLER_MISMATCH: {
    meaning: "Another session, agent, or account created the plan.",
    next: "Plan again from the session and agent that will commit it.",
  },
  CATEGORY_MISMATCH: {
    meaning: "The commit tool does not match the plan's category.",
    next: "Commit with the tool named by the plan's category.",
  },

  // ── Scripts (the tools RPC) ───────────────────────────────────────────
  SESSION_UNKNOWN: {
    meaning: "A script named a session that does not exist. A script runs as a session, under that session's agent and its permission rules.",
    next: "Pass the id of an existing session, or create one for the agent the script should run as.",
  },
  SESSION_AGENT_REQUIRED: {
    meaning: "A script named a session that names no agent. A script runs as its session's agent, so its permissions and plans never depend on the default agent.",
    next: 'Create the script\'s session with an agent, for example POST /api/session with {"agent":"build"}.',
  },
  PERMISSION_DENIED: {
    meaning:
      "The permission rules of the session's agent deny the call, or ask for an approval that a script cannot give, so the call did not run.",
    next: "Run the script as a session whose agent allows the action, or add an allow rule for that action to the agent.",
  },

  // ── Sign-in ───────────────────────────────────────────────────────────
  AUTH_REQUIRED: {
    meaning:
      "The account is not signed in, its sign-in expired or was revoked, or a headless credential variable is unset. A call that fails this way before gws runs changes nothing.",
    next: "Ask the user to sign in as the message says, then retry.",
  },
  AUTH_SCOPE_MISSING: {
    meaning: "The sign-in has not granted a scope this operation needs. The plugin checks before gws runs, so nothing ran.",
    next: "Ask the user to sign in again with the access the message names, or to add the scope to the account's scopes, then retry.",
  },
  AUTH_CLIENT_REQUIRED: {
    meaning: "No OAuth client is configured for the sign-in, none was entered in the form, and no earlier sign-in has one.",
    next: "Run /connect and choose Google Workspace, then enter your Desktop OAuth client ID and secret, or ask your administrator.",
  },
  AUTH_CLIENT_INVALID: {
    meaning: "The sign-in form has only one of the client ID and secret, or a value in the wrong format.",
    next: "Enter both the client ID and the secret of the same Desktop app OAuth client; /gws-status lists the steps.",
  },
  AUTH_WRITE_UNCONFIRMED: {
    meaning: "Read and write access was chosen in the sign-in form without confirming the write scopes.",
    next: "Sign in again and confirm the write scopes, or choose Read-only.",
  },

  // ── Google and gws ────────────────────────────────────────────────────
  API_DISABLED: {
    meaning: "The Google API is not enabled in the Google Cloud project of the OAuth client.",
    next: "Ask the user to enable the API in the Google Cloud console, wait about a minute, and retry.",
  },
  GWS_API_ERROR: {
    meaning: "Google returned an error; the message carries Google's text.",
    next: "Fix the ids or parameters once from the message; if it fails again, report it.",
  },
  GWS_DISCOVERY_ERROR: {
    meaning: "gws could not load the API description (the Discovery document) it builds requests from.",
    next: "Check that this machine can reach www.googleapis.com, then retry.",
  },
  GWS_INTERNAL_ERROR: {
    meaning: "gws failed unexpectedly.",
    next: "Retry once; if it fails again, report the message.",
  },
  TIMEOUT: {
    meaning: "gws did not finish within execution.timeoutMs.",
    next: "Narrow the request with fields, a smaller page size, maxPages, or maxItems, then retry.",
  },
  OUTPUT_LIMIT: {
    meaning: "gws output exceeded execution.maxStdoutBytes or execution.maxStderrBytes.",
    next: "Narrow the request with fields, a smaller page size, maxPages, or maxItems, then retry.",
  },
  CANCELLED: {
    meaning: "The call was cancelled and the gws process stopped. A commit stopped while gws ran may or may not have been applied.",
    next: "Do not retry unless the user asks; check the state with gws_read before planning again.",
  },
  SCHEMA_INVALID: {
    meaning: "gws schema returned no usable JSON.",
    next: "Retry once; if it fails again, report the message.",
  },
  SCHEMA_NOT_FOUND: {
    meaning: "gws schema does not know this method.",
    next: "Check the operation id with gws_catalog.",
  },

  // ── Local files ───────────────────────────────────────────────────────
  UPLOAD_INVALID: {
    meaning: "An upload or attachment path is not absolute, does not exist, or is not a regular file.",
    next: "Use the absolute path of an existing regular file.",
  },
  UPLOAD_LIMIT: {
    meaning: "The upload is larger than execution.maxUploadBytes.",
    next: "Use a smaller file, or ask the user to raise execution.maxUploadBytes.",
  },
  UPLOAD_CHANGED: {
    meaning: "An upload or attachment changed between the plan and the commit, so the plan expired.",
    next: "Plan again and show the new preview.",
  },
  DOWNLOAD_EXISTS: {
    meaning: "The download destination exists and download.overwrite is not true.",
    next: "Choose another path, or plan again with download.overwrite set to true after the user agrees.",
  },
  DOWNLOAD_INVALID: {
    meaning: "The destination is not absolute, its directory does not exist, it is a directory, or gws wrote no file.",
    next: "Fix the destination path; if gws wrote no file, report it.",
  },
  DOWNLOAD_LIMIT: {
    meaning: "The download is larger than execution.maxDownloadBytes; nothing was written to the destination.",
    next: "Tell the user; they can raise execution.maxDownloadBytes. The plan is used up.",
  },

  // ── Setup: these stop the plugin from loading ────────────────────────
  HOST_UNTESTED: {
    meaning: "The OpenCode version is outside the tested range in package.json opencode.host.",
    next: "Use a tested OpenCode release, or set allowUntestedHost to true to run anyway with a status warning.",
  },
  OPTIONS_INVALID: {
    meaning: "The plugin options are not valid: an unknown key, a wrong type, an unknown service, or access or scopes that name something the account does not enable.",
    next: "Fix the plugin options in opencode.json; the message names the option.",
  },
  STATUS_UNAVAILABLE: {
    meaning: "The status could not be read from the plugin.",
    next: "Run /gws-status in a session for the details.",
  },
  SKILLS_INVALID: {
    meaning: "A skill file that ships with the plugin is missing or unreadable.",
    next: "Reinstall the plugin.",
  },
  GWS_UNAVAILABLE: {
    meaning: "No gws binary is available: this platform has no gws package, the package is not installed, or binary.path does not exist.",
    next: "Reinstall the plugin so npm installs the gws package for this platform, or set binary.path to a gws 0.22.5 executable.",
  },
  GWS_NOT_FOUND: {
    meaning: "The packaged gws binary is missing.",
    next: "Reinstall the plugin.",
  },
  GWS_UNSUPPORTED_PLATFORM: {
    meaning: "The packaged gws binary does not support this platform.",
    next: "Set binary.path to a gws 0.22.5 executable for this platform.",
  },
  GWS_VERSION_MISMATCH: {
    meaning: "The gws version check failed, or gws is not the version the manifest was generated from.",
    next: "Reinstall the plugin, or point binary.path at gws 0.22.5.",
  },
  BINARY_TRUST_FAILED: {
    meaning:
      "The gws binary failed a trust check: a relative path, not a regular file, group- or world-writable, inside the project, a writable ancestor, or a checksum mismatch.",
    next: "Reinstall the plugin, or move the binary.path executable to a location only you can write.",
  },
} as const satisfies Record<string, ErrorEntry>

export type ErrorCode = keyof typeof ErrorCode

export function isErrorCode(value: string): value is ErrorCode {
  return Object.hasOwn(ErrorCode, value)
}

interface ErrorOptions {
  /** A next step more specific than the table's. */
  next?: string
  /** For API_DISABLED: where to enable the API. */
  enableUrl?: string
}

/**
 * A plugin error: a code from the table, what happened, and the next step.
 * The name stays `Error`, so the text form is `Error: CODE: …`.
 */
export class GwsError extends Error {
  readonly code: ErrorCode
  readonly next: string
  readonly enableUrl?: string

  constructor(code: ErrorCode, detail: string, options: ErrorOptions = {}) {
    const next = options.next ?? ErrorCode[code].next
    super(`${code}: ${sentence(detail)} Next step: ${sentence(next)}`)
    this.code = code
    this.next = next
    if (options.enableUrl) this.enableUrl = options.enableUrl
  }

  /**
   * The GwsError form of a thrown value: itself, or an Error whose message
   * starts with a code from the table. Its message keeps its own next step,
   * or gains the table's, and always ends with a full stop. Anything else
   * is not a plugin error.
   */
  static from(error: unknown): GwsError | undefined {
    if (error instanceof GwsError) return error
    if (!(error instanceof Error) || "_tag" in error) return undefined
    const match = /^([A-Z][A-Z_]+): ([\s\S]*)$/.exec(error.message)
    if (!match || !isErrorCode(match[1]!)) return undefined
    const code = match[1]
    const stated = /^([\s\S]*?)\sNext step: ([\s\S]+)$/.exec(match[2]!)
    return stated ? new GwsError(code, stated[1]!, { next: stated[2]! }) : new GwsError(code, match[2]!)
  }
}

/** Starts `text` with a capital and ends it with a full stop unless it already ends a sentence. */
export function sentence(text: string): string {
  const trimmed = text.trim()
  const capital = trimmed.charAt(0).toUpperCase() + trimmed.slice(1)
  return /[.!?]$/.test(capital) ? capital : `${capital}.`
}

export function cancelledError(): GwsError {
  return new GwsError("CANCELLED", "the call was cancelled; the gws process was stopped")
}

export function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw cancelledError()
}
