#!/usr/bin/env node
/**
 * Remove build output so `npm run build` and `npm pack` never ship stale
 * modules from an earlier source layout.
 */
import { rmSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
rmSync(join(ROOT, "dist"), { recursive: true, force: true })
