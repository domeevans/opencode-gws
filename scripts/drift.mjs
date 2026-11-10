#!/usr/bin/env node
/**
 * Maintainer-run drift check: compares manifest/generated.json with the
 * services, methods, and helpers the pinned gws offers. It warns; nothing
 * at runtime depends on it.
 *
 *   node scripts/drift.mjs [--gws <absolute path>] [--strict]
 *
 * gws is the one the plugin runs: this platform's pinned executable that
 * `npm run fetch:gws` puts in .cache/gws, checked against native/provenance.json,
 * or an explicit `--gws` path. Never a `gws` on PATH. It
 * reads only gws's own help, so it needs no network and no sign-in.
 *
 * Exit codes: 0 no drift, or drift without --strict; 1 drift with
 * --strict; 2 usage or gws error.
 */
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { fail, gwsRunner, gwsVersion, resolveGws, serviceList, walk } from "./generate-manifest.mjs"
import { expandManifest } from "./manifest-format.mjs"

const USAGE = "Usage: node scripts/drift.mjs [--gws <absolute path>] [--strict]"
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

const args = process.argv.slice(2)
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === "--gws") index += 1
  else if (args[index] !== "--strict") fail(`unknown argument "${args[index]}". ${USAGE}`)
}
const strict = args.includes("--strict")
const gws = gwsRunner(await resolveGws(args))

let installed
try {
  const services = serviceList(gws)
  const methods = new Set()
  const helpers = new Set()
  for (const service of services) {
    const acc = { methods: [], helpers: [] }
    walk(gws, service, [], acc, false)
    for (const method of acc.methods) methods.add(method.id)
    for (const helper of acc.helpers) helpers.add(helper.id)
  }
  installed = { version: gwsVersion(gws), services: new Set(services), methods, helpers }
} catch (error) {
  fail(`gws failed: ${String(error?.message ?? error).split("\n")[0]}`)
}

const manifest = expandManifest(JSON.parse(readFileSync(join(ROOT, "manifest", "generated.json"), "utf8")))
const allMethods = manifest.services.flatMap((service) => service.methods)
const allHelpers = manifest.services.flatMap((service) => service.helpers)
const known = {
  services: new Set(manifest.services.map((service) => service.alias)),
  methods: new Set(allMethods.map((method) => method.id)),
  helpers: new Set(allHelpers.map((helper) => helper.id)),
}

const only = (a, b) => [...a].filter((id) => !b.has(id)).sort()
const list = (ids) => `${ids.slice(0, 20).join(", ")}${ids.length > 20 ? `, and ${ids.length - 20} more` : ""}`
const problems = []
if (installed.version !== manifest.gwsVersion) problems.push(`gws is ${installed.version}, but the manifest is from ${manifest.gwsVersion}`)
for (const kind of ["services", "methods", "helpers"]) {
  const missing = only(installed[kind], known[kind])
  const stale = only(known[kind], installed[kind])
  if (missing.length) problems.push(`${kind} gws has that the manifest lacks (${missing.length}): ${list(missing)}`)
  if (stale.length) problems.push(`${kind} in the manifest that gws no longer has (${stale.length}): ${list(stale)}`)
}
if (known.methods.size !== allMethods.length) problems.push("the manifest repeats a method id")
if (known.helpers.size !== allHelpers.length) problems.push("the manifest repeats a helper id")
for (const method of allMethods) {
  if (!method.category) problems.push(`method without a category: ${method.id}`)
  if (!method.httpMethod || method.httpMethod === "UNKNOWN") problems.push(`method without an HTTP method: ${method.id}`)
}
for (const helper of allHelpers) if (!helper.category) problems.push(`helper without a category: ${helper.id}`)

if (problems.length > 0) {
  process.stderr.write(`[drift] the manifest and ${installed.version} differ:\n`)
  for (const problem of problems) process.stderr.write(`  - ${problem}\n`)
  process.stderr.write("[drift] Regenerate with npm run manifest and review the diff.\n")
  process.exit(strict ? 1 : 0)
}
process.stdout.write(
  `[drift] in sync: ${installed.version}, ${installed.services.size} services, ${installed.methods.size} methods, ${installed.helpers.size} helpers\n`,
)
