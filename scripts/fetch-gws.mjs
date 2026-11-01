#!/usr/bin/env node
/**
 * `npm run fetch:gws`: put this machine's gws package where an installed
 * plugin finds it, node_modules/@joe-broadhead/opencode-gws-bin-<target>/,
 * so a checkout runs the production resolution path. Run it after every
 * `npm ci`, which removes the directory.
 *
 * Idempotent: a package at the current version whose binary matches the
 * pinned sha256 is left alone. The archive is downloaded once into
 * .cache/gws-archives/ and verified on every build.
 */
import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { PACKAGE_SCOPE, ROOT, buildPackage, hostTarget, packageName, readProvenance } from "./build-bin-packages.mjs"

const provenance = readProvenance()
const target = hostTarget(provenance)
if (!target) {
  const supported = Object.keys(provenance.targets).join(", ")
  console.error(`fetch:gws: no gws package for ${process.platform} ${process.arch}; supported targets: ${supported}. Set "binary.path" to a gws 0.22.5 executable instead.`)
  process.exit(1)
}

const scope = join(ROOT, "node_modules", PACKAGE_SCOPE)
const dir = join(scope, `opencode-gws-bin-${target}`)
const version = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version

function current() {
  const manifest = join(dir, "package.json")
  const binary = join(dir, "bin", "gws")
  if (!existsSync(manifest) || !existsSync(binary)) return false
  if (JSON.parse(readFileSync(manifest, "utf8")).version !== version) return false
  return createHash("sha256").update(readFileSync(binary)).digest("hex") === provenance.targets[target].binary.sha256
}

if (current()) console.log(`fetch:gws: ${packageName(target)}@${version} is up to date`)
else console.log(`fetch:gws: installed ${buildPackage(target, scope, { provenance })}`)
