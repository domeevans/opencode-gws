import { readFileSync, realpathSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
export const PLUGIN_PACKAGE = realpathSync(REPO)
export const packageJson = JSON.parse(readFileSync(join(PLUGIN_PACKAGE, "package.json"), "utf8"))
/** The RPC contract. Both built entries inline it, so tests take it from the source; the id and methods are the same. */
export { Gws, isStatus } from "../../src/rpc.js"
