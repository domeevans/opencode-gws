import { PACKAGE_NAME } from "../domain/version.js"

/** What every page of `events_list` shares, whichever source it lists. */

/** The package every page names. */
export const PLUGIN_PACKAGE = PACKAGE_NAME

/** The cursor binding's plugin: the source ids' first segment (`gws` in `gws.gmail`), as the contract's D16 has it. */
export const CURSOR_PLUGIN = "gws"

/** The most bytes of JSON one page takes: the declaration's `maxBytes` for both events sources. */
export const PAGE_MAX_BYTES = 262_144
