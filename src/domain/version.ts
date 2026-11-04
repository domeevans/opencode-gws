/** package.json `version`, set at build time by scripts/bundle.mjs and in tests by vitest.config.ts. */
declare const __PLUGIN_VERSION__: string
export const PLUGIN_VERSION = __PLUGIN_VERSION__
export const PLUGIN_ID = "google-workspace.gws"
