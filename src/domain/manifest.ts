import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import * as z from "zod"
import { restrictionMarks } from "./restricted.js"
import type { CatalogEntry, CatalogInput, CatalogOutput } from "./contract.js"
import { helperAdapter } from "./helpers.js"
import type { Category, HelperEntry, Manifest, MethodEntry } from "./types.js"

/**
 * The manifest is the coverage contract. It is generated from the pinned
 * gws by `npm run manifest`, and `npm run drift` warns when gws and the
 * manifest diverge. Runtime code never invents a command: a request must
 * resolve to a manifest entry before anything is spawned.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..")

const SERVICE_ALIASES: Readonly<Record<string, string>> = {
  reports: "admin-reports",
  wf: "workflow",
}

/** Normalize gws service aliases to the manifest's canonical alias. */
export function canonicalService(alias: string): string {
  const key = alias.trim().toLowerCase()
  return SERVICE_ALIASES[key] ?? key
}

let cached: Manifest | undefined

/**
 * The stored file: minified, each scope URL once in `scopes`, and no field
 * that an id or the service alias gives (scripts/manifest-format.mjs writes
 * it). Methods name scopes by index.
 */
interface StoredManifest {
  gwsVersion: string
  generatedAt: string
  scopes: string[]
  services: Array<{
    alias: string
    methods: Array<Omit<MethodEntry, "service" | "path" | "method" | "scopes"> & { scopes: number[] }>
    helpers: Array<Omit<HelperEntry, "service">>
  }>
}

/** The stored form expanded to full entries: each method's service, path and method from its id. */
function expandManifest(stored: StoredManifest): Manifest {
  return {
    gwsVersion: stored.gwsVersion,
    generatedAt: stored.generatedAt,
    services: stored.services.map((service) => ({
      alias: service.alias,
      methods: service.methods.map(({ scopes, ...method }) => {
        const parts = method.id.split(".")
        return { ...method, service: service.alias, path: parts.slice(1, -1), method: parts.at(-1)!, scopes: scopes.map((position) => stored.scopes[position]!) }
      }),
      helpers: service.helpers.map((helper) => ({ ...helper, service: service.alias })),
    })),
  }
}

export function loadManifest(): Manifest {
  if (cached) return cached
  cached = expandManifest(JSON.parse(readFileSync(join(ROOT, "manifest", "generated.json"), "utf8")) as StoredManifest)
  return cached
}

interface CommandIndex {
  methods: Map<string, MethodEntry>
  helpers: Map<string, HelperEntry>
}

let index: CommandIndex | undefined

export function commandIndex(): CommandIndex {
  if (index) return index
  const manifest = loadManifest()
  const methods = new Map<string, MethodEntry>()
  const helpers = new Map<string, HelperEntry>()
  for (const service of manifest.services) {
    for (const method of service.methods) methods.set(method.id, method)
    for (const helper of service.helpers) helpers.set(helper.id, helper)
  }
  index = { methods, helpers }
  return index
}

export function resolveMethod(
  service: string,
  resources: readonly string[],
  method: string,
): MethodEntry | undefined {
  return commandIndex().methods.get([service, ...resources, method].join("."))
}

export function resolveHelper(id: string): HelperEntry | undefined {
  return commandIndex().helpers.get(id)
}

/** A manifest operation by id: a Discovery method or a helper. Method and helper ids never collide. */
export function resolveOperation(id: string): { method: MethodEntry } | { helper: HelperEntry } | undefined {
  const method = commandIndex().methods.get(id)
  if (method) return { method }
  const helper = commandIndex().helpers.get(id)
  return helper ? { helper } : undefined
}

/** Categories the plugin never runs. */
const NEVER_RUN: ReadonlySet<Category> = new Set(["deny", "deploy", "watch"])
const COMMITTED: ReadonlySet<Category> = new Set(["write", "send", "share", "delete", "export", "admin"])

/**
 * Helpers that cannot run, and the Discovery method that does the same job.
 * Helpers that run only as watch or deploy, or have no method, have none.
 */
export const HELPER_ALTERNATIVES: Readonly<Record<string, string>> = {
  "calendar.insert": "calendar.events.insert",
  "chat.send": "chat.spaces.messages.create",
  "docs.write": "docs.documents.batchUpdate",
  "drive.upload": "drive.files.create",
  "sheets.append": "sheets.spreadsheets.values.append",
  "workflow.email-to-task": "tasks.tasks.insert",
  "workflow.file-announce": "chat.spaces.messages.create",
}

/**
 * Everyday words for a service that its Discovery text does not use, so a
 * query such as "send email" finds Gmail's messages.send.
 */
const SERVICE_WORDS: Readonly<Record<string, readonly string[]>> = {
  gmail: ["email", "mail", "inbox"],
  drive: ["file", "folder"],
  calendar: ["event", "meeting", "schedule"],
  docs: ["doc", "document"],
  sheets: ["sheet", "spreadsheet"],
  slides: ["slide", "presentation", "deck"],
  people: ["contact"],
  tasks: ["task", "todo"],
  meet: ["meeting", "call"],
}

/** True when the plugin can run a manifest method. */
function methodExecutable(method: MethodEntry): boolean {
  return !NEVER_RUN.has(method.category) && method.schemaError === undefined
}

/** True when the plugin can run a helper: it has an adapter and is not a watch, deploy, or denied helper. */
function helperExecutable(helper: HelperEntry): boolean {
  return helperAdapter(helper.id) !== undefined && !NEVER_RUN.has(helper.category)
}

/** JSON Schema of a runnable helper's input flags; undefined when the helper cannot run. */
export function helperInput(id: string): unknown {
  const helper = commandIndex().helpers.get(id)
  if (!helper || !helperExecutable(helper)) return undefined
  return z.toJSONSchema(helperAdapter(id)!.inputSchema, { io: "input", unrepresentable: "any" })
}

function commitTool(category: Category): string | undefined {
  return COMMITTED.has(category) ? `gws_${category}` : undefined
}

/** Lowercase query words; empty when there is no query. */
function words(query: string | undefined): string[] {
  return (query ?? "").toLowerCase().split(/\s+/).filter(Boolean)
}

/** True when `token` starts a word of `text`. */
function startsWord(text: string, token: string): boolean {
  for (let index = text.indexOf(token); index !== -1; index = text.indexOf(token, index + 1)) {
    if (index === 0 || !/[a-z0-9]/.test(text[index - 1]!)) return true
  }
  return false
}

/**
 * How well an entry matches: every word must appear in its id or
 * description, or name its service. Whole id segments count most, then
 * word starts, then any substring. Undefined when a word does not match.
 */
function rank(tokens: readonly string[], entry: Pick<CatalogEntry, "id" | "service" | "description">): number | undefined {
  if (tokens.length === 0) return 0
  const id = entry.id.toLowerCase()
  const segments = id.split(".")
  const description = entry.description.toLowerCase()
  const serviceWords = SERVICE_WORDS[entry.service] ?? []
  let score = 0
  for (const token of tokens) {
    if (token === segments.at(-1)) score += 4
    else if (segments.includes(token)) score += 3
    else if (startsWord(id, token) || startsWord(description, token)) score += 2
    else if (id.includes(token) || description.includes(token)) score += 1
    else if (serviceWords.some((word) => token.startsWith(word))) score += 1
    else return undefined
  }
  return score
}

/**
 * Search the manifest. A query matches an entry when every word appears in
 * its id or description, or names its service; entries that can run come
 * first, then the best matches, then by id.
 */
export function catalog(input: CatalogInput = {}, services?: ReadonlySet<string>): CatalogOutput {
  const include = new Set(input.include ?? ["services", "methods", "helpers"])
  const tokens = words(input.query)
  const allowed = services ? new Set([...services].map(canonicalService)) : undefined
  const only = input.service ? canonicalService(input.service) : undefined
  const ranked: Array<{ entry: CatalogEntry; score: number }> = []
  const consider = (entry: CatalogEntry): void => {
    if (allowed && !allowed.has(entry.service)) return
    if (only && entry.service !== only) return
    if (input.category && entry.category !== input.category) return
    const score = rank(tokens, entry)
    if (score !== undefined) ranked.push({ entry, score })
  }

  if (include.has("services") && !input.category) {
    for (const service of loadManifest().services) {
      consider({
        kind: "service",
        id: service.alias,
        service: service.alias,
        description: `${service.alias} (${service.methods.length} methods, ${service.helpers.length} helpers)`,
        executable: service.methods.some(methodExecutable) || service.helpers.some(helperExecutable),
      })
    }
  }
  if (include.has("methods")) {
    for (const method of commandIndex().methods.values()) {
      const tool = commitTool(method.category)
      consider({
        kind: "method",
        id: method.id,
        service: method.service,
        description: method.description ?? `${method.httpMethod} ${method.pathTemplate ?? method.id}`,
        category: method.category,
        httpMethod: method.httpMethod,
        ...(method.pathTemplate ? { path: method.pathTemplate } : {}),
        executable: methodExecutable(method),
        ...(tool && methodExecutable(method) ? { commitTool: tool } : {}),
        ...restrictionMarks(method.id),
      })
    }
  }
  if (include.has("helpers")) {
    for (const helper of commandIndex().helpers.values()) {
      const executable = helperExecutable(helper)
      const tool = commitTool(helper.category)
      const alternative = executable ? undefined : HELPER_ALTERNATIVES[helper.id]
      consider({
        kind: "helper",
        id: helper.id,
        service: helper.service,
        description: helper.description,
        category: helper.category,
        executable,
        ...(tool && executable ? { commitTool: tool } : {}),
        ...(alternative ? { alternative } : {}),
      })
    }
  }

  ranked.sort((a, b) => Number(b.entry.executable) - Number(a.entry.executable) || b.score - a.score || a.entry.id.localeCompare(b.entry.id))
  const limit = Math.min(input.limit ?? 50, 200)
  return { entries: ranked.slice(0, limit).map(({ entry }) => entry), total: ranked.length }
}

/** Services with at least one admin-class method or helper in the manifest. */
export function adminServices(): string[] {
  const services = new Set<string>()
  for (const method of commandIndex().methods.values()) {
    if (method.category === "admin") services.add(method.service)
  }
  for (const helper of commandIndex().helpers.values()) {
    if (helper.category === "admin") services.add(helper.service)
  }
  return [...services].sort()
}
