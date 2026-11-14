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

/**
 * The actions that change nothing: the tools status, catalog, schema, read, plan and events_list, and the source
 * contract's three reads that are tools RPC methods only, probe, calendar_today and images_read.
 */
export const READ_ACTIONS = ["gws.status", "gws.catalog", "gws.schema", "gws.read", "gws.plan", "gws.events_list", "gws.probe", "gws.calendar_today", "gws.images_read"] as const

/** The six commit actions: a change, a send, a share, a delete, an export or an admin operation. */
export const CHANGING_ACTIONS = ["gws.write", "gws.export", "gws.send", "gws.share", "gws.delete", "gws.admin"] as const
/**
 * The first-use download of the gws binary: it writes an executable the plugin then runs. It is not in the generated
 * block; the namespace rule (`gws.*`) carries its access effect, so `ask-changes` asks and `read-only` denies it.
 */
export const NATIVE_ACTION = "gws.native_install"
