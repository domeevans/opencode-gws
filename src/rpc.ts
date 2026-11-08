import { Rpc } from "@opencode/plugin/rpc"

/**
 * The RPC contract, in plain JSON Schema so the TUI bundle carries no
 * schema library. It is internal, not a package export: the build inlines
 * it into both dist/index.js and dist/tui.js. The types below are plain
 * TypeScript and must match the schema; `isStatus` checks a value the
 * client receives, because JSON Schema outputs reach clients unchecked.
 *
 * Authority: the server part is the only authority. This contract can read
 * status. It can never approve or commit a plan; that happens only through
 * the OpenCode permission prompt raised when the agent calls a commit tool.
 */

export const RPC_ID = "google-workspace.gws"

export interface GwsAccount {
  alias: string
  mode: "interactive" | "credentials_file" | "access_token"
  services: string[]
  /** The OpenCode integration an interactive account signs in through. */
  integrationID?: string
  /** Interactive: signed in and usable. Headless: its environment variable is set (the credential itself is checked only by /gws-doctor). */
  connected: boolean
  /** The host reports that the connection needs sign-in again. */
  needsAuth?: true
  /** The signed-in access level; before sign-in, the sign-in form's default. */
  access?: "read" | "write"
  /** Where the sign-in's OAuth client comes from. */
  clientSource?: "account" | "plugin" | "pasted"
  /** Scopes Google granted to the current sign-in. */
  grantedScopes?: string[]
  /** Scopes the enabled services need at this access level that were not granted. */
  missingScopes?: string[]
  /** Enabled services that need domain-wide delegation the account's scopes do not add, so none of their methods can run. */
  delegationRequired?: string[]
  /** What to do next, as one sentence; absent when nothing is needed. */
  nextStep?: string
}

/** The plugin's state, in the names every plugin's status RPC shares. */
export type GwsState = "connected" | "sign_in_required" | "not_configured"

export interface GwsStatus {
  /** The plugin's version. */
  version: string
  /** The OpenCode host: its version (null when unknown), the supported range, and whether that release is tested. */
  host: { version: string | null; range: string; tested: boolean }
  /** sign_in_required or not_configured when an account needs it, else connected. */
  state: GwsState
  /** What the generated default rules allow: `all`, `ask-changes` or `read-only`. */
  access: "all" | "ask-changes" | "read-only"
  gws: { path: string; version: string }
  services: string[]
  accounts: GwsAccount[]
  /** Audit persistence has failed; omitted means false. */
  auditDegraded?: boolean
  /** Skills with one of the plugin's skill ids from another file, which hide the plugin's own; present when any does. */
  shadowedSkills?: { id: string; path: string }[]
  /** Other skills that teach agents to run gws in a shell, which skips plans, approvals and policy; present when any does. */
  shellSkills?: { id: string; path: string }[]
  /** Agents that missed the default ask rules, so a commit there runs without asking. */
  unguardedAgents: string[]
  /** The permission block to add first in each unguarded agent's own permissions; present when any is unguarded. */
  permissionsBlock?: string
  /** The one thing to do next, as one sentence; NOTHING_TO_DO when nothing is needed. */
  nextStep: string
}

const text = { type: "string" } as const
const texts = { type: "array", items: text } as const
const object = (properties: Record<string, object>, required: readonly string[]) => ({ type: "object", properties, required }) as const

const MODES: readonly unknown[] = ["interactive", "credentials_file", "access_token"]
const ACCESS: readonly unknown[] = ["read", "write"]
const POLICY_ACCESS: readonly unknown[] = ["all", "ask-changes", "read-only"]
const CLIENT_SOURCES: readonly unknown[] = ["account", "plugin", "pasted"]
const STATES: readonly unknown[] = ["connected", "sign_in_required", "not_configured"]

const account = object(
  {
    alias: text,
    mode: { enum: MODES },
    services: texts,
    integrationID: text,
    connected: { type: "boolean" },
    needsAuth: { const: true },
    access: { enum: ACCESS },
    clientSource: { enum: CLIENT_SOURCES },
    grantedScopes: texts,
    missingScopes: texts,
    delegationRequired: texts,
    nextStep: text,
  },
  ["alias", "mode", "services", "connected"],
)

const status = object(
  {
    version: text,
    host: object({ version: { type: ["string", "null"] }, range: text, tested: { type: "boolean" } }, ["version", "range", "tested"]),
    state: { enum: STATES },
    access: { enum: POLICY_ACCESS },
    gws: object({ path: text, version: text }, ["path", "version"]),
    services: texts,
    accounts: { type: "array", items: account },
    auditDegraded: { type: "boolean" },
    shadowedSkills: { type: "array", items: object({ id: text, path: text }, ["id", "path"]) },
    shellSkills: { type: "array", items: object({ id: text, path: text }, ["id", "path"]) },
    unguardedAgents: texts,
    permissionsBlock: text,
    nextStep: text,
  },
  ["version", "host", "state", "access", "gws", "services", "accounts", "unguardedAgents", "nextStep"],
)

export const Gws = Rpc.define({
  id: RPC_ID,
  methods: {
    status: {
      input: { type: "object", properties: {}, additionalProperties: false },
      output: status,
    },
  },
  events: {},
})

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)
const isStrings = (value: unknown): value is string[] => Array.isArray(value) && value.every((entry) => typeof entry === "string")
const optional = (value: unknown, check: (value: unknown) => boolean) => value === undefined || check(value)
const isText = (value: unknown) => typeof value === "string"

const isSkills = (value: unknown) => Array.isArray(value) && value.every((skill) => isRecord(skill) && isText(skill["id"]) && isText(skill["path"]))

function isAccount(value: unknown): value is GwsAccount {
  return (
    isRecord(value) &&
    isText(value["alias"]) &&
    MODES.includes(value["mode"]) &&
    isStrings(value["services"]) &&
    typeof value["connected"] === "boolean" &&
    optional(value["integrationID"], isText) &&
    optional(value["needsAuth"], (entry) => entry === true) &&
    optional(value["access"], (entry) => ACCESS.includes(entry)) &&
    optional(value["clientSource"], (entry) => CLIENT_SOURCES.includes(entry)) &&
    optional(value["grantedScopes"], isStrings) &&
    optional(value["missingScopes"], isStrings) &&
    optional(value["delegationRequired"], isStrings) &&
    optional(value["nextStep"], isText)
  )
}

/** Whether a received value has the status shape the schema describes. */
export function isStatus(value: unknown): value is GwsStatus {
  return (
    isRecord(value) &&
    isText(value["version"]) &&
    isRecord(value["host"]) &&
    (value["host"]["version"] === null || isText(value["host"]["version"])) &&
    isText(value["host"]["range"]) &&
    typeof value["host"]["tested"] === "boolean" &&
    STATES.includes(value["state"]) &&
    POLICY_ACCESS.includes(value["access"]) &&
    isRecord(value["gws"]) &&
    isText(value["gws"]["path"]) &&
    isText(value["gws"]["version"]) &&
    isStrings(value["services"]) &&
    Array.isArray(value["accounts"]) &&
    value["accounts"].every(isAccount) &&
    optional(value["auditDegraded"], (entry) => typeof entry === "boolean") &&
    optional(value["shadowedSkills"], isSkills) &&
    optional(value["shellSkills"], isSkills) &&
    isStrings(value["unguardedAgents"]) &&
    optional(value["permissionsBlock"], isText) &&
    isText(value["nextStep"])
  )
}

/*
 * Shared wording, so the TUI dialog and /gws-status render the model the
 * same way: the rows Connection, Account, Access, Tools, Agents without
 * default rules, OpenCode and Next step, in that order.
 */

/** The Next step line when nothing is needed. */
export const NOTHING_TO_DO = "Nothing to do."

/** An account's Connection row: `connected`, `sign-in required`, or `not configured` for a headless account whose variable is unset. */
export function connectionLabel(account: GwsAccount): "connected" | "sign-in required" | "not configured" {
  if (account.connected) return "connected"
  return account.mode === "interactive" ? "sign-in required" : "not configured"
}

/** The OpenCode row: the version, then `tested`, or `host untested` with the supported range. */
export function openCodeLabel(status: GwsStatus): string {
  const version = status.host.version ?? "unknown"
  return status.host.tested ? `${version} (tested)` : `${version} (host untested; supported range ${status.host.range})`
}

/** The row naming skills that hide the plugin's own, and its value. */
export const SHADOWED_LABEL = "Hidden skills"
export function shadowedText(status: GwsStatus): string {
  return (status.shadowedSkills ?? []).map((skill) => `${skill.id} (hidden by ${skill.path})`).join(", ")
}

/** The row naming skills that run gws in a shell, and its value. */
export const SHELL_LABEL = "Shell gws skills"
export function shellText(status: GwsStatus): string {
  return (status.shellSkills ?? []).map((skill) => `${skill.id} (${skill.path})`).join(", ")
}

/** The Permissions row: what the generated default rules allow, from the `access` option. */
export const PERMISSIONS_LABEL = "Permissions"
export function accessText(status: Pick<GwsStatus, "access">): string {
  if (status.access === "read-only") return "reads run; every commit is denied until you change access (read-only)"
  if (status.access === "ask-changes") return "reads run; each commit asks first (ask-changes)"
  return "every tool runs without asking, the six commit tools included (all)"
}

/** The row naming services that need domain-wide delegation. */
export const DELEGATION_LABEL = "Needs domain-wide delegation"

/** That row's value: the services, and how an account whose admin set up delegation adds their scopes. */
export function delegationText(account: GwsAccount): string {
  const services = account.delegationRequired ?? []
  return `${services.join(", ")} (a Workspace admin sets it up; then add the scopes to accounts.${account.alias}.scopes)`
}

/** The Next step when an agent lacks the default rules: one fixed sentence, the same in every plugin. */
export const UNGUARDED_NEXT_STEP =
  "Put the default rules shown by /gws-status first in each listed agent's own permissions, in opencode.json or the agent's Markdown file, followed by your top-level rules for Google Workspace tools."
