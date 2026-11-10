import { existsSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { gwsTarget } from "../../src/domain/backend.js"
import { currentPlatform } from "../../src/process/binary.js"

/**
 * The verified upstream gws executable for this platform, which `npm run fetch:gws` puts in .cache/gws. A checkout has
 * no release manifest, so tests that run the real binary name this path with `binary.path` or call it directly.
 */
export function pinnedGwsPath(): string {
  const target = gwsTarget(currentPlatform())
  if (!target) throw new Error(`no pinned gws for ${process.platform} ${process.arch}; these tests need a supported platform`)
  const path = join(fileURLToPath(new URL("../..", import.meta.url)), ".cache", "gws", target, "gws")
  if (!existsSync(path)) throw new Error(`${path} is missing: run npm run fetch:gws`)
  return path
}
