#!/usr/bin/env node
/**
 * `npm run test:pack`: pack and install the plugin the way OpenCode does,
 * then load the installed copy. Run it after `npm run build`.
 *
 * 1. Pack the main package and this platform's gws package (built from the
 *    verified upstream archive). Check both tarballs: the file whitelist, at
 *    most 1 MiB for the main package, and the gws package's five files.
 * 2. Bare install: both tarballs, scripts disabled, into an empty project.
 *    Nothing else is installed or resolvable from it: no @opencode/plugin,
 *    effect, OpenTUI, Solid or zod. Neither package declares an install
 *    lifecycle script, and the binary matches the pinned release.
 * 3. SDK install: the same tarballs plus @opencode/plugin 2.2.3, as a Node
 *    program that embeds OpenCode has it. Plain Node imports "." and
 *    nothing else. dist/ holds only index.js and tui.js, neither has a
 *    relative import, and dist/tui.js imports only host-provided modules.
 * 4. Load, with no binary override, and require the plugin active and its
 *    status RPC to report gws 0.22.5 from the installed platform package:
 *    - the SDK install in the embedded @opencode/sdk from devDependencies
 *      (2.2.3), and in the one under HOST_SDK_DIR when set (for example a
 *      2.2.4 SDK installed outside the lockfile);
 *    - the bare install in each stock OpenCode of TESTED_HOSTS
 *      (src/domain/host.ts: 2.2.3, 2.2.4 and 2.2.5), through
 *      `opencode serve`. Only a stock CLI supplies @opencode/plugin to a
 *      plugin that does not install it; an embedded SDK host under Node
 *      does not.
 *
 * PACK_TARBALL names a main-package tarball to check instead of packing the
 * checkout, and PACK_BIN_TARBALL this platform's gws-package tarball instead
 * of building one; the release workflow sets both to the tarballs it
 * publishes.
 *
 * Stock binaries come from OPENCODE_BIN_2_2_3, OPENCODE_BIN_2_2_4 and
 * OPENCODE_BIN_2_2_5. When one is unset, @opencode/cli and the current
 * platform package are installed into the temp folder with scripts disabled,
 * once per version. The version a binary reports is the one checked; it
 * must be inside opencode.host. OPENCODE_BIN is ignored: a
 * stock binary must not be started without the isolation below.
 *
 * Every host runs in its own child process. HOME, the four XDG variables,
 * OPENCODE_TEST_HOME and TMPDIR sit inside that host's temp root, and the
 * process is started in its own project directory. A stock load also sets a
 * dead proxy and OPENCODE_DISABLE_MODELS_FETCH, OPENCODE_DISABLE_AUTOUPDATE
 * and OPENCODE_DISABLE_FREE_MODELS, blanks the local provider baseURLs, and
 * refuses to continue unless every `debug paths` entry is inside the root.
 * The embedded hosts get no network. A stock server listens on loopback
 * with a random password.
 */
import { spawn, spawnSync } from "node:child_process"
import { createHash, randomBytes } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { createServer } from "node:net"
import { dirname, join, sep } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { buildPackage, hostTarget, packageName, readProvenance, ROOT } from "./build-bin-packages.mjs"

const MAIN = "@joe-broadhead/opencode-gws"
const PLUGIN_ID = "google-workspace.gws"
const MAX_PACKED_BYTES = 1024 * 1024
const TUI_MAX_BYTES = 30 * 1024
const MAIN_FILES = /^(package\.json|README\.md|LICENSE|NOTICE|CHANGELOG\.md|assets\/icon\.svg|manifest\/generated\.json|views\/(gmail-thread\.html|jelly-view\.js)|skills\/[^/]+\/SKILL\.md)$/
// The two entries the host loads, each one self-contained file; nothing else ships in dist/.
const DIST_FILES = ["dist/index.js", "dist/tui.js"]
const INSTALL_SCRIPTS = ["preinstall", "install", "postinstall", "prepublish", "preprepare", "prepare", "postprepare"]
const HOST_MODULES = ["@opencode/plugin", "effect", "@opentui/core", "@opentui/solid", "solid-js", "zod"]
const TUI_IMPORTS = new Set(["@opentui/core", "@opentui/solid", "solid-js", "@opencode/plugin/tui", "@opencode/plugin/rpc"])
// The zero-configuration default account; loading needs no sign-in.
const SMOKE_OPTIONS = { audit: { enabled: false } }
// Stock hosts: two accounts, one with its client in the plugin options (as organisation config sets it), so
// /connect lists both by name and shows the client fields only where no option sets them.
const SMOKE_CLIENT = { clientId: "123-smoke.apps.googleusercontent.com", clientSecret: "smoke-secret" }
const STOCK_OPTIONS = {
  audit: { enabled: false },
  accounts: { default: { enabledServices: ["gmail"] }, work: { enabledServices: ["drive"], oauthClient: SMOKE_CLIENT } },
}
// The tested hosts: the one list, TESTED_HOSTS in src/domain/host.ts.
const STOCK_HOSTS = JSON.parse(/TESTED_HOSTS: readonly string\[\] = (\[[^\]]*\])/.exec(readFileSync(join(ROOT, "src", "domain", "host.ts"), "utf8"))[1])
const HOST_RANGE = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).opencode.host
const HOST_TIMEOUT_MS = 180_000
const OFFLINE = { OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_DISABLE_FREE_MODELS: "1" }
// Same six rules as ASK_RULES in src/host/agents.ts. A stock load fails if the installed plugin inserts anything else.
const ASK_RULES = ["gws.write", "gws.export", "gws.send", "gws.share", "gws.delete", "gws.admin"].map((action) => ({ action, resource: "*", effect: "ask" }))
const BLANK_PROVIDERS = { lmstudio: { settings: { baseURL: "" } }, ollama: { settings: { baseURL: "" } }, vllm: { settings: { baseURL: "" } } }

function check(condition, message) {
  if (!condition) throw new Error(`pack smoke: ${message}`)
}

function equal(actual, expected, message) {
  check(JSON.stringify(actual) === JSON.stringify(expected), `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", shell: false, ...options })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed (exit ${result.status}):\n${result.stderr}${result.stdout}`)
  return result.stdout
}

/** A fresh, isolated environment: no inherited OpenCode, provider, proxy or credential variables. */
function isolatedEnv(root, extra = {}) {
  const home = join(root, "home")
  const env = {
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
    HOME: home,
    // Bun ignores a changed HOME, so OpenCode's own variable sets it too.
    OPENCODE_TEST_HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    XDG_CACHE_HOME: join(home, ".cache"),
    TMPDIR: join(root, "tmp"),
    LANG: "en_US.UTF-8",
    ...extra,
  }
  for (const dir of [env.XDG_CONFIG_HOME, env.XDG_DATA_HOME, env.XDG_STATE_HOME, env.XDG_CACHE_HOME, env.TMPDIR]) mkdirSync(dir, { recursive: true })
  return env
}

function packageJson(dir) {
  return JSON.parse(readFileSync(join(dir, "package.json"), "utf8"))
}

function pack(dir, destination) {
  const [result] = JSON.parse(run("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", destination, dir], { cwd: ROOT }))
  return { ...result, tarball: join(destination, result.filename) }
}

/** A tarball packed earlier (PACK_TARBALL, PACK_BIN_TARBALL), described like `npm pack --json` does: paths and modes. */
function packed(tarball) {
  const mode = (bits) => [...bits.slice(1, 10)].reduce((value, bit) => value * 2 + (bit === "-" ? 0 : 1), 0)
  const files = run("tar", ["-tvzf", tarball])
    .split("\n")
    .filter((line) => line.startsWith("-"))
    .map((line) => ({ path: line.split(/\s+/).at(-1).replace(/^package\//, ""), mode: mode(line.split(/\s+/)[0]) }))
  return { tarball, files, entryCount: files.length, size: statSync(tarball).size }
}

function install(project, tarballs) {
  mkdirSync(project)
  writeFileSync(join(project, "package.json"), `${JSON.stringify({ name: "pack-smoke", private: true, type: "module" })}\n`)
  run("npm", ["install", "--prefix", project, "--ignore-scripts", "--no-audit", "--no-fund", ...tarballs])
  return join(project, "node_modules", MAIN)
}

function checkMainTarball(main) {
  const paths = main.files.map((file) => file.path).sort()
  equal(paths.filter((path) => path.startsWith("dist/")), DIST_FILES, "main tarball dist/ files")
  equal(paths.filter((path) => !path.startsWith("dist/") && !MAIN_FILES.test(path)), [], "main tarball files outside the whitelist")
  for (const required of ["package.json", ...DIST_FILES, "assets/icon.svg", "manifest/generated.json", "views/gmail-thread.html", "views/jelly-view.js", "README.md", "LICENSE", "NOTICE", "CHANGELOG.md"]) {
    check(paths.includes(required), `main tarball lacks ${required}`)
  }
  check(!paths.some((path) => /(^|\/)gws$/.test(path)), "main tarball contains a gws binary")
  // S6: no type declarations ship.
  equal(paths.filter((path) => /\.d\.[cm]?ts$/.test(path)), [], "main tarball .d.ts files")
  check(main.size <= MAX_PACKED_BYTES, `main tarball is ${main.size} bytes, over ${MAX_PACKED_BYTES}`)
  console.log(`ok main tarball: ${main.entryCount} files, ${main.size} bytes packed`)
}

function checkBinTarball(bin, target, provenance) {
  equal(bin.files.map((file) => file.path).sort(), ["LICENSE", "NOTICE", "bin/gws", "package.json", "provenance.json"], "gws package files")
  check((bin.files.find((file) => file.path === "bin/gws").mode & 0o777) === 0o755, "gws package bin/gws is not 0755")
  console.log(`ok ${packageName(target)} tarball: ${bin.size} bytes packed for ${provenance.targets[target].triple}`)
}

function checkBareInstall(project, target, version, provenance) {
  const modules = join(project, "node_modules")
  equal(readdirSync(modules).filter((name) => !name.startsWith(".")), ["@joe-broadhead"], "installed top-level packages")
  equal(readdirSync(join(modules, "@joe-broadhead")).sort(), ["opencode-gws", `opencode-gws-bin-${target}`], "installed @joe-broadhead packages")
  // Not installed, and not reachable from any ancestor node_modules either.
  const require = createRequire(join(project, "package.json"))
  const resolvable = HOST_MODULES.filter((name) => {
    try {
      require.resolve(`${name}/package.json`)
      return true
    } catch {
      return false
    }
  })
  equal(resolvable, [], "host or bundled modules resolvable from the bare install")

  const main = packageJson(join(modules, MAIN))
  equal(main.version, version, "installed main version")
  for (const field of ["dependencies", "peerDependencies", "peerDependenciesMeta", "bundleDependencies", "bundledDependencies"]) {
    check(main[field] === undefined, `the main package declares ${field}`)
  }
  equal(
    main.optionalDependencies,
    Object.fromEntries(Object.keys(provenance.targets).sort().map((name) => [packageName(name), version])),
    "main optionalDependencies",
  )

  const bin = packageJson(join(modules, packageName(target)))
  const entry = provenance.targets[target]
  equal([bin.name, bin.version, bin.os, bin.cpu, bin.libc], [packageName(target), version, [entry.os], [entry.cpu], entry.libc ? [entry.libc] : undefined], "gws package manifest")
  for (const manifest of [main, bin]) {
    equal(INSTALL_SCRIPTS.filter((name) => manifest.scripts?.[name] !== undefined), [], `${manifest.name} install lifecycle scripts`)
  }
  equal(createHash("sha256").update(readFileSync(join(modules, packageName(target), "bin", "gws"))).digest("hex"), entry.binary.sha256, "installed gws sha256")
  equal(JSON.parse(readFileSync(join(modules, packageName(target), "provenance.json"), "utf8")).archive, entry.archive, "gws package provenance")
  console.log("ok bare install with scripts disabled: the plugin and its platform package only; no host module resolvable; no lifecycle scripts")
}

/** Add the exact 2.2.3 SDK from devDependencies, without another registry download. */
function addPluginSdk(project) {
  const sdk = join(ROOT, "node_modules", "@opencode", "plugin")
  equal(packageJson(sdk).version, "2.2.3", "@opencode/plugin dev dependency")
  mkdirSync(join(project, "node_modules", "@opencode"), { recursive: true })
  symlinkSync(sdk, join(project, "node_modules", "@opencode", "plugin"), "dir")
}

function checkImports(project, root) {
  writeFileSync(
    join(project, "imports.mjs"),
    `const server = await import("${MAIN}")
let rpc = "not exported"
try {
  await import("${MAIN}/rpc")
  rpc = "exported"
} catch {}
console.log(JSON.stringify({ id: server.default.id, setup: typeof server.default.setup, rpc }))
`,
  )
  const imported = JSON.parse(run(process.execPath, [join(project, "imports.mjs")], { cwd: project, env: isolatedEnv(mkdtempSync(join(root, "imports-"))) }))
  equal(imported, { id: PLUGIN_ID, setup: "function", rpc: "not exported" }, "imports of . and ./rpc")
  console.log(`ok Node with @opencode/plugin 2.2.3 imports "." (${imported.id}); "./rpc" is not exported`)
}

/**
 * The installed entries are self-contained: no shipped .js file has a
 * relative import, import() or require, so a stale sibling module cached
 * by a running OpenCode can never be loaded with a new entry. The TUI part
 * imports only host-provided modules.
 */
async function checkEntryImports(pluginDir) {
  const { moduleSpecifiers } = await import(pathToFileURL(join(ROOT, "test", "module-specifiers.ts")).href)
  const shipped = readdirSync(join(pluginDir, "dist")).sort()
  equal(shipped, ["index.js", "tui.js"], "installed dist/ files")
  for (const name of shipped) {
    const file = join(pluginDir, "dist", name)
    const outside = moduleSpecifiers(readFileSync(file, "utf8"), file).filter((specifier) => !/^(?:node:|@opencode\/plugin(?:\/|$)|@opentui\/|solid-js(?:\/|$))/.test(specifier))
    equal(outside, [], `dist/${name} imports outside the host-provided modules`)
  }
  const tui = join(pluginDir, "dist", "tui.js")
  const tuiText = readFileSync(tui, "utf8")
  equal(moduleSpecifiers(tuiText, tui).filter((specifier) => !TUI_IMPORTS.has(specifier)), [], "dist/tui.js imports outside the host-provided modules")
  // The RPC contract is plain JSON Schema, so the TUI part carries no schema library.
  check(!/zod|\$Zod/i.test(tuiText), "dist/tui.js contains zod")
  const tuiBytes = statSync(tui).size
  check(tuiBytes < TUI_MAX_BYTES, `dist/tui.js is ${tuiBytes} bytes, over ${TUI_MAX_BYTES}`)
  console.log(`ok dist/ holds only index.js and tui.js, with no relative import; dist/tui.js is ${tuiBytes} bytes, has no zod, and imports only @opentui/*, solid-js and @opencode/plugin`)
}

function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address()
      server.close(() => resolvePort(port))
    })
  })
}

async function poll(read, done, what, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    try {
      last = await read()
      if (done(last)) return last
    } catch (error) {
      last = error
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250))
  }
  throw new Error(`pack smoke: timed out waiting for ${what}; last: ${last instanceof Error ? last.message : JSON.stringify(last)}`)
}

/** The installed plugin's entry in a host's plugin list, once it has finished loading. */
async function loaded(list, pluginDir, what) {
  const find = (plugins) => plugins.find((plugin) => plugin.id === PLUGIN_ID || plugin.source?.path === pluginDir)
  return find(await poll(list, (plugins) => find(plugins) !== undefined && find(plugins).state?.status !== "loading", what))
}

function checkLoaded(host, entry, status, expected, diagnostics) {
  try {
    equal(entry?.state, { status: "active" }, `${host}: plugin state`)
    check(entry.features?.server && entry.features?.tui && entry.features?.rpc === undefined, `${host}: plugin parts ${JSON.stringify(entry.features)}`)
    equal([status.version, status.host?.version, status.host?.range, status.gws], [expected.version, expected.hostVersion, HOST_RANGE, { path: expected.binary, version: "gws 0.22.5" }], `${host}: status`)
  } catch (error) {
    throw new Error(`${error.message}\n${diagnostics()}`)
  }
  console.log(`ok ${host}: ${PLUGIN_ID} active, gws 0.22.5 from ${expected.binary}`)
}

/** Child process: load the plugin in an embedded @opencode/sdk host and print its plugin entry, status and warnings. */
async function embeddedHost([sdkDir, pluginDir, root]) {
  globalThis.fetch = () => Promise.reject(new Error("pack smoke: network denied"))
  const sdk = join(sdkDir, "node_modules", "@opencode", "sdk")
  const manifest = packageJson(sdk)
  const { OpenCode } = await import(pathToFileURL(join(sdk, manifest.exports["."].import)).href)
  // The contract is inlined into the entries, so define its one method here; the schemas pass values through.
  const { Rpc } = await import(pathToFileURL(join(sdkDir, "node_modules", "@opencode", "plugin", "dist", "rpc.js")).href)
  const any = { "~standard": { version: 1, vendor: "pack-smoke", validate: (value) => ({ value }) } }
  const Gws = Rpc.define({ id: PLUGIN_ID, methods: { status: { input: any, output: any } }, events: {} })
  for (const dir of ["config", "work"]) mkdirSync(join(root, dir), { recursive: true })
  const warnings = []
  const opencode = await OpenCode.create({
    app: { version: manifest.version },
    config: {
      content: JSON.stringify({ plugins: [{ package: pluginDir, options: SMOKE_OPTIONS }], providers: BLANK_PROVIDERS }),
      directory: join(root, "config"),
      project: false,
      claude: false,
    },
    database: { path: join(root, "opencode.db") },
    models: { fetch: false },
    fs: { filewatcher: false },
    log: { level: "warn", emit: (entry) => warnings.push(entry) },
  })
  try {
    const location = { directory: join(root, "work") }
    const entry = await loaded(async () => (await opencode.plugin.list({ location })).data, pluginDir, "the plugin to load")
    const status = entry.state?.status === "active" ? await opencode.rpc(Gws).status({}, { location }) : undefined
    const paths = (await opencode.server.info()).paths
    process.stdout.write(JSON.stringify({ hostVersion: manifest.version, entry, status, warnings, paths }))
  } finally {
    await opencode.close()
  }
}

function checkEmbeddedHost(sdkDir, pluginDir, expected, root) {
  const dir = mkdtempSync(join(root, "embedded-"))
  const output = run(process.execPath, [fileURLToPath(import.meta.url), "--embedded-host", sdkDir, pluginDir, dir], { env: isolatedEnv(dir) })
  const { hostVersion, entry, status, warnings, paths } = JSON.parse(output)
  const outside = stringPaths(paths).filter((path) => !insideRoot(path, dir))
  check(outside.length === 0, `embedded @opencode/sdk resolved paths outside ${dir}: ${outside.join(", ")}`)
  checkLoaded(`embedded @opencode/sdk ${hostVersion}`, entry, status, { ...expected, hostVersion }, () => `host warnings:\n${warnings.map((line) => JSON.stringify(line)).join("\n")}`)
}

/** Each version's stock binary, installed once per run. */
const stockBinaries = new Map()

/** OPENCODE_BIN_<version>, or the stock binary installed from npm with scripts disabled, once per version. */
function stockBinary(version, work) {
  const configured = process.env[`OPENCODE_BIN_${version.replaceAll(".", "_")}`]
  if (configured) return configured
  if (!stockBinaries.has(version)) stockBinaries.set(version, installStock(version, work))
  return stockBinaries.get(version)
}

function installStock(version, work) {
  const dir = join(work, `cli-${version}`)
  mkdirSync(dir)
  writeFileSync(join(dir, "package.json"), `${JSON.stringify({ name: "cli", private: true })}\n`)
  const platform = `@opencode/cli-${process.platform}-${process.arch}`
  run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", `@opencode/cli@${version}`, `${platform}@${version}`], { cwd: dir })
  const binary = join(dir, "node_modules", platform, "bin", "opencode")
  check(existsSync(binary), `@opencode/cli@${version} has no binary for ${process.platform}-${process.arch}`)
  return binary
}

/** A loopback proxy that records each request line and refuses it, so nothing leaves the machine. */
function deadProxy() {
  const attempts = []
  const server = createServer((socket) => {
    socket.on("error", () => {})
    socket.once("data", (chunk) => {
      attempts.push(String(chunk).split("\r\n")[0])
      socket.destroy()
    })
  })
  return new Promise((resolveProxy, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      resolveProxy({
        url: `http://127.0.0.1:${server.address().port}`,
        attempts,
        close: () => new Promise((resolveClose) => server.close(resolveClose)),
      })
    })
  })
}

function debugPaths(text) {
  return text.trim().split("\n").flatMap((line) => {
    const value = line.trim().split(/\s+/).slice(1).join(" ")
    return value ? [value] : []
  })
}

function stringPaths(value, found = []) {
  if (typeof value === "string") found.push(value)
  else if (value && typeof value === "object") for (const child of Object.values(value)) stringPaths(child, found)
  return found
}

function insideRoot(path, root) {
  const resolved = existsSync(path) ? realpathSync(path) : path
  return resolved === root || resolved.startsWith(root + sep)
}

const sameRule = (left, right) => left?.action === right.action && left?.resource === right.resource && left?.effect === right.effect
const isBaseAllow = (rule) => sameRule(rule, { action: "*", resource: "*", effect: "allow" })

function hasAskRules(rules) {
  const base = rules.findIndex(isBaseAllow)
  const index = base >= 0 ? base + 1 : 0
  return ASK_RULES.every((rule, offset) => sameRule(rules[index + offset], rule))
}

/**
 * What /connect lists and renders: one entry per account named "Google Workspace (<alias>)", the
 * client ID and secret fields visible where no option sets a client, hidden with the option's values
 * as their default where one does, and the three host-filled fields always hidden.
 */
async function checkSignIn(version, api) {
  const listed = (await api("GET", "/api/integration")).data.filter((entry) => entry.id.startsWith("gws-"))
  equal(
    listed.map((entry) => [entry.id, entry.name]).sort(),
    [["gws-default", "Google Workspace (default)"], ["gws-work", "Google Workspace (work)"]],
    `opencode ${version}: /connect entries`,
  )
  const form = async (id) => (await api("GET", `/api/integration/${id}`)).data.methods.find((method) => method.type === "oauth")?.form ?? []
  const client = (fields) => fields.filter((field) => field.key === "clientId" || field.key === "clientSecret").map(({ key, hidden, default: value }) => ({ key, hidden, default: value }))
  const own = await form("gws-default")
  equal(
    own.map((field) => field.key),
    ["clientId", "clientSecret", "access", "confirmWrite", "clientJson", "redirectUri", "callbackPort"],
    `opencode ${version}: gws-default form fields`,
  )
  equal(
    own.slice(4).map(({ key, type, hidden }) => ({ key, type, hidden })),
    [
      { key: "clientJson", type: "string", hidden: true },
      { key: "redirectUri", type: "string", hidden: true },
      { key: "callbackPort", type: "integer", hidden: true },
    ],
    `opencode ${version}: the host-filled fields are hidden`,
  )
  equal(client(own), [{ key: "clientId" }, { key: "clientSecret" }], `opencode ${version}: gws-default client fields are visible`)
  equal(
    client(await form("gws-work")),
    [
      { key: "clientId", hidden: true, default: SMOKE_CLIENT.clientId },
      { key: "clientSecret", hidden: true, default: SMOKE_CLIENT.clientSecret },
    ],
    `opencode ${version}: gws-work client fields are hidden with the option's values`,
  )
}

/** True when a plain x.y.z version is inside a `>=a.b.c <d.e.f` range. */
function inRange(version, range) {
  const triple = (text) => text.split(".").map(Number)
  const compare = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]
  const bounds = /^>=(\d+\.\d+\.\d+) <(\d+\.\d+\.\d+)$/.exec(range)
  check(bounds, `unsupported host range ${range}`)
  return /^\d+\.\d+\.\d+$/.test(version) && compare(triple(version), triple(bounds[1])) >= 0 && compare(triple(version), triple(bounds[2])) < 0
}

/**
 * Loads the installed plugin into the stock OpenCode `slot` names, from a project config, as a user does.
 * The version checked is the one the binary reports, which must be inside opencode.host.
 * The plugin must be active, its server part registered, its ask rules after each agent's base allow,
 * and its status RPC answering with gws 0.22.5 from the installed platform package.
 */
async function checkStockHost(slot, binary, pluginDir, expected, root) {
  const base = realpathSync(mkdtempSync(join(root, `stock-${slot}-`)))
  const project = join(base, "project")
  mkdirSync(project)
  writeFileSync(
    join(project, "opencode.json"),
    JSON.stringify({ plugins: [{ package: pluginDir, options: STOCK_OPTIONS }], providers: BLANK_PROVIDERS }),
  )
  const proxy = await deadProxy()
  try {
    const password = randomBytes(24).toString("hex")
    const env = isolatedEnv(base, {
      ...OFFLINE,
      PATH: "/usr/bin:/bin",
      OPENCODE_PASSWORD: password,
      HTTP_PROXY: proxy.url,
      HTTPS_PROXY: proxy.url,
      http_proxy: proxy.url,
      https_proxy: proxy.url,
      ALL_PROXY: proxy.url,
      all_proxy: proxy.url,
      NO_PROXY: "127.0.0.1,localhost",
      no_proxy: "127.0.0.1,localhost",
    })
    const reported = run(binary, ["--version"], { cwd: project, env }).trim()
    const version = reported.replace(/^opencode v/, "")
    check(inRange(version, HOST_RANGE), `${binary} (the ${slot} slot) reports ${JSON.stringify(reported)}, outside opencode.host ${HOST_RANGE}`)
    const listed = debugPaths(run(binary, ["debug", "paths"], { cwd: project, env }))
    check(listed.length >= 8, `opencode ${version} debug paths returned ${listed.length} entries`)
    const outside = listed.filter((path) => !insideRoot(path, base))
    check(outside.length === 0, `opencode ${version} resolves paths outside ${base}: ${outside.join(", ")}`)

    const port = await freePort()
    const server = spawn(binary, ["serve", "--hostname", "127.0.0.1", "--port", String(port), "--print-logs", "--log-level", "warn"], {
      cwd: project,
      env,
      detached: true,
      stdio: ["ignore", "ignore", "pipe"],
    })
    let log = ""
    server.stderr.on("data", (chunk) => (log = (log + chunk).slice(-6000)))
    const exited = new Promise((resolveExit) => server.once("exit", resolveExit))
    const stop = (signal) => {
      try {
        process.kill(-server.pid, signal)
      } catch {
        /* already gone */
      }
    }
    let passed = false
    try {
      const authorization = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`
      const api = async (method, path, body) => {
        const url = new URL(path, `http://127.0.0.1:${port}`)
        url.searchParams.set("location[directory]", project)
        const response = await fetch(url, { method, headers: { authorization, "content-type": "application/json" }, body: body && JSON.stringify(body) })
        const text = await response.text()
        if (!response.ok) throw new Error(`${method} ${path}: HTTP ${response.status} ${text.slice(0, 500)}`)
        return JSON.parse(text)
      }
      const entry = await poll(
        async () => (await api("GET", "/api/plugin")).data.find((plugin) => plugin.id === PLUGIN_ID),
        (plugin) => plugin?.state?.status && plugin.state.status !== "loading",
        `opencode ${version} to load the plugin`,
        HOST_TIMEOUT_MS,
      )
      check(entry?.state?.status === "active", `opencode ${version} did not activate the plugin: ${JSON.stringify(entry?.state)}\n${log}`)
      check(entry.features?.server === true, `opencode ${version}: the gws server is not registered (${JSON.stringify(entry.features)})`)
      check(entry.features?.tui === true && entry.features?.rpc === undefined, `opencode ${version}: plugin parts ${JSON.stringify(entry.features)}`)

      const agents = (await api("GET", "/api/agent")).data
      const withBase = agents.filter((agent) => agent.permissions?.some(isBaseAllow))
      check(withBase.length > 0, `opencode ${version} has no agent with a base allow rule`)
      for (const agent of withBase) {
        check(hasAskRules(agent.permissions), `opencode ${version}: agent ${agent.id} lacks the ask rules after its base allow`)
      }

      await checkSignIn(version, api)

      // Skills and the manifest are read from files beside the bundle, found from import.meta.url.
      const skills = (await api("GET", "/api/skill")).data.filter((skill) => String(skill.id).startsWith("opencode-gws"))
      equal(skills.map((skill) => skill.id).sort(), ["opencode-gws", "opencode-gws-admin", "opencode-gws-recipes"], `opencode ${version}: skills`)
      for (const skill of skills) check(insideRoot(skill.path, pluginDir) && existsSync(skill.path), `opencode ${version}: skill ${skill.id} is not read from the installed package (${skill.path})`)

      const { output } = await api("POST", `/api/rpc/${PLUGIN_ID}/status`, { input: {} })
      equal(
        [output?.version, output?.host, output?.gws],
        [expected.version, { version, range: HOST_RANGE, tested: STOCK_HOSTS.includes(version) }, { path: expected.binary, version: "gws 0.22.5" }],
        `opencode ${version}: status`,
      )
      check(proxy.attempts.length === 0, `opencode ${version} tried to reach the network: ${proxy.attempts.join(", ")}`)
      passed = true
      console.log(`ok stock opencode ${version}: ${PLUGIN_ID} active, server registered, ask rules after the base allow, /connect entries and forms, skills and manifest from the package, gws 0.22.5 from ${expected.binary}`)
    } catch (error) {
      const extra = proxy.attempts.length > 0 ? `\nproxy attempts: ${proxy.attempts.join(", ")}` : ""
      throw new Error(`${error.message}\nserver log tail:\n${log}${extra}`)
    } finally {
      stop("SIGTERM")
      const timer = setTimeout(() => stop("SIGKILL"), 5000)
      await exited
      clearTimeout(timer)
    }
    check(passed, `opencode ${version} stock load did not finish`)
  } finally {
    await proxy.close()
  }
}

async function main() {
  check(Number(process.versions.node.split(".")[0]) >= 24, `the embedded host needs Node >= 24 (running ${process.version})`)
  const sdkDirs = [ROOT, ...(process.env.HOST_SDK_DIR ? [realpathSync(process.env.HOST_SDK_DIR)] : [])]
  const provenance = readProvenance()
  const target = hostTarget(provenance)
  check(target, `no gws package for ${process.platform} ${process.arch}`)
  const version = packageJson(ROOT).version
  for (const file of ["index.js", "tui.js"]) check(readdirSync(join(ROOT, "dist")).includes(file), `dist/${file} is missing; run npm run build first`)

  // Never under $HOME or an inherited TMPDIR: OpenCode finds .opencode/ folders by searching upward.
  const root = realpathSync(mkdtempSync(join(existsSync("/private/tmp") ? "/private/tmp" : "/tmp", "opencode-gws-pack-")))
  try {
    for (const dir of ["tarballs", "bin"]) mkdirSync(join(root, dir))
    const main = process.env.PACK_TARBALL ? packed(realpathSync(process.env.PACK_TARBALL)) : pack(ROOT, join(root, "tarballs"))
    checkMainTarball(main)
    const bin = process.env.PACK_BIN_TARBALL ? packed(realpathSync(process.env.PACK_BIN_TARBALL)) : pack(buildPackage(target, join(root, "bin"), { provenance }), join(root, "tarballs"))
    checkBinTarball(bin, target, provenance)

    const bare = install(join(root, "bare"), [main.tarball, bin.tarball])
    checkBareInstall(join(root, "bare"), target, version, provenance)

    const withSdk = install(join(root, "sdk"), [main.tarball, bin.tarball])
    addPluginSdk(join(root, "sdk"))
    checkImports(join(root, "sdk"), root)
    await checkEntryImports(withSdk)

    for (const sdkDir of sdkDirs) {
      const binary = realpathSync(join(root, "sdk", "node_modules", packageName(target), "bin", "gws"))
      checkEmbeddedHost(sdkDir, withSdk, { version, binary }, root)
    }
    const gwsBinary = realpathSync(join(root, "bare", "node_modules", packageName(target), "bin", "gws"))
    for (const hostVersion of STOCK_HOSTS) {
      await checkStockHost(hostVersion, stockBinary(hostVersion, root), bare, { version, binary: gwsBinary }, root)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

if (process.argv[2] === "--embedded-host") await embeddedHost(process.argv.slice(3))
else await main()
