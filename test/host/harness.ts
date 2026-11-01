import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { afterAll } from "vitest"
import { ALL_SCOPES, account, pluginOptions as buildPluginOptions, storedSignIn } from "../support/config.js"
import { createProbe, type Probe } from "./probe.js"
import { ScriptedModel } from "./scripted-model.js"
import { PLUGIN_PACKAGE, REPO } from "./package.js"
import { network } from "./setup.js"

/**
 * Embedded OpenCode host for integration tests.
 *
 * `@opencode/sdk` assembles the real OpenCode server in this process and
 * routes client calls through its HTTP router in memory: no listener, no
 * spawned CLI. The plugin is loaded the way a user loads it, from a config
 * `plugins` entry pointing at this package (its built `dist/`), with
 * options that point `binary.path` at the fake gws fixture.
 *
 * Isolation: HOME, XDG_*, OPENCODE_TEST_HOME and TMPDIR point into a fresh
 * temp root before the SDK is imported, and startup fails unless OpenCode's
 * global directories resolve inside it. OpenCode takes its home from
 * OPENCODE_TEST_HOME before os.homedir(), which ignores HOME under Bun. Global
 * config, the database, and the work directory live in the root too.
 * models.dev fetch, project config, Claude config, and the file watcher are
 * off. The only provider the session uses is the scripted OpenAI-compatible
 * endpoint on 127.0.0.1.
 *
 * Host version: the SDK in the root devDependencies (2.2.3) by default.
 * HOST_SDK_DIR names a directory whose node_modules holds another
 * @opencode/sdk (for example 2.2.4, installed outside the lockfile); the
 * host then runs that SDK and reports its version.
 */

export { REPO } from "./package.js"
// Account-free probes deliberately have an empty PATH. Pin the fixture's
// interpreter without changing that production isolation boundary. Keep the
// launcher in the repository, outside world-writable /tmp, which binary
// trust rejects as an ancestor.
const fixtureRoot = realpathSync(mkdtempSync(join(REPO, ".fake-gws-")))
const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`
const LOG = join(fixtureRoot, "invocations.jsonl")
export const FAKE_GWS = join(fixtureRoot, "gws")
writeFileSync(
  FAKE_GWS,
  `#!/bin/sh\nFAKE_GWS_LOG=${quote(LOG)} exec ${quote(process.execPath)} ${quote(join(REPO, "test/fixtures/fake-gws.mjs"))} "$@"\n`,
  { mode: 0o700 },
)
afterAll(() => rmSync(fixtureRoot, { recursive: true, force: true }))
export const PLUGIN_ID = "google-workspace.gws"
export const ACCOUNT = "personal"
export const SERVICES = ["gmail", "drive"]

import type { OpenCodeClient } from "@opencode/client"

type Sdk = typeof import("@opencode/sdk")
/**
 * The embedded host's client surface. `OpenCode.Interface` from
 * `@opencode/sdk` resolves to `any` because its declarations import
 * `@opencode/core`, which ships no types; the generated client types are
 * the same contract.
 */
export type Host = OpenCodeClient & {
  sessions: OpenCodeClient["session"]
  events: OpenCodeClient["event"]
  close(): Promise<void>
}
type HostEvent = { type: string; data?: Record<string, unknown> } & Record<string, unknown>

interface PermissionRule {
  action: string
  resource: string
  effect: "allow" | "deny" | "ask"
}

interface HarnessOptions {
  /** Host permission rules (opencode.json `permissions`). */
  permissions?: PermissionRule[]
  /** Named agents in opencode.json `agents`. Config-only agents are created after plugins run. */
  agents?: Record<string, { permissions?: PermissionRule[] }>
  /** Plugin `policy` option. */
  policy?: Record<string, unknown>
  /** Plugin options over the harness defaults; an undefined value removes that option. */
  options?: Record<string, unknown>
}

export interface Harness {
  opencode: Host
  model: ScriptedModel
  location: { directory: string }
  hostVersion: string
  /** Plugin context of a test-only SDK plugin loaded at the same location. */
  probe: ReturnType<Probe["context"]>
  /** Plugin options exactly as written to the host config. */
  pluginOptions: Record<string, unknown>
  /** Every public event seen since start. */
  events: HostEvent[]
  /** Account-scoped argv the fake gws received, in order. */
  invocations(): string[][]
  /** Resolve with the first event matching `predicate` (already seen or future). */
  waitForEvent(predicate: (event: HostEvent) => boolean, timeoutMs?: number): Promise<HostEvent>
  close(): Promise<void>
}

const SDK = join(process.env.HOST_SDK_DIR ? realpathSync(process.env.HOST_SDK_DIR) : REPO, "node_modules", "@opencode", "sdk")

function sdkManifest(): { version: string; exports: { ".": { import: string } } } {
  return JSON.parse(readFileSync(join(SDK, "package.json"), "utf8"))
}

/** The embedded host's version: the version of the SDK it runs. */
function sdkVersion(): string {
  return sdkManifest().version
}

function preflight(): void {
  const major = Number(process.versions.node.split(".")[0])
  // @opencode/sdk ships `await using`, which Node 22 cannot parse.
  if (major < 24) throw new Error(`the host suite needs Node >= 24 (running ${process.version})`)
  if (!existsSync(join(SDK, "package.json"))) throw new Error(`@opencode/sdk is not installed at ${SDK}: run npm ci`)
  if (!existsSync(join(PLUGIN_PACKAGE, "dist", "index.js"))) throw new Error("tested package dist/index.js is missing: run npm run build")
}

export async function startHost(options: HarnessOptions = {}): Promise<Harness> {
  preflight()

  const root = realpathSync(mkdtempSync(join(tmpdir(), "opencode-gws-host-")))
  const home = join(root, "home")
  const work = join(root, "work")
  const tmp = join(root, "tmp")
  for (const dir of [home, work, tmp]) mkdirSync(dir, { recursive: true })
  // Each host starts with an empty invocation log.
  rmSync(LOG, { force: true })

  const savedEnv = new Map<string, string | undefined>()
  const setEnv = (key: string, value: string | undefined) => {
    if (!savedEnv.has(key)) savedEnv.set(key, process.env[key])
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  setEnv("HOME", home)
  setEnv("XDG_CONFIG_HOME", join(home, ".config"))
  setEnv("XDG_DATA_HOME", join(home, ".local", "share"))
  setEnv("XDG_STATE_HOME", join(home, ".local", "state"))
  setEnv("XDG_CACHE_HOME", join(home, ".cache"))
  // A parent OpenCode session (an agent running this suite) must not leak in.
  for (const key of Object.keys(process.env)) if (key.startsWith("OPENCODE")) setEnv(key, undefined)
  setEnv("OPENCODE_TEST_HOME", home)
  setEnv("TMPDIR", tmp)
  const restoreEnv = () => {
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }

  const model = new ScriptedModel()
  const baseURL = await model.start()
  const revokeOrigin = network.allow(baseURL)
  const deniedBefore = network.denied

  const pluginOptions: Record<string, unknown> = {
    ...buildPluginOptions({
      binary: { path: FAKE_GWS },
      accounts: { [ACCOUNT]: account({ services: SERVICES }) },
      policy: options.policy ?? {},
      audit: { enabled: false },
    }),
    ...options.options,
  }
  const config = {
    plugins: [{ package: PLUGIN_PACKAGE, options: pluginOptions }],
    providers: {
      lmstudio: { settings: { baseURL: "" } },
      ollama: { settings: { baseURL: "" } },
      vllm: { settings: { baseURL: "" } },
      scripted: {
        name: "Scripted",
        package: "@opencode/ai/providers/openai-compatible",
        settings: { baseURL, apiKey: "test" },
        models: { turns: { name: "Scripted turns", capabilities: { tools: true } } },
      },
    },
    model: "scripted/turns",
    permissions: options.permissions ?? [],
    ...(options.agents ? { agents: options.agents } : {}),
  }

  const hostVersion = sdkVersion()
  const probe = createProbe()
  let opencode: Host
  try {
    const { OpenCode } = (await import(pathToFileURL(join(SDK, sdkManifest().exports["."].import)).href)) as Sdk
    opencode = await OpenCode.create({
    plugins: [probe.plugin],
    // The embedded host reports "unknown" unless told; the plugin's version
    // gate requires a real 2.x version, so report the SDK's own.
    app: { version: hostVersion },
    config: { content: JSON.stringify(config), directory: join(root, "config"), project: false, claude: false },
    database: { path: join(root, "opencode.db") },
    models: { fetch: false },
    fs: { filewatcher: false },
    log: { level: "error", emit: () => {} },
    })
  } catch (error) {
    await model.stop()
    revokeOrigin()
    restoreEnv()
    rmSync(root, { recursive: true, force: true })
    throw error
  }

  const events: HostEvent[] = []
  const waiters = new Set<{ predicate: (event: HostEvent) => boolean; resolve: (event: HostEvent) => void }>()
  const stream = new AbortController()
  const subscribed = (async () => {
    try {
      for await (const event of opencode.events.subscribe({ signal: stream.signal } as never)) {
        const entry = event as unknown as HostEvent
        events.push(entry)
        for (const waiter of waiters) {
          if (waiter.predicate(entry)) {
            waiters.delete(waiter)
            waiter.resolve(entry)
          }
        }
      }
    } catch {
      /* closed */
    }
  })()

  const location = { directory: work }

  const harness: Harness = {
    opencode,
    model,
    location,
    hostVersion,
    get probe() {
      return probe.context(location.directory)
    },
    pluginOptions,
    events,
    // The fake logs every call; the account-free --version and schema probes are not account-scoped.
    invocations: () =>
      existsSync(LOG)
        ? readFileSync(LOG, "utf8")
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line) as string[])
            .filter((argv) => argv[0] !== "--version" && argv[0] !== "schema")
        : [],
    waitForEvent: (predicate, timeoutMs = 15_000) => {
      const seen = events.find(predicate)
      if (seen) return Promise.resolve(seen)
      return new Promise((resolve, reject) => {
        const waiter = {
          predicate,
          resolve: (event: HostEvent) => {
            clearTimeout(timer)
            resolve(event)
          },
        }
        const timer = setTimeout(() => {
          waiters.delete(waiter)
          reject(new Error(`timed out waiting for event; saw: ${[...new Set(events.map((event) => event.type))].join(", ")}`))
        }, timeoutMs)
        waiters.add(waiter)
      })
    },
    close: async () => {
      stream.abort()
      try {
        await opencode.close()
        await subscribed
      } finally {
        await model.stop()
        revokeOrigin()
        restoreEnv()
        rmSync(root, { recursive: true, force: true })
      }
      if (network.denied !== deniedBefore) throw new Error("host attempted an unregistered fetch")
    },
  }

  try {
    await assertIsolated(opencode, root, home)
    await waitForPlugin(harness)
    // The harness account is signed in with a stored credential that grants every scope.
    if ((pluginOptions.accounts as Record<string, unknown> | undefined)?.[ACCOUNT]) {
      await opencode.credential.create({ integrationID: `gws-${ACCOUNT}`, value: storedSignIn("write", ALL_SCOPES) as never, activate: true })
    }
  } catch (error) {
    await harness.close()
    throw error
  }
  return harness
}

/**
 * OpenCode's temp directory, and the global directories it creates at
 * startup, must all be inside the host's root, never the real home or tmp.
 */
async function assertIsolated(opencode: Host, root: string, home: string): Promise<void> {
  const inside = (path: string) => realpathSync(path).startsWith(`${root}/`)
  const { paths } = await opencode.server.info()
  const created = [
    join(home, ".local", "share", "opencode", "log"),
    join(home, ".local", "state", "opencode"),
    join(home, ".cache", "opencode", "bin"),
    join(root, "tmp", "opencode"),
  ]
  const outside = [paths.tmp, ...created].filter((path) => !existsSync(path) || !inside(path))
  if (outside.length > 0) throw new Error(`OpenCode's global paths are not inside the host root ${root}: ${outside.join(", ")}`)
}

/** Plugin load is asynchronous after the first location request; poll until it settles. */
async function waitForPlugin(harness: Harness): Promise<void> {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const { data } = await harness.opencode.plugin.list({ location: harness.location })
    const entry = data.find((plugin) => plugin.id === PLUGIN_ID)
    if (entry) {
      const status = (entry.state as { status: string }).status
      if (status === "active") return
      if (status !== "loading") throw new Error(`${PLUGIN_ID} failed to load`)
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`${PLUGIN_ID} did not finish loading`)
}

/** Send one prompt and wait until the session is idle again. */
export async function prompt(harness: Harness, sessionID: string, text: string): Promise<void> {
  await harness.opencode.sessions.prompt({ sessionID, text })
  await harness.opencode.sessions.wait({ sessionID })
}
