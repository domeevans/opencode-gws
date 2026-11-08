/**
 * How much the generated default rules allow. `all` is the default; the
 * other two are how a user restricts the plugin. The block the plugin
 * inserts is generated from these lists and the tools' classes, and the
 * README prints the block for each value.
 */

export const ACCESS_VALUES = ["all", "ask-changes", "read-only"] as const
export type Access = (typeof ACCESS_VALUES)[number]

/** The effect of every rule the value holds back; reads are always allowed. */
export const ACCESS_EFFECT: Readonly<Record<Access, "allow" | "ask" | "deny">> = {
  all: "allow",
  "ask-changes": "ask",
  "read-only": "deny",
}

/** The plugin's namespace: a tool a later release adds has this action too. */
export const NAMESPACE_ACTION = "gws.*"

/** The tool actions that change nothing: status, catalog, schema, read and plan. */
export const READ_ACTIONS = ["gws.status", "gws.catalog", "gws.schema", "gws.read", "gws.plan"] as const

/** The six commit actions: a change, a send, a share, a delete, an export or an admin operation. */
export const CHANGING_ACTIONS = ["gws.write", "gws.export", "gws.send", "gws.share", "gws.delete", "gws.admin"] as const
