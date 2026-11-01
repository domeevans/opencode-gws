import { readdirSync, readFileSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import ts from "typescript"
import { describe, expect, it } from "vitest"
import { moduleSpecifiers } from "./module-specifiers.js"

/**
 * Layer boundaries, enforced on import specifiers:
 *
 *   src/index.ts    entrypoint; may import anything
 *   src/rpc.ts      internal RPC contract in plain JSON Schema; @opencode/plugin/rpc only
 *   src/tui.tsx     TUI part (`./tui`); @opencode/plugin/tui, @opentui/*, solid-js, ./rpc only
 *   src/host/**     the only other modules that import @opencode/plugin
 *   src/runtime/**  orchestrator (index), operations and accounts; domain + process + auth, never host
 *   src/auth/**     Google OAuth; domain only
 *   src/process/**  the only spawn site; domain only
 *   src/domain/**   pure logic; imports nothing outside domain
 *
 * dist/ is a bundle, so these hold for the sources; test/bundle.test.ts
 * checks what the bundle imports.
 */

describe("architecture boundaries", () => {
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
  const SRC = join(ROOT, "src")

  function files(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name)
      return entry.isDirectory() ? files(path) : /\.(?:[cm]?[jt]s|[jt]sx)$/.test(entry.name) && !/\.d\.[cm]?ts$/.test(entry.name) ? [path] : []
    })
  }

  function layer(file: string): string {
    const rel = relative(SRC, file)
    // Specifiers name the emitted .js file; the stem identifies the source.
    const stem = rel.replace(/\.(?:tsx?|js)$/, "")
    if (["index", "rpc", "tui"].includes(stem)) return stem
    return rel.split("/")[0] ?? rel
  }

  interface Import {
    file: string
    specifier: string
    /** Layer of a relative import's target; undefined for packages and node: modules. */
    target?: string
  }

  const IMPORTS: Import[] = files(SRC).flatMap((file) => {
    const text = readFileSync(file, "utf8")
    const specifiers = moduleSpecifiers(text, file)
    return specifiers.map((specifier) => ({
      file: relative(SRC, file).replace(/^tui\.js$/, "tui.tsx").replace(/\.js$/, ".ts"),
      specifier,
      target: specifier.startsWith(".") ? layer(resolve(dirname(file), specifier)) : undefined,
    }))
  })

  function violations(predicate: (entry: Import) => boolean): string[] {
    return IMPORTS.filter(predicate).map((entry) => `${entry.file} -> ${entry.specifier}`)
  }

  it("rejects unsupported production module extensions", () => {
    expect(files(SRC).filter(file => /\.(?:[cm][jt]s|jsx)$/.test(file))).toEqual([])
  })

  it("discovers dynamic, type, aliased, and re-exported module edges", () => {
    for (const text of [
      'import { spawn as run } from "node:child_process"',
      'export * from "node:child_process"',
      'const load = () => import(`node:child_process`)',
      'type Process = import("node:child_process")',
      'import process = require("node:child_process")',
      'const process = module["require"]("node:child_process")',
      '(require)("node:child_process")',
      'export const identity = <T>(value: T) => value; export type { SpawnOptions } from "node:child_process";',
    ]) expect(moduleSpecifiers(text), text).toEqual(["node:child_process"])
    expect(moduleSpecifiers('const example = "import(unsafe)"; // import "node:child_process"')).toEqual([])
    expect(moduleSpecifiers('import("./" + name)')).toEqual(["#computed-module"])
    expect(moduleSpecifiers('(require)(name)')).toEqual(["#computed-module"])
    expect(() => moduleSpecifiers('import {')).toThrow("invalid syntax")
  })

  it("rejects computed module loading and private host modules", () => {
    const allowed = new Set(["@opencode/plugin", "@opencode/plugin/promise/tool", "@opencode/plugin/rpc", "@opencode/plugin/tui", "@opencode/plugin/tui/context"])
    expect(violations((entry) => entry.specifier === "#computed-module" || entry.specifier.startsWith("@opencode/") && !allowed.has(entry.specifier))).toEqual([])
  })
  it("finds the source tree and its imports", () => {
    expect(IMPORTS.length).toBeGreaterThan(40)
    expect(IMPORTS.some((entry) => entry.specifier === "@opencode/plugin")).toBe(true)
    expect(IMPORTS.some((entry) => entry.specifier === "node:child_process")).toBe(true)
  })

  it("keeps every source file in a known layer", () => {
    const layers = new Set(files(SRC).map(layer))
    expect([...layers].sort()).toEqual(["auth", "domain", "host", "index", "process", "rpc", "runtime", "tui"])
  })

  it("imports @opencode/plugin only from src/index.ts, src/host/**, and the rpc/tui parts", () => {
    expect(
      violations((entry) => entry.specifier.startsWith("@opencode/") && !["index", "host", "rpc", "tui"].includes(layer(join(SRC, entry.file)))),
    ).toEqual([])
  })

  it("keeps the RPC contract importable without the implementation", () => {
    const own = IMPORTS.filter((entry) => entry.file === "rpc.ts")
    expect(own.map((entry) => entry.specifier).sort()).toEqual(["@opencode/plugin/rpc"])
  })

  it("keeps the TUI part to the TUI SDK, OpenTUI, Solid, and the RPC contract", () => {
    const allowed = (specifier: string) =>
      specifier === "@opencode/plugin/tui" ||
      specifier === "@opencode/plugin/tui/context" ||
      specifier.startsWith("@opentui/") ||
      specifier === "solid-js" ||
      specifier === "./rpc.js"
    const own = IMPORTS.filter((entry) => entry.file === "tui.tsx")
    expect(own.length).toBeGreaterThan(0)
    expect(own.filter((entry) => !allowed(entry.specifier)).map((entry) => entry.specifier)).toEqual([])
  })

  it("imports the TUI part from nowhere and the RPC contract only from host and tui", () => {
    expect(violations((entry) => entry.target === "tui")).toEqual([])
    expect(violations((entry) => entry.target === "rpc" && !["host", "tui"].includes(layer(join(SRC, entry.file))))).toEqual([])
  })

  it("spawns processes only from src/process/**", () => {
    expect(
      violations((entry) => /^(node:)?child_process$/.test(entry.specifier) && layer(join(SRC, entry.file)) !== "process"),
    ).toEqual([])
  })

  it("keeps src/domain/** free of other layers", () => {
    expect(violations((entry) => entry.file.startsWith("domain/") && entry.target !== undefined && entry.target !== "domain")).toEqual([])
  })

  it("keeps auth and process independent of host, runtime, and each other", () => {
    const allowed: Record<string, string[]> = { auth: ["auth", "domain"], process: ["process", "domain"], runtime: ["runtime", "domain", "process", "auth"] }
    expect(
      violations((entry) => {
        const from = layer(join(SRC, entry.file))
        return entry.target !== undefined && from in allowed && !allowed[from]!.includes(entry.target)
      }),
    ).toEqual([])
  })

  it("resolves relative .js specifiers to their source layer", () => {
    expect(IMPORTS.some((entry) => entry.file === "index.ts" && entry.target === "runtime")).toBe(true)
    expect(IMPORTS.some((entry) => entry.file === "tui.tsx" && entry.target === "rpc")).toBe(true)
  })

  it("allows only the host to import the runtime type", () => {
    expect(
      violations((entry) => entry.target === "runtime" && !["index", "host", "runtime"].includes(layer(join(SRC, entry.file)))),
    ).toEqual([])
  })
})

/**
 * Forbidden APIs: fork-only, deprecated, or private host surface that a
 * plugin for public OpenCode 2.2.3 must not use. Detection walks the
 * syntax tree, so comments and string literals never match.
 */

const PUBLIC_HOST_PACKAGES = /^@opencode\/(?:plugin(?:\/.*)?|sdk|client)$/

function memberName(node: ts.Node): string | undefined {
  if (ts.isPropertyAccessExpression(node)) return node.name.text
  if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) return node.argumentExpression.text
  return undefined
}

function memberObject(node: ts.Node): ts.Expression | undefined {
  return ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node) ? node.expression : undefined
}

function nameOf(node: ts.Expression | undefined): string | undefined {
  if (!node) return undefined
  return ts.isIdentifier(node) ? node.text : memberName(node)
}

function keyOf(property: ts.ObjectLiteralElementLike): string | undefined {
  const name = property.name
  return name && (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) ? name.text : undefined
}

function propertyNames(node: ts.ObjectLiteralExpression): string[] {
  return node.properties.flatMap((property) => keyOf(property) ?? [])
}

function propertyValue(node: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined {
  const property = node.properties.find((entry) => ts.isPropertyAssignment(entry) && keyOf(entry) === name)
  return property && ts.isPropertyAssignment(property) ? property.initializer : undefined
}

function containsProperty(node: ts.Node, name: string): boolean {
  if (ts.isObjectLiteralExpression(node) && propertyNames(node).includes(name)) return true
  return ts.forEachChild(node, (child) => containsProperty(child, name) || undefined) ?? false
}

function containsMember(node: ts.Node, name: string): boolean {
  if ((ts.isPropertySignature(node) || ts.isPropertyDeclaration(node)) && ts.isIdentifier(node.name) && node.name.text === name) return true
  return ts.forEachChild(node, (child) => containsMember(child, name) || undefined) ?? false
}

/** Forbidden uses in one source file, as "rule (line N)". */
function forbiddenApis(text: string, filename = "module.ts"): string[] {
  const source = ts.createSourceFile(filename, text, ts.ScriptTarget.Latest, true, /\.[cm]?js$/.test(filename) ? ts.ScriptKind.JS : undefined)
  const found: string[] = []
  const flag = (rule: string, node: ts.Node) => found.push(`${rule} (line ${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1})`)
  for (const specifier of moduleSpecifiers(text, filename)) {
    if (specifier === "@opencode/ai" || specifier.startsWith("@opencode/ai/")) found.push(`@opencode/ai import ${specifier}`)
    else if (specifier.startsWith("@opencode-ai/")) found.push(`@opencode-ai import ${specifier}`)
    else if (specifier.startsWith("@opencode/") && !PUBLIC_HOST_PACKAGES.test(specifier)) found.push(`private host import ${specifier}`)
  }
  function visit(node: ts.Node) {
    if (ts.isIdentifier(node) && /^supports/.test(node.text)) flag(`supports* identifier ${node.text}`, node)
    if (ts.isObjectLiteralExpression(node)) {
      const names = propertyNames(node)
      if (names.includes("setup") && names.includes("image")) flag("image field on a plugin definition", node)
      if (names.includes("responsePolicy")) flag("MCP responsePolicy", node)
      const options = propertyValue(node, "options")
      if (options && ts.isObjectLiteralExpression(options) && propertyNames(options).includes("mcp")) flag("tool options.mcp", node)
      for (const key of ["mcp", "mcps"]) {
        const servers = propertyValue(node, key)
        if (servers && containsProperty(servers, "capabilities")) flag("MCP capabilities", node)
      }
      const experimental = propertyValue(node, "experimental")
      if (experimental && ts.isObjectLiteralExpression(experimental) && propertyNames(experimental).includes("policies")) flag("experimental.policies", node)
    }
    const member = memberName(node)
    const owner = memberObject(node)
    if (member && owner) {
      const ownerName = nameOf(owner)
      if ((member === "catalog" || member === "attest") && ownerName === "mcp") flag(`ctx.mcp.${member}`, node)
      if (member === "mcp" && ownerName === "options") flag("tool options.mcp", node)
      if (member === "responsePolicy") flag("MCP responsePolicy", node)
      if (member === "policies" && ownerName === "experimental") flag("experimental.policies", node)
      if (member === "artifact" && ownerName === "experimental") flag("ctx.experimental.artifact", node)
      if (member === "slot" && ownerName === "ui") flag("ui.slot", node)
      if (member === "text" && ownerName === "generate" && nameOf(memberObject(owner)) !== "experimental") flag("deprecated ctx.generate.text", node)
    }
    if (ts.isCallExpression(node) && nameOf(node.expression) === "assert") {
      if (nameOf(memberObject(node.expression)) === "permission" && node.arguments.length > 1) flag("permission.assert with a second argument", node)
      if (node.arguments.some((argument) => ts.isObjectLiteralExpression(argument) && propertyNames(argument).includes("signal"))) {
        flag("permission.assert input with a signal key", node)
      }
    }
    if ((ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) && node.name.text === "PermissionRequest" && containsMember(node, "signal")) {
      flag("PermissionRequest with a signal key", node)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

describe("forbidden APIs", () => {
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

  function code(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      if (entry.name === "node_modules") return []
      const path = join(dir, entry.name)
      if (entry.isDirectory()) return code(path)
      return /\.(?:[cm]?[jt]s|tsx)$/.test(entry.name) && !/\.d\.[cm]?ts$/.test(entry.name) ? [path] : []
    })
  }

  it("detects each forbidden pattern and ignores comments, strings and the public equivalents", () => {
    const cases: Array<[string, string]> = [
      ["export default Plugin.define({ id: 'x', image: 'data:', setup() {} })", "image field on a plugin definition"],
      ["await ctx.permission.assert(input, { signal })", "permission.assert with a second argument"],
      ["await ctx.permission.assert({ ...request, signal })", "permission.assert input with a signal key"],
      ["const authorize = () => assert({ ...request, signal: call.signal })", "permission.assert input with a signal key"],
      ["interface PermissionRequest { action: string; signal?: AbortSignal }", "PermissionRequest with a signal key"],
      ["if (ctx.permission.supportsCancellation) {}", "supports* identifier supportsCancellation"],
      ["const tools = await ctx.mcp.catalog()", "ctx.mcp.catalog"],
      ["await ctx.mcp['attest'](server)", "ctx.mcp.attest"],
      ["editor.add({ name: 'x', options: { mcp: { server: 'github' } }, execute })", "tool options.mcp"],
      ["const delegated = tool.options.mcp", "tool options.mcp"],
      ["const config = { mcp: { github: { url, capabilities: { tools: true } } } }", "MCP capabilities"],
      ["const config = { mcp: { github: { url, responsePolicy: 'block' } } }", "MCP responsePolicy"],
      ["await ctx.generate.text({ prompt })", "deprecated ctx.generate.text"],
      ["const rules = ctx.experimental.policies", "experimental.policies"],
      ["await ctx.experimental.artifact.create({})", "ctx.experimental.artifact"],
      ["context.ui.slot({ append: 'home.footer.status', render })", "ui.slot"],
      ["import { generateText } from '@opencode/ai'", "@opencode/ai import @opencode/ai"],
      ["const ai = await import('@opencode/ai/providers/openai-compatible')", "@opencode/ai import @opencode/ai/providers/openai-compatible"],
      ["const config = { experimental: { policies: [] } }", "experimental.policies"],
      ["import { Pty } from '@opencode-ai/pty'", "@opencode-ai import @opencode-ai/pty"],
      ["import { Server } from '@opencode/server'", "private host import @opencode/server"],
      ["const core = await import('@opencode/core')", "private host import @opencode/core"],
    ]
    for (const [text, rule] of cases) expect(forbiddenApis(text).join("; "), text).toContain(rule)
    for (const text of [
      "// ctx.mcp.catalog() and Plugin.image are forbidden",
      "const note = 'permission.assert(input, { signal })'",
      "await ctx.permission.assert(request)",
      "await ctx.experimental.generate.text({ prompt })",
      "const model = { name: 'Scripted', capabilities: { tools: true } }",
      "import { Plugin } from '@opencode/plugin'; import { OpenCode } from '@opencode/sdk'",
      "Plugin.define({ id: 'x', setup() {} })",
      "const call = { sessionId, signal: controller.signal }",
    ]) expect(forbiddenApis(text), text).toEqual([])
  })

  it.each(["src", "test", "dist"])("finds none in %s", (directory) => {
    const files = code(join(ROOT, directory))
    expect(files.length).toBeGreaterThan(0)
    const found = files.flatMap((file) => forbiddenApis(readFileSync(file, "utf8"), file).map((rule) => `${relative(ROOT, file)}: ${rule}`))
    expect(found).toEqual([])
  })

  it("declares no install lifecycle scripts", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { scripts?: Record<string, string> }
    const present = ["preinstall", "install", "postinstall", "prepare"].filter((name) => pkg.scripts?.[name] !== undefined)
    expect(present).toEqual([])
  })
})
