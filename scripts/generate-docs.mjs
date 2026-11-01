#!/usr/bin/env node
/**
 * Generate docs/coverage.md, the Errors section of docs/configuration.md,
 * and the scope table in docs/auth.md from the manifest, the ErrorCode
 * table, and the scope sets.
 *
 *   node scripts/generate-docs.mjs           # write
 *   node scripts/generate-docs.mjs --check   # fail if a generated file drifted
 */
import { readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { expandManifest } from "./manifest-format.mjs"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const CHECK = process.argv.includes("--check")
const CATEGORIES = ["read", "write", "send", "share", "delete", "export", "admin", "deploy", "watch", "deny"]
const SCOPE_PREFIX = "https://www.googleapis.com/auth/"
const begin = (name) => `<!-- generated:${name} -->`
const end = (name) => `<!-- /generated:${name} -->`

function read(path) {
  return readFileSync(join(ROOT, path), "utf8")
}

function afterEquals(source, marker) {
  const at = source.indexOf(marker)
  if (at < 0) throw new Error(`generate-docs: ${marker} not found`)
  const from = at + marker.length
  if (marker.endsWith("=")) return from
  const eq = source.indexOf("=", from)
  if (eq < 0) throw new Error(`generate-docs: ${marker} has no assignment`)
  return eq
}

function extractDelimited(source, marker, openChar, closeChar) {
  const open = source.indexOf(openChar, afterEquals(source, marker))
  if (open < 0) throw new Error(`generate-docs: ${marker} has no ${openChar}`)
  let depth = 0
  for (let i = open; i < source.length; i += 1) {
    const char = source[i]
    if (char === openChar) depth += 1
    else if (char === closeChar) {
      depth -= 1
      if (depth === 0) return source.slice(open, i + 1)
    }
  }
  throw new Error(`generate-docs: ${marker} has no closing ${closeChar}`)
}

function extractBraces(source, marker) {
  return extractDelimited(source, marker, "{", "}")
}

function extractArray(source, marker) {
  return extractDelimited(source, marker, "[", "]")
}

function evalSource(text, bindings = {}) {
  const names = Object.keys(bindings)
  return Function(...names, `"use strict"; return (${text})`)(...names.map((name) => bindings[name]))
}

function runnableHelpers(source) {
  const ids = [...source.matchAll(/id: "([^"]+)"/g)].map((match) => match[1])
  for (const match of source.matchAll(/replyAdapter\("([^"]+)"/g)) ids.push(match[1])
  return [...new Set(ids)].sort()
}

function scopeUrl(name) {
  return name === "openid" || name.startsWith("https://") ? name : `${SCOPE_PREFIX}${name}`
}

function unique(values) {
  return [...new Set(values)]
}

function scopeTable(scopesSource) {
  const direct = evalSource(extractBraces(scopesSource, "const DIRECT"))
  const composite = evalSource(extractBraces(scopesSource, "const COMPOSITE"))
  const identity = evalSource(extractArray(scopesSource, "export const IDENTITY_SCOPES"), { SCOPE_PREFIX }).map(scopeUrl)
  const writeReads = evalSource(extractArray(scopesSource, "export const WRITE_ACCESS_READS"))
  const extra = evalSource(extractArray(scopesSource, "export const EXTRA_SCOPE_METHODS"))
  const rows = Object.entries(direct).map(([service, sets]) => ({
    service,
    read: sets.read.map(scopeUrl),
    write: sets.write.map(scopeUrl),
  }))
  for (const [service, parts] of Object.entries(composite)) {
    rows.push({
      service,
      read: unique(parts.flatMap((part) => direct[part].read.map(scopeUrl))),
      write: unique(parts.flatMap((part) => direct[part].write.map(scopeUrl))),
    })
  }
  rows.sort((left, right) => left.service.localeCompare(right.service))
  const cell = (scopes) => (scopes.length === 0 ? "_(none)_" : scopes.map((scope) => `\`${scope}\``).join("<br>"))
  const lines = [
    begin("scopes"),
    "",
    "Generated from `src/domain/scopes.ts` by `npm run docs:coverage`. Do not edit this section by hand.",
    "",
    "Every interactive sign-in also requests the identity scopes " +
      identity.map((scope) => `\`${scope}\``).join(", ") +
      ". A short name such as `gmail.readonly` is the same scope as `https://www.googleapis.com/auth/gmail.readonly`.",
    "",
    "| Service | Read-only | Read and write |",
    "| --- | --- | --- |",
    ...rows.map((row) => `| ${row.service} | ${cell(row.read)} | ${cell(row.write)} |`),
    "",
    "Read methods that the read-only set does not cover, so they need a Read and write sign-in:",
    "",
    ...writeReads.map((id) => `- \`${id}\``),
    "",
    "Methods neither access level covers. Add one of the method's manifest scopes to the account's `scopes`; every sign-in then requests it and shows it:",
    "",
    ...extra.map((id) => `- \`${id}\``),
    "",
    end("scopes"),
  ]
  return `${lines.join("\n")}\n`
}

function errorsDoc(source) {
  const table = evalSource(extractBraces(source, "export const ErrorCode ="))
  const rows = Object.entries(table).map(
    ([code, entry]) => `| \`${code}\` | ${entry.meaning.replaceAll("|", "\\|")} | ${entry.next.replaceAll("|", "\\|")} |`,
  )
  return [
    begin("errors"),
    "",
    "Generated from `src/domain/errors.ts` by `npm run docs:coverage`. Do not edit this section by hand.",
    "",
    "Every plugin error reads `CODE: What happened. Next step: What to do.` A tool error reaches the model with the metadata `{ code, next, enableUrl? }`. A raise site may give a more specific next step than the one in this table. Host permission errors are not in this table; they propagate unchanged.",
    "",
    "| Code | Meaning | Next step |",
    "| --- | --- | --- |",
    ...rows,
    "",
    end("errors"),
  ].join("\n")
}

function coverageDoc(manifest, helpers) {
  const runnable = new Set(runnableHelpers(helpers))
  const methodTotal = manifest.services.reduce((sum, service) => sum + service.methods.length, 0)
  const helperTotal = manifest.services.reduce((sum, service) => sum + service.helpers.length, 0)
  const rows = manifest.services.map((service) => {
    const counts = {}
    for (const method of service.methods) counts[method.category] = (counts[method.category] ?? 0) + 1
    const cells = CATEGORIES.map((category) => counts[category] ?? 0)
    return `| ${service.alias} | ${service.methods.length} | ${service.helpers.length} | ${cells.join(" | ")} |`
  })
  const totals = CATEGORIES.map((category) =>
    manifest.services.reduce((sum, service) => sum + service.methods.filter((method) => method.category === category).length, 0),
  )
  const catalogHelpers = manifest.services.flatMap((service) => service.helpers.map((helper) => helper.id))
  const missing = [...runnable].filter((id) => !catalogHelpers.includes(id))
  if (missing.length > 0) throw new Error(`generate-docs: adapter ids missing from the manifest: ${missing.join(", ")}`)
  const cannotRun = catalogHelpers.filter((id) => !runnable.has(id)).sort()
  return [
    "# Coverage",
    "",
    `Generated from \`manifest/generated.json\` (${manifest.gwsVersion}) by \`npm run docs:coverage\`. Do not edit by hand.`,
    "",
    "The manifest is the contract: every service, Discovery method, and helper the pinned `gws` exposes. `npm run manifest` regenerates it. `npm run drift` warns when the pinned `gws` and the manifest diverge. It does not stop a call.",
    "",
    "| | |",
    "| --- | --- |",
    `| gws | \`${manifest.gwsVersion}\` |`,
    `| Services | ${manifest.services.length} |`,
    `| Discovery methods | ${methodTotal} |`,
    `| Helpers | ${helperTotal} |`,
    `| Helpers the plugin can run | ${runnable.size} |`,
    "",
    "Category columns count Discovery methods only. A helper keeps its own category. `services` limits what catalog, schema, read, and plan will accept. It does not add tools.",
    "",
    `| Service | Methods | Helpers | ${CATEGORIES.join(" | ")} |`,
    `| --- | ---: | ---: | ${CATEGORIES.map(() => "---:").join(" | ")} |`,
    ...rows,
    `| **Total** | **${methodTotal}** | **${helperTotal}** | ${totals.map((count) => `**${count}**`).join(" | ")} |`,
    "",
    "## Categories",
    "",
    "| Category | How it runs |",
    "| --- | --- |",
    "| read | `gws_read`. A plan is not required. |",
    "| write | `gws_plan`, then `gws_write` |",
    "| send | `gws_plan`, then `gws_send` |",
    "| share | `gws_plan`, then `gws_share` |",
    "| delete | `gws_plan`, then `gws_delete` |",
    "| export | `gws_plan`, then `gws_export` |",
    "| admin | `gws_plan`, then `gws_admin`, and only when the admin gate allows it |",
    "| deploy | Never runs. |",
    "| watch | Never runs. |",
    "| deny | Never runs. |",
    "",
    "A request can raise the manifest category. Trashing a Drive file is a delete. A Calendar event write that emails attendees is a send. A read with `download.path` is an export. The plan's category is the one that commits.",
    "",
    `Helpers the plugin can run: ${[...runnable].sort().map((id) => `\`${id}\``).join(", ")}.`,
    "",
    `Helpers in the catalog that cannot run (${cannotRun.length}): ${cannotRun.map((id) => `\`${id}\``).join(", ")}. \`gws_catalog\` sets \`executable\` to false and, when it has one, names the method to use instead.`,
    "",
  ].join("\n")
}

/** `text` with the section between the `name` markers replaced by `generated`. */
function replaceMarked(text, name, generated) {
  const start = text.indexOf(begin(name))
  const stop = text.indexOf(end(name))
  if (start < 0 || stop < 0 || stop < start) throw new Error(`generate-docs: the ${name} markers are missing`)
  const close = stop + end(name).length
  const newline = text[close] === "\n" ? 1 : 0
  return `${text.slice(0, start)}${generated.trimEnd()}\n${text.slice(close + newline)}`
}

function emit(path, next) {
  const full = join(ROOT, path)
  const current = readFileSync(full, "utf8")
  if (current === next) return
  if (CHECK) {
    process.stderr.write(`generate-docs: ${path} drifted. Run: npm run docs:coverage\n`)
    process.exitCode = 1
    return
  }
  writeFileSync(full, next)
  process.stderr.write(`generate-docs: wrote ${path}\n`)
}

const manifest = expandManifest(JSON.parse(read("manifest/generated.json")))
emit("docs/coverage.md", coverageDoc(manifest, read("src/domain/helpers.ts")))
emit("docs/configuration.md", replaceMarked(read("docs/configuration.md"), "errors", errorsDoc(read("src/domain/errors.ts"))))
emit("docs/auth.md", replaceMarked(read("docs/auth.md"), "scopes", scopeTable(read("src/domain/scopes.ts"))))
if (process.exitCode) process.exit(process.exitCode)
