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
  /** What to do next, as one sentence; absent when nothing is needed. */
  nextStep?: string
}

export interface GwsStatus {
  pluginVersion: string
  hostVersion: string
  /** Present when the host is outside the tested range and allowUntestedHost is set. */
  hostWarning?: string
  gws: { path: string; version: string }
  services: string[]
  accounts: GwsAccount[]
  /** Audit persistence has failed; omitted means false. */
  auditDegraded?: boolean
  /** Agents that missed the default ask rules, so a commit there runs without asking. */
  unguardedAgents: string[]
  /** The permission block to add first in each unguarded agent's own permissions; present when any is unguarded. */
  permissionsBlock?: string
  /** The one thing to do next, as one sentence; absent when nothing is needed. */
  nextStep?: string
}

const text = { type: "string" } as const
const texts = { type: "array", items: text } as const
const object = (properties: Record<string, object>, required: readonly string[]) => ({ type: "object", properties, required }) as const

const MODES: readonly unknown[] = ["interactive", "credentials_file", "access_token"]
const ACCESS: readonly unknown[] = ["read", "write"]
const CLIENT_SOURCES: readonly unknown[] = ["account", "plugin", "pasted"]

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
    nextStep: text,
  },
  ["alias", "mode", "services", "connected"],
)

const status = object(
  {
    pluginVersion: text,
    hostVersion: text,
    hostWarning: text,
    gws: object({ path: text, version: text }, ["path", "version"]),
    services: texts,
    accounts: { type: "array", items: account },
    auditDegraded: { type: "boolean" },
    unguardedAgents: texts,
    permissionsBlock: text,
    nextStep: text,
  },
  ["pluginVersion", "hostVersion", "gws", "services", "accounts", "unguardedAgents"],
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
    optional(value["nextStep"], isText)
  )
}

/** Whether a received value has the status shape the schema describes. */
export function isStatus(value: unknown): value is GwsStatus {
  return (
    isRecord(value) &&
    isText(value["pluginVersion"]) &&
    isText(value["hostVersion"]) &&
    optional(value["hostWarning"], isText) &&
    isRecord(value["gws"]) &&
    isText(value["gws"]["path"]) &&
    isText(value["gws"]["version"]) &&
    isStrings(value["services"]) &&
    Array.isArray(value["accounts"]) &&
    value["accounts"].every(isAccount) &&
    optional(value["auditDegraded"], (entry) => typeof entry === "boolean") &&
    isStrings(value["unguardedAgents"]) &&
    optional(value["permissionsBlock"], isText) &&
    optional(value["nextStep"], isText)
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

/** The OpenCode row: the version, tested or `host untested`. */
export function openCodeLabel(status: GwsStatus): string {
  return status.hostWarning ? `${status.hostVersion} (host untested: ${status.hostWarning})` : `${status.hostVersion} (tested)`
}

/** Where the permission block goes. */
export const BLOCK_PLACEMENT =
  "Put this block first in that agent's own permissions, followed by your top-level rules for gws actions. Never put it in the top-level permissions: that would loosen Explore."
