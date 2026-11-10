import { readdirSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import type { z } from "zod"
import { ACCESS_VALUES, type Access } from "../src/domain/access.js"
import { CatalogInput, CommitInput, RequestInput, SchemaInput, StatusInput } from "../src/domain/contract.js"
import { ErrorCode } from "../src/domain/errors.js"
import { TESTED_HOSTS } from "../src/domain/host.js"
import { defaultRules } from "../src/host/agents.js"
import type { StatusSource } from "../src/host/rpc.js"
import { NAMESPACE, toolSpecs } from "../src/host/tools.js"
import { NEXT_STEPS, TOOLS_RPC_ID } from "../src/host/tools-rpc.js"
import type { Runtime } from "../src/runtime/index.js"

/**
 * The README is the shipped contract: the default-rules block for every
 * `access` value, and every code the plugin reports, are generated from the
 * source by `npm run docs:coverage`, and this file fails when they drift.
 */

const ROOT = fileURLToPath(new URL("../", import.meta.url))
const read = (path: string) => readFileSync(`${ROOT}${path}`, "utf8")

/** The text between a generated block's markers, or a failure naming the file. */
function block(file: string, name: string): string {
  const text = read(file)
  const open = `<!-- generated:${name} -->`
  const close = `<!-- /generated:${name} -->`
  const start = text.indexOf(open)
  const end = text.indexOf(close)
  expect({ file, name, markers: start !== -1 && end > start }).toEqual({ file, name, markers: true })
  return text.slice(start + open.length, end).replace(/^\n\n/, "").replace(/\n\n$/, "")
}

/** The block for one `access` value: the namespace, then every read, then the six commits. */
const rulesBody = (access: Access) =>
  [
    `\`access: "${access}"\``,
    "",
    "| Action | Resource | Effect |",
    "| --- | --- | --- |",
    ...defaultRules(access).map((rule) => `| \`${rule.action}\` | \`${rule.resource}\` | \`${rule.effect}\` |`),
  ].join("\n")

describe("the README's generated blocks", () => {
  it("prints the block for each access value, and it is the block the plugin inserts", () => {
    for (const access of ACCESS_VALUES) expect(block("README.md", `rules-${access}`), `rules-${access}`).toBe(rulesBody(access))
    // Every tool runs at `all`, and the namespace rule covers a tool a later release adds.
    expect(defaultRules("all").every((rule) => rule.effect === "allow")).toBe(true)
    expect(defaultRules("all")[0]).toEqual({ action: "gws.*", resource: "*", effect: "allow" })
    for (const access of ["ask-changes", "read-only"] as const) {
      const rules = defaultRules(access)
      const effect = access === "ask-changes" ? "ask" : "deny"
      expect(rules[0]).toEqual({ action: "gws.*", resource: "*", effect })
      // The namespace first, then the six commits; every read is allowed.
      expect(rules.filter((rule) => rule.effect !== "allow").map((rule) => rule.action)).toEqual(["gws.*", "gws.write", "gws.export", "gws.send", "gws.share", "gws.delete", "gws.admin"])
    }
  })

  it("prints every code in the one typed table, in both directions", () => {
    const rows = Object.entries(ErrorCode).map(([code, entry]) => `| \`${code}\` | ${entry.meaning.replaceAll("|", "\\|")} | ${entry.next.replaceAll("|", "\\|")} |`)
    expect(block("README.md", "codes")).toBe(["Generated from `src/domain/errors.ts` by `npm run docs:coverage`. Do not edit this section by hand.", "", "| Code | Meaning | Next step |", "| --- | --- | --- |", ...rows].join("\n"))
  })

  it("lists every code the source can report, and no others", () => {
    const table = new Set(Object.keys(ErrorCode))
    // Every code a raise site names is in the table, wherever it appears.
    expect(Object.keys(NEXT_STEPS).filter((code) => !table.has(code))).toEqual([])
    const raised = new Set<string>()
    for (const file of walk("src")) {
      for (const match of read(file).matchAll(/"([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*)"/g)) raised.add(match[1]!)
      // A code written into a message, such as "STATUS_UNAVAILABLE: ...", is caught here too.
      for (const match of read(file).matchAll(/"([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*): /g)) raised.add(match[1]!)
      for (const match of read(file).matchAll(/`([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*): /g)) raised.add(match[1]!)
    }
    // Not plugin codes: Gmail's system label ids, which events_list filters on, Google's own reason and status strings, the audit's marker for a non-plugin error, an
    // httpMethod marker for helpers, HTTP methods, Node's errno codes, and the shared tools RPC's codes for
    // MCP-backed plugins (gws has no MCP server, so a gws refusal is one of the four above).
    const upstream = new Set([
      "ACCESS_TOKEN_SCOPE_INSUFFICIENT", "UNAUTHENTICATED", "SERVICE_DISABLED", "UNKNOWN_ERROR", "HELPER",
      "SPAM", "TRASH", "DRAFT", "CATEGORY_PROMOTIONS", "CATEGORY_SOCIAL",
      "OK", "ERROR", "SKIPPED", "DENIED", "UNKNOWN", "S256", "GET", "POST", "PUT", "PATCH", "DELETE", "HEAD",
      "SERVER_CONFLICT", "CONNECTING", "CONNECTION_FAILED", "DISABLED", "NOT_REGISTERED", "TOOL_UNAVAILABLE", "UPSTREAM_ERROR",
      "GOOGLE_WORKSPACE_CLI_TOKEN", "GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE", "GOOGLE_WORKSPACE_CLI_CLIENT_ID",
      "GOOGLE_WORKSPACE_CLI_CLIENT_SECRET", "GOOGLE_WORKSPACE_CLI_CONFIG_DIR", "GOOGLE_WORKSPACE_CLI_KEYRING_BACKEND",
      "GOOGLE_WORKSPACE_CLI_SANITIZE_MODE", "GOOGLE_WORKSPACE_CLI_SANITIZE_TEMPLATE", "GOOGLE_WORKSPACE_PROJECT_ID",
      "GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_CLOUD_PROJECT", "GCLOUD_PROJECT", "CLOUDSDK_CONFIG",
      "TMPDIR", "TMP", "TEMP", "XDG_CACHE_HOME", "XDG_STATE_HOME", "SIGKILL",
      "EEXIST", "EXDEV", "EPERM", "ENOTSUP", "ENOENT",
      // "CODE" is the placeholder a doc comment writes the message shape with, not a code.
      "CODE",
    ])
    // "NATIVE_*" are the shared release-binary installer's own codes (src/process/install.ts, the kit's module). Its
    // one caller, src/process/binary.ts, maps each to a GWS_ code before any tool reports it.
    expect([...raised].filter((code) => !table.has(code) && !upstream.has(code) && !code.startsWith("NATIVE_"))).toEqual([])
    // Every code in the table is in the README table, which the previous test pins to the same table.
    expect([...table].filter((code) => !block("README.md", "codes").includes(`\`${code}\``))).toEqual([])
  })

  it("lists the scripts' refusals in docs/scripting.md exactly", () => {
    const text = read("docs/scripting.md")
    const listed = text
      .split("\n")
      .filter((line) => line.startsWith("| `"))
      .map((line) => /^\| `([A-Z][A-Z0-9_]*)`/.exec(line)?.[1])
      .filter((code): code is string => code !== undefined && code in ErrorCode)
    expect(listed.sort()).toEqual(Object.keys(NEXT_STEPS).sort())
  })
})

describe("the tested releases", () => {
  const said = `${TESTED_HOSTS.slice(0, -1).join(", ")} and ${TESTED_HOSTS.at(-1)}`

  it("names exactly the tested hosts in every file that says what is tested", () => {
    // README, AGENTS.md, SECURITY, the configuration doc and the CHANGELOG's Unreleased section: wherever a sentence
    // mentions a release as tested, the list is TESTED_HOSTS, in full.
    const unreleased = /## \[Unreleased\]([\s\S]*?)(?=\n## |$)/.exec(read("CHANGELOG.md"))?.[1] ?? ""
    const sources: [string, string][] = [
      ["README.md", read("README.md")],
      ["AGENTS.md", read("AGENTS.md")],
      ["SECURITY.md", read("SECURITY.md")],
      ["docs/configuration.md", read("docs/configuration.md")],
      ["CHANGELOG.md (Unreleased)", unreleased],
    ]
    for (const [file, body] of sources) {
      const mentions = body
        .split("\n")
        .flatMap((line) => line.split(/\.\s+/))
        .filter((sentence) => /\btested\b/i.test(sentence))
        // The supported range is not a tested release: drop a backticked `>=a.b.c <d.e.f` span before reading versions.
        .map((sentence) => sentence.replace(/`[^`]*>=[^`]*`/g, ""))
        .map((sentence) => [...sentence.matchAll(/\b\d+\.\d+\.\d+\b/g)].map((match) => match[0]))
        .filter((versions) => versions.length > 0)
      for (const versions of mentions) expect({ file, versions: [...new Set(versions)].sort() }).toEqual({ file, versions: [...TESTED_HOSTS].sort() })
    }
  })

  it("names the tested hosts in full wherever prose states them", () => {
    expect(TESTED_HOSTS).toContain("2.2.6")
    // Prose wraps, so compare with the line breaks flattened.
    const flat = (path: string) => read(path).replace(/\s+/g, " ")
    expect(flat("README.md")).toContain(`tested on ${said}`)
    expect(flat("docs/configuration.md")).toContain(`only ${said} are tested`)
    expect(flat("AGENTS.md")).toContain(`on stock OpenCode ${said}`)
    expect(flat("CONTRIBUTING.md")).toContain(`tested stock OpenCode: ${said}`)
    // No doc names an untested example release as tested.
    expect([flat("README.md"), flat("docs/configuration.md"), flat("AGENTS.md"), flat("CONTRIBUTING.md")].join(" ")).not.toMatch(/tested on [^.]*2\.2\.99/)
  })
})

/** Every TypeScript module under `dir`, in a stable order. */
function walk(dir: string): string[] {
  return readdirSync(`${ROOT}${dir}`, { withFileTypes: true })
    .flatMap((entry) => {
      const path = `${dir}/${entry.name}`
      if (entry.isDirectory()) return entry.name === "node_modules" ? [] : walk(path)
      return entry.name.endsWith(".ts") ? [path] : []
    })
    .sort()
}

/** Everything a user or the model reads about this release, and the source its comments ship in. */
const SHIPPED: readonly string[] = [
  "README.md",
  "SECURITY.md",
  "CHANGELOG.md",
  "AGENTS.md",
  "CONTRIBUTING.md",
  ...readdirSync(`${ROOT}docs`).map((name) => `docs/${name}`),
  ...readdirSync(`${ROOT}skills`).map((name) => `skills/${name}/SKILL.md`),
  ...walk("src"),
]

describe("no internal wording", () => {
  // R9: shipped text states behaviour, never who decided it, and names no lane.
  const banned = [
    /\bowner(?:'s)? (?:decision|ruling)\b/iu,
    /\bthe lead\b/iu,
    /\b(?:audit|review|reconcile) lane\b/iu,
    /hey-jelly\s*#/iu,
  ]

  it("names no owner decision, lead, lane or issue in any shipped file", () => {
    for (const file of SHIPPED) {
      for (const pattern of banned) expect({ file, pattern: String(pattern), hit: pattern.exec(read(file))?.[0] }).toEqual({ file, pattern: String(pattern), hit: undefined })
    }
  })
})

describe("docs/scripting.md and the README's scripting lines", () => {
  const SCHEMAS: Readonly<Record<string, z.ZodType>> = {
    status: StatusInput,
    catalog: CatalogInput,
    schema: SchemaInput,
    read: RequestInput,
    plan: RequestInput,
    write: CommitInput,
    export: CommitInput,
    send: CommitInput,
    share: CommitInput,
    delete: CommitInput,
    admin: CommitInput,
  }
  const examples = (file: string) => {
    // A shell continuation joins its line, so one example is one logical line.
    const source = read(file).replace(/\\\n\s*/g, " ")
    return [...source.matchAll(/opencode api post (\/api\/rpc\/[^\s/]+\/([A-Za-z0-9._<>-]+))[ \t]+([^\n]*)/g)].map((match) => {
      const window = source.slice(match.index!, match.index! + match[0].length + 400)
      const body = /-d '(\{[^']*\})'/.exec(window.replace(/\n\s+(?=["}])/g, ""))
      return { url: match[1]!, method: match[2]!, line: match[0], body: body?.[1] }
    })
  }

  it("gives every example a method of this plugin's RPC, the location header, the envelope and a valid input", () => {
    let seen = 0
    for (const file of ["docs/scripting.md", "README.md"]) {
      for (const example of examples(file)) {
        seen += 1
        expect({ file, url: example.url }).toEqual({ file, url: `/api/rpc/${TOOLS_RPC_ID}/${example.method}` })
        expect({ file, method: example.method, known: example.method === "describe" || example.method in SCHEMAS }).toEqual({ file, method: example.method, known: true })
        expect({ file, header: example.line.includes('-H "x-opencode-directory:$PWD"') }).toEqual({ file, header: true })
        expect({ file, method: example.method, body: example.body !== undefined }).toEqual({ file, method: example.method, body: true })
        const parsed = JSON.parse(example.body!) as { input?: { sessionID?: unknown; input?: unknown } }
        expect({ file, envelope: typeof parsed.input }).toEqual({ file, envelope: "object" })
        // `describe` takes nothing, or one session; every other method names the session and passes the tool's input.
        if (example.method === "describe") {
          expect({ file, keys: Object.keys(parsed.input!).filter((key) => key !== "sessionID") }).toEqual({ file, keys: [] })
          continue
        }
        expect({ file, session: typeof parsed.input!.sessionID }).toEqual({ file, session: "string" })
        // A placeholder session (`ses_…`) is a string too; the tool's input is then checked against the method's schema.
        const check = SCHEMAS[example.method]!.safeParse(parsed.input!.input)
        expect({ file, method: example.method, issues: check.success ? [] : check.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`) }).toEqual({ file, method: example.method, issues: [] })
      }
    }
    expect(seen).toBeGreaterThanOrEqual(2)
  })
})

describe("the text the model is given", () => {
  // R18 and the model-facing rule: at `access: "all"` nothing a model reads may say a tool asks or is off, unless the
  // sentence it sits in names `access`, so a reader can tell the claim depends on the value.
  const sentences = (text: string) => text.replace(/\s+/g, " ").split(/(?<=[.!?])\s+/).filter(Boolean)

  it("says a tool asks or is off only in a sentence that names access", () => {
    const texts: [string, string][] = [
      ["src/host/tools.ts", specDescriptions()],
      ["src/host/tools.ts (namespace)", NAMESPACE.description],
      ...readdirSync(`${ROOT}skills`).map((name): [string, string] => [`skills/${name}/SKILL.md`, read(`skills/${name}/SKILL.md`)]),
    ]
    for (const [file, text] of texts) {
      for (const sentence of sentences(text)) {
        if (!/(?:\basks? (?:the user|you|first|before|each time|every time|for (?:each|every))|\bmay ask\b|\b(?:is|are) off\b|\b(?:the user|you) approv|\bpermission prompt (?:is|shows)\b|\bprompt (?:is|shows) (?:the user's|your)\b)/iu.test(sentence)) continue
        expect({ file, sentence, namesAccess: /\baccess\b/.test(sentence) }).toEqual({ file, sentence, namesAccess: true })
      }
    }
  })

  it("keeps the plan-then-commit shape at every access value", () => {
    // A commit always needs its plan: the default only removes the prompt, never the plan.
    expect(NAMESPACE.description).toContain("A change takes two steps")
    for (const file of ["README.md", "SECURITY.md", "docs/configuration.md"]) expect({ file, plan: read(file).includes("plan") }).toEqual({ file, plan: true })
  })
})

/** Every tool's description, as the tools RPC's describe and the model receive it. */
function specDescriptions(): string {
  // The specs are built, never run, so an empty runtime and a no-op assert will do.
  return toolSpecs({} as Runtime, async () => {}, {} as StatusSource)
    .map((spec) => spec.description)
    .join(" ")
}

