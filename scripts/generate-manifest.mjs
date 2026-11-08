#!/usr/bin/env node
/**
 * Generate the gws command manifest.
 *
 * The manifest is the coverage contract: every gws service, resource,
 * method, and `+helper` is enumerated from the pinned gws's own help
 * output, then annotated with the resolved HTTP method, scopes, the first
 * sentence of its Discovery description, and the plugin risk category.
 * `npm run drift` warns when gws and the manifest diverge.
 *
 * gws is the one the plugin runs: this platform's gws package, found and
 * checked by the plugin's own resolver (in a checkout, `npm run fetch:gws`
 * installs it), or an explicit `--gws` path. Never a `gws` on PATH.
 * `gws schema` reads public Discovery documents, so a first run needs the
 * network.
 *
 * Usage:
 *   node scripts/generate-manifest.mjs [--gws <absolute path>] [--services gmail,drive] [--out path]
 *   node scripts/generate-manifest.mjs --check    never writes: exits 1 when the checkout's manifest differs
 */
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, isAbsolute, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { manifestText } from "./manifest-format.mjs"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

/** Exit with a usage or environment error. */
export function fail(message) {
  process.stderr.write(`[gws] ${message}\n`)
  process.exit(2)
}

/**
 * The gws binary the plugin runs: `--gws <absolute path>`, or this
 * platform's gws package as the plugin resolves and checks it
 * (`resolvePackagedBinary` in src/process/binary.ts, bundled in memory).
 */
export async function resolveGws(args) {
  const index = args.indexOf("--gws")
  if (index !== -1) {
    const path = args[index + 1]
    if (!path || !isAbsolute(path)) fail("--gws needs the absolute path of a gws executable")
    return path
  }
  try {
    const { build } = await import("esbuild")
    const bundled = await build({
      entryPoints: [join(ROOT, "src", "process", "binary.ts")],
      bundle: true,
      write: false,
      format: "esm",
      platform: "node",
      logLevel: "silent",
    })
    const source = Buffer.from(bundled.outputFiles[0].text).toString("base64")
    const { currentPlatform, resolvePackagedBinary } = await import(`data:text/javascript;base64,${source}`)
    return resolvePackagedBinary(currentPlatform(), pathToFileURL(join(ROOT, "package.json")).href)
  } catch (error) {
    fail(`${String(error?.message ?? error).split("\n")[0].replace(/\.?$/, ".")} Or pass --gws <absolute path>.`)
  }
}

/** A runner for one gws binary: argv in, stdout out. */
export function gwsRunner(binary) {
  return (args) =>
    execFileSync(binary, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
    })
}

/** The first line of `gws --version`, for example "gws 0.22.5". */
export function gwsVersion(gws) {
  return gws(["--version"]).split("\n")[0].trim()
}

function commandBlock(text) {
  const lines = text.split("\n")
  const start = lines.findIndex((line) => line.trim() === "Commands:")
  if (start === -1) return []
  const out = []
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]
    if (!line.trim()) break
    const match = /^\s{2}(\S+)\s+(.*)$/.exec(line)
    if (match && match[1] !== "help") out.push({ name: match[1], description: match[2] })
  }
  return out
}

/** The service aliases gws lists in its help. */
export function serviceList(gws) {
  const text = gws(["--help"])
  const block = text.split("SERVICES:")[1]?.split("ENVIRONMENT:")[0] ?? ""
  return block
    .split("\n")
    .map((line) => /^\s{4}(\S+)\s+/.exec(line)?.[1])
    .filter((name) => Boolean(name) && name !== "help")
}

const OVERRIDES = [
  // Access grants and mailbox hand-off (mutations only; list/get stay reads).
  { match: "gmail.users.settings.delegates", methods: ["create", "delete"], category: "share" },
  { match: "gmail.users.settings.forwardingaddresses", methods: ["create", "delete"], category: "share" },
  { match: "gmail.users.settings.updateautoforwarding", category: "share" },
  { match: "gmail.users.settings.cse.keypairs.obliterate", category: "delete" },
  { match: "gmail.users.settings.sendas.smimeinfo", category: "write" },
  { match: "people.contactgroups.members", methods: ["modify"], category: "share" },

  // Messages that reach other people.
  { match: "chat.spaces.messages", methods: ["create"], category: "send" },

  // Data-loss operations that are not HTTP DELETE.
  { match: "sheets.spreadsheets.values.clear", category: "delete" },
  { match: "sheets.spreadsheets.values.batchclear", category: "delete" },
  { match: "sheets.spreadsheets.values.batchclearbydatafilter", category: "delete" },
  { match: "sheets.spreadsheets.values.batchupdate", category: "write" },

  // POST reads.
  { match: "sheets.spreadsheets.getbydatafilter", category: "read" },
  { match: "sheets.spreadsheets.values.batchgetbydatafilter", category: "read" },
  { match: "sheets.spreadsheets.developermetadata.search", category: "read" },
  { match: "drive.files.download", category: "read" },
  { match: "drive.files.generatecsetoken", category: "admin" },

  // Persistent exports.
  { match: "drive.files.export", category: "export" },
  { match: "drive.revisions.export", category: "export" },

  // Sharing posture: revokes and ACL changes are share operations too.
  { match: "drive.permissions", methods: ["create", "update", "delete"], category: "share" },
  { match: "calendar.acl", methods: ["insert", "update", "patch", "delete"], category: "share" },
  { match: "chat.spaces.members", methods: ["create", "delete"], category: "share" },
  { match: "classroom.invitations", methods: ["create", "delete"], category: "share" },
  { match: "drive.accessproposals.resolve", category: "share" },
  { match: "drive.approvals.approve", category: "share" },
  { match: "drive.approvals.decline", category: "share" },
  { match: "drive.approvals.start", category: "send" },
  { match: "drive.approvals.reassign", category: "send" },
  { match: "drive.approvals.comment", category: "send" },

  // Deprecated surfaces are denied, never silently writable.
  { match: "drive.teamdrives", category: "deny" },

  // Watch lifecycle.
  { match: "gmail.users.watch", category: "watch" },
  { match: "gmail.users.stop", category: "watch" },
  { match: "calendar.events.watch", category: "watch" },
  { match: "calendar.channels.stop", category: "watch" },
  { match: "drive.files.watch", category: "watch" },
  { match: "drive.changes.watch", category: "watch" },
  { match: "drive.channels.stop", category: "watch" },
  { match: "events.subscriptions", category: "watch" },

  // Deploy remains a separate authority.
  { match: "script.projects.deployments", category: "deploy" },
  { match: "script.projects.versions.create", category: "deploy" },
  { match: "script.scripts.run", category: "deploy" },

  // Watch lifecycle: push-notification registrations are not writes.
  { match: "forms.forms.watches", category: "watch" },
  { match: "classroom.registrations", category: "watch" },
]

const ADMIN_SERVICES = new Set([
  "admin-reports",
  "admin-directory",
  "vault",
  "vaultgroups",
  "groupssettings",
  "licensing",
  "cloudidentity",
  "alertcenter",
  "modelarmor",
])

const HELPER_CATEGORIES = [
  [/(^|\.)\+?(send|reply|reply-all|forward)$/, "send"],
  [/(^|\.)\+?(read|triage|agenda)$/, "read"],
  [/(^|\.)\+?watch$/, "watch"],
  [/(^|\.)\+?(upload|write|append|insert)$/, "write"],
]

function classify(service, path, method, httpMethod) {
  const id = [service, ...path, method].join(".").toLowerCase()
  for (const override of OVERRIDES) {
    if (id !== override.match && !id.startsWith(`${override.match}.`)) continue
    if (override.methods && !override.methods.includes(method.toLowerCase())) continue
    return override.category
  }

  if (ADMIN_SERVICES.has(service)) {
    return httpMethod === "GET" ? "read" : "admin"
  }
  if (service === "events") return httpMethod === "GET" ? "read" : "watch"
  if (service === "script" && /deploy/.test(method.toLowerCase())) return "deploy"

  if (httpMethod === "GET") return "read"
  if (httpMethod === "DELETE") return "delete"
  if (httpMethod === "PUT" || httpMethod === "PATCH") return "write"

  const methodName = method.toLowerCase()
  const resourceName = path.join(".").toLowerCase()
  if (/(send|reply|forward|notify|invite|comment|reassign)/.test(methodName)) return "send"
  if (/(permission|acl|share|delegate|forwarding|membership|member|accessproposal|approval)/.test(`${resourceName}.${methodName}`)) {
    return "share"
  }
  if (/(delete|clear|purge|revoke|cancel|trash|obliterate|remove)/.test(methodName)) return "delete"
  if (/(export|download)/.test(methodName)) return "export"
  return "write"
}

function helperCategory(service, name) {
  const id = `${service}.${name}`.toLowerCase()
  if (service === "events") return "watch"
  if (service === "script") return "deploy"
  if (service === "modelarmor") return "admin"
  if (service === "workflow") {
    if (id.includes("file-announce")) return "send"
    if (id.includes("email-to-task")) return "write"
    return "read"
  }
  for (const [pattern, category] of HELPER_CATEGORIES) {
    if (pattern.test(id)) return category
  }
  return "write"
}

/**
 * The first sentence of a Discovery description, as plain text of at most
 * 160 characters; undefined when there is none.
 */
export function firstSentence(text) {
  if (typeof text !== "string") return undefined
  const plain = text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim()
  if (!plain) return undefined
  const end = /(?<!\b(?:e\.g|i\.e|etc|vs))\.(?=\s|$)/.exec(plain)
  const sentence = end ? plain.slice(0, end.index + 1) : plain
  if (sentence.length <= 160) return sentence
  const cut = sentence.slice(0, 159)
  return `${cut.slice(0, cut.lastIndexOf(" ")).replace(/[\s,;:]+$/, "")}…`
}

function resolveMethod(gws, service, commandPath) {
  const method = commandPath[commandPath.length - 1]
  const resources = commandPath.slice(0, -1)
  const dotted = [service, ...commandPath].join(".")
  let raw
  try {
    raw = JSON.parse(gws(["schema", dotted]))
  } catch (error) {
    return {
      id: dotted,
      service,
      path: resources,
      method,
      httpMethod: "UNKNOWN",
      pathTemplate: null,
      scopes: [],
      category: "deny",
      schemaError: String(error?.message ?? error).slice(0, 300),
    }
  }
  if (raw?.error) {
    return {
      id: dotted,
      service,
      path: resources,
      method,
      httpMethod: "UNKNOWN",
      pathTemplate: null,
      scopes: [],
      category: "deny",
      schemaError: String(raw.error.message ?? "schema error").slice(0, 300),
    }
  }
  const httpMethod = String(raw.httpMethod ?? "UNKNOWN").toUpperCase()
  const description = firstSentence(raw.description)
  return {
    id: dotted,
    service,
    path: resources,
    method,
    httpMethod,
    pathTemplate: raw.path ?? null,
    scopes: Array.isArray(raw.scopes) ? raw.scopes : [],
    category: classify(service, resources, method, httpMethod),
    ...(description ? { description } : {}),
  }
}

/**
 * Enumerate one service's methods and helpers from gws's help. With
 * `resolve`, each method is annotated from `gws schema`; without it, a
 * method is only its id.
 */
export function walk(gws, service, path, acc, resolve = true) {
  const text = gws([service, ...path, "--help"])
  for (const command of commandBlock(text)) {
    if (command.name.startsWith("+")) {
      acc.helpers.push({
        id: `${service}.${command.name.replace(/^\+/, "")}`,
        service,
        name: command.name,
        description: command.description,
        category: helperCategory(service, command.name),
      })
      continue
    }
    const childPath = [...path, command.name]
    const childText = gws([service, ...childPath, "--help"])
    const children = commandBlock(childText)
    if (children.length > 0) {
      walk(gws, service, childPath, acc, resolve)
    } else {
      acc.methods.push(resolve ? resolveMethod(gws, service, childPath) : { id: [service, ...childPath].join(".") })
    }
  }
}

async function main() {
  const args = process.argv.slice(2)
  const check = args.includes("--check")
  const gws = gwsRunner(await resolveGws(args))
  const servicesIndex = args.indexOf("--services")
  const outIndex = args.indexOf("--out")
  const requested = servicesIndex === -1 ? null : args[servicesIndex + 1].split(",").map((s) => s.trim()).filter(Boolean)
  const out = outIndex === -1 ? join(ROOT, "manifest", "generated.json") : args[outIndex + 1]

  const all = serviceList(gws)
  const services = requested ?? all
  const unknown = services.filter((service) => !all.includes(service))
  if (unknown.length > 0) throw new Error(`unknown service(s): ${unknown.join(", ")}`)

  const result = {
    gwsVersion: gwsVersion(gws),
    generatedAt: new Date().toISOString(),
    services: [],
  }

  for (const service of services) {
    process.stderr.write(`[manifest] ${service}\n`)
    const acc = { alias: service, methods: [], helpers: [] }
    walk(gws, service, [], acc)
    acc.methods.sort((a, b) => a.id.localeCompare(b.id))
    acc.helpers.sort((a, b) => a.id.localeCompare(b.id))
    result.services.push(acc)
  }

  const methods = result.services.reduce((sum, service) => sum + service.methods.length, 0)
  const helpers = result.services.reduce((sum, service) => sum + service.helpers.length, 0)
  const text = manifestText(result)
  if (check) {
    // The generation stamp is not part of what the checkout must match, so both sides drop it.
    // The generation stamp is not part of what the checkout must match, so both sides drop it.
    const withoutStamp = (value) => value.replace(/"generatedAt":"[^"]*",?/, "")
    if (!existsSync(out) || withoutStamp(readFileSync(out, "utf8")) !== withoutStamp(text)) {
      process.stderr.write(
        `[manifest] ${out} does not match what this gws reports (${result.services.length} services, ${methods} methods, ` +
          `${helpers} helpers). Next step: Run npm run manifest and commit the result, then npm run docs:coverage.\n`,
      )
      process.exit(1)
    }
    process.stderr.write(`[manifest] ${out} matches: ${result.services.length} services, ${methods} methods, ${helpers} helpers\n`)
    return
  }
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, text)
  process.stderr.write(`[manifest] wrote ${out}: ${result.services.length} services, ${methods} methods, ${helpers} helpers\n`)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main()
