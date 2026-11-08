import { readdirSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { ACCESS_VALUES, type Access } from "../src/domain/access.js"
import { ErrorCode } from "../src/domain/errors.js"
import { TESTED_HOSTS } from "../src/domain/host.js"
import { defaultRules } from "../src/host/agents.js"
import { NEXT_STEPS } from "../src/host/tools-rpc.js"

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
    }
    // Not plugin codes: Google's own reason and status strings, the audit's marker for a non-plugin error, an
    // httpMethod marker for helpers, HTTP methods, Node's errno codes, and the shared tools RPC's codes for
    // MCP-backed plugins (gws has no MCP server, so a gws refusal is one of the four above).
    const upstream = new Set([
      "ACCESS_TOKEN_SCOPE_INSUFFICIENT", "UNAUTHENTICATED", "SERVICE_DISABLED", "UNKNOWN_ERROR", "HELPER",
      "OK", "ERROR", "SKIPPED", "DENIED", "UNKNOWN", "S256", "GET", "POST", "PUT", "PATCH", "DELETE", "HEAD",
      "SERVER_CONFLICT", "CONNECTING", "CONNECTION_FAILED", "DISABLED", "NOT_REGISTERED", "TOOL_UNAVAILABLE", "UPSTREAM_ERROR",
      "GOOGLE_WORKSPACE_CLI_TOKEN", "GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE", "GOOGLE_WORKSPACE_CLI_CLIENT_ID",
      "GOOGLE_WORKSPACE_CLI_CLIENT_SECRET", "GOOGLE_WORKSPACE_CLI_CONFIG_DIR", "GOOGLE_WORKSPACE_CLI_KEYRING_BACKEND",
      "GOOGLE_WORKSPACE_CLI_SANITIZE_MODE", "GOOGLE_WORKSPACE_CLI_SANITIZE_TEMPLATE", "GOOGLE_WORKSPACE_PROJECT_ID",
      "GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_CLOUD_PROJECT", "GCLOUD_PROJECT", "CLOUDSDK_CONFIG",
      "TMPDIR", "TMP", "TEMP", "XDG_CACHE_HOME", "XDG_STATE_HOME", "SIGKILL",
      "EEXIST", "EXDEV", "EPERM", "ENOTSUP", "ENOENT",
    ])
    expect([...raised].filter((code) => !table.has(code) && !upstream.has(code))).toEqual([])
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
