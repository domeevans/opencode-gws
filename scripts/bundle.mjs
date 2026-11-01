#!/usr/bin/env node
/**
 * Build the two files the host loads, each self-contained:
 *   dist/index.js  the server part (src/index.ts)
 *   dist/tui.js    the TUI part (src/tui.tsx)
 * No chunks and no relative imports: shared code (the RPC contract) is
 * inlined into both. The contract is plain JSON Schema, so only the server
 * part, whose tool schemas use zod, bundles zod. OpenCode reloads a plugin in place and reuses
 * module records it already holds for unchanged paths, so a sibling module
 * could be a stale copy; a single file per entry has no siblings.
 *
 * Only what the host provides stays a bare import: @opencode/plugin and
 * its subpaths, @opentui/*, solid-js and Node built-ins. Sources import zod
 * as `import * as z`, which drops the unused locales.
 * No declarations ship.
 *
 * The TUI's JSX is compiled first with the presets OpenCode applies to
 * local TUI sources (Solid's universal renderer for @opentui/solid, after
 * TypeScript stripping), because OpenCode runs that transform only outside
 * node_modules. esbuild then bundles the result as plain JavaScript.
 *
 * The plugin version comes from package.json at build time
 * (`__PLUGIN_VERSION__`), so no source file repeats it.
 *
 * Modules that locate package files from `import.meta.url` (the manifest,
 * the skills, the gws package) count directories from their source
 * location. Each bundled module therefore sees the URL its file would have
 * at dist/<path>.js, so `../..` still reaches the package root.
 */
import { transformAsync } from "@babel/core"
import { build } from "esbuild"
import { readFileSync } from "node:fs"
import { dirname, join, relative, sep } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const SRC = join(ROOT, "src")
const DIST = join(ROOT, "dist")
const VERSION = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version
const HOST_PROVIDED = ["@opencode/plugin", "@opencode/plugin/*", "@opentui/*", "solid-js", "solid-js/*"]

const sourceLayout = {
  name: "source-layout",
  setup(build) {
    build.onLoad({ filter: /\.ts$/ }, (args) => {
      if (!args.path.startsWith(SRC + sep)) return undefined
      const source = readFileSync(args.path, "utf8")
      if (!source.includes("import.meta.url")) return undefined
      const emitted = `./${relative(SRC, args.path).split(sep).join("/").replace(/\.ts$/, ".js")}`
      return { contents: source.replaceAll("import.meta.url", `new URL(${JSON.stringify(emitted)}, import.meta.url).href`), loader: "ts" }
    })
  },
}

/** src/tui.tsx through Babel's Solid and TypeScript presets; the "js" loader then fails on any JSX or type syntax left. */
const solidTui = {
  name: "solid-tui",
  setup(build) {
    build.onLoad({ filter: /\.tsx$/ }, async (args) => {
      const result = await transformAsync(readFileSync(args.path, "utf8"), {
        filename: args.path,
        configFile: false,
        babelrc: false,
        sourceMaps: false,
        comments: true,
        presets: [
          ["babel-preset-solid", { moduleName: "@opentui/solid", generate: "universal" }],
          ["@babel/preset-typescript", { onlyRemoveTypeImports: false }],
        ],
      })
      if (!result?.code) throw new Error(`babel produced no output for ${relative(ROOT, args.path)}`)
      return { contents: result.code, loader: "js", resolveDir: dirname(args.path) }
    })
  },
}

const shared = {
  absWorkingDir: ROOT,
  bundle: true,
  splitting: false,
  format: "esm",
  platform: "node",
  target: "es2022",
  external: HOST_PROVIDED,
  define: { __PLUGIN_VERSION__: JSON.stringify(VERSION) },
  legalComments: "inline",
  logLevel: "warning",
}

await build({ ...shared, entryPoints: [join(SRC, "index.ts")], outfile: join(DIST, "index.js"), plugins: [sourceLayout] })
await build({ ...shared, entryPoints: [join(SRC, "tui.tsx")], outfile: join(DIST, "tui.js"), plugins: [sourceLayout, solidTui] })

console.log("built dist/index.js, dist/tui.js")
