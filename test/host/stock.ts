import { execFileSync, spawn, type ChildProcess } from "node:child_process"
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomBytes, randomUUID } from "node:crypto"
import { network } from "./setup.js"
import { REPO } from "./package.js"

/**
 * A stock OpenCode `opencode serve` for the tools RPC host tests, isolated exactly as the pack test's stock hosts are:
 * HOME, the four XDG variables, OPENCODE_TEST_HOME and TMPDIR inside a fresh root, a dead proxy, no model fetch, and a
 * `debug paths` check that every path resolves inside the root.
 *
 * The plugin is loaded from this checkout's built `dist/` (run `npm run build` first) in one project only, with the
 * fake gws fixture as its binary, so a call's argv proves whether the server ran. The server's default location is the
 * serve working directory, where the plugin is not loaded: a call without a location is the location-error case.
 */

/** The versions the family tests, TESTED_HOSTS in src/domain/host.ts. */
export const TESTED_HOSTS = ["2.2.3", "2.2.4", "2.2.5", "2.2.6"] as const
/** The stock binary for a version, from OPENCODE_BIN_<version> ("" when unset). The host suite never guesses a path. */
export function binary(version: string): string {
  return process.env[`OPENCODE_BIN_${version.replaceAll(".", "_")}`] ?? ""
}

export const available = (version: string) => binary(version) !== "" && existsSync(binary(version))

export const ACCOUNT = "personal"

const AGENTS = {
  locked: { description: "deny every gws tool", mode: "primary", permissions: [{ action: "gws.*", resource: "*", effect: "deny" }] },
  careful: { description: "ask for every gws read", mode: "primary", permissions: [{ action: "gws.read", resource: "*", effect: "ask" }] },
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer().once("error", reject).listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number }
      server.close(() => resolve(port))
    })
  })
}

export interface StockHost {
  readonly root: string
  readonly project: string
  readonly port: number
  readonly bin: string
  api(method: string, path: string, body?: unknown, location?: string, headers?: Record<string, string>): Promise<{ status: number; data: unknown }>
  /** `opencode api` against this server, in the isolated environment. */
  cli(args: string[], cwd?: string): { status: number; out: string }
  /** Every account-scoped argv the fake gws received, in order. */
  invocations(): string[][]
  close(): Promise<void>
}

export async function startStock(version: string): Promise<StockHost> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `opencode-gws-rpc-${version}-`)))
  const home = join(root, "home")
  const project = join(root, "project")
  for (const dir of [home, project, join(root, "tmp"), join(home, ".config/opencode"), join(home, ".local/share"), join(home, ".local/state"), join(home, ".cache")]) mkdirSync(dir, { recursive: true })

  // The launcher lives in the repository: gws's binary trust rejects a world-writable ancestor such as /tmp.
  const launcherRoot = realpathSync(mkdtempSync(join(REPO, ".fake-gws-rpc-")))
  const log = join(root, "invocations.jsonl")
  const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`
  const launcher = join(launcherRoot, "gws")
  writeFileSync(launcher, `#!/bin/sh\nFAKE_GWS_LOG=${quote(log)} exec ${quote(process.execPath)} ${quote(join(REPO, "test/fixtures/fake-gws.mjs"))} "$@"\n`, { mode: 0o700 })

  const env: Record<string, string> = {
    PATH: "/usr/bin:/bin",
    HOME: home,
    OPENCODE_TEST_HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local/share"),
    XDG_STATE_HOME: join(home, ".local/state"),
    XDG_CACHE_HOME: join(home, ".cache"),
    TMPDIR: join(root, "tmp"),
    LANG: "en_US.UTF-8",
    OPENCODE_PASSWORD: randomBytes(24).toString("hex"),
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_FREE_MODELS: "1",
    OPENCODE_DISABLE_CLAUDE_CODE: "1",
    OPENCODE_DISABLE_FILEWATCHER: "1",
    HTTP_PROXY: "http://127.0.0.1:9",
    HTTPS_PROXY: "http://127.0.0.1:9",
    http_proxy: "http://127.0.0.1:9",
    https_proxy: "http://127.0.0.1:9",
    NO_PROXY: "127.0.0.1,localhost",
    no_proxy: "127.0.0.1,localhost",
    GWS_TEST_TOKEN: "fake-access-token",
  }
  const bin = binary(version)

  // Isolation first: every path the binary reports is inside the root.
  const paths = execFileSync(bin, ["debug", "paths"], { env, cwd: project, encoding: "utf8" }).trim()
  const listed = paths
    .split("\n")
    .flatMap((line) => {
      const value = line.trim().split(/\s+/).slice(1).join(" ")
      return value ? [value] : []
    })
  const outside = listed.filter((path) => !path.startsWith(root) && !path.startsWith(join("/private", root)))
  if (listed.length < 8 || outside.length > 0) throw new Error(`isolation failed: ${paths}`)

  const options = {
    binary: { path: launcher },
    accounts: { [ACCOUNT]: { mode: "access_token", tokenEnv: "GWS_TEST_TOKEN", enabledServices: ["gmail", "drive"] } },
    audit: { enabled: false },
    // The ask refusal is the RPC path's own case: at ask-changes a commit needs a rule the session does not have.
    access: "ask-changes",
  }
  const providers = { lmstudio: { settings: { baseURL: "" } }, ollama: { settings: { baseURL: "" } }, vllm: { settings: { baseURL: "" } } }
  writeFileSync(join(home, ".config/opencode/opencode.json"), JSON.stringify({ agents: AGENTS }, null, 2))
  writeFileSync(join(project, "opencode.json"), JSON.stringify({ plugins: [{ package: REPO, options }], agents: AGENTS, providers }, null, 2))

  const port = await freePort()
  // The host-suite fetch guard allows only registered loopback origins.
  const revokeOrigin = network.allow(`http://127.0.0.1:${port}`)
  const authorization = `Basic ${Buffer.from(`opencode:${env.OPENCODE_PASSWORD}`).toString("base64")}`
  let server: ChildProcess | undefined
  const host: StockHost = {
    root,
    project,
    port,
    bin,
    async api(method, path, body, location, headers = {}) {
      const url = new URL(path, `http://127.0.0.1:${port}`)
      if (location) url.searchParams.set("location[directory]", location)
      const response = await fetch(url, { method, headers: { authorization, "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
      const text = await response.text()
      let data: unknown = text
      try {
        data = JSON.parse(text)
      } catch {}
      return { status: response.status, data }
    },
    cli(args, cwd) {
      try {
        const out = execFileSync(bin, ["api", "--server", `http://127.0.0.1:${port}`, ...args], { env, cwd: cwd ?? root, encoding: "utf8", timeout: 30_000 })
        return { status: 0, out }
      } catch (error) {
        const e = error as { status?: number; stdout?: string; stderr?: string }
        return { status: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` }
      }
    },
    invocations: () =>
      existsSync(log)
        ? readFileSync(log, "utf8")
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line) as string[])
            .filter((argv) => argv[0] !== "--version" && argv[0] !== "schema")
        : [],
    async close() {
      if (server && server.exitCode === null && server.signalCode === null) {
        const exited = new Promise((resolve) => server!.once("exit", resolve))
        try {
          process.kill(-server.pid!, "SIGTERM")
        } catch {}
        const done = await Promise.race([exited.then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), 10_000))])
        if (!done) {
          try {
            process.kill(-server.pid!, "SIGKILL")
          } catch {}
          await exited
        }
      }
      revokeOrigin()
      rmSync(launcherRoot, { recursive: true, force: true })
      if (!process.env.KEEP) rmSync(root, { recursive: true, force: true })
    },
  }

  server = spawn(bin, ["serve", "--hostname", "127.0.0.1", "--port", String(port), "--print-logs", "--log-level", "info"], {
    cwd: root,
    env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  })
  const serverLog = join(root, "server.log")
  server.stdout!.on("data", (chunk) => appendFileSync(serverLog, chunk))
  server.stderr!.on("data", (chunk) => appendFileSync(serverLog, chunk))

  const deadline = Date.now() + 90_000
  for (;;) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/openapi.json`, { headers: { authorization } })
      if (response.ok) break
    } catch {}
    if (Date.now() > deadline) throw new Error(`the server did not answer; log: ${serverLog}`)
    await new Promise((resolve) => setTimeout(resolve, 200))
  }

  // Load the project location and wait for the plugin to finish loading there.
  const ready = Date.now() + 90_000
  for (;;) {
    const listed = await host.api("GET", "/api/plugin", undefined, project)
    const entry = ((listed.data as { data?: unknown })?.data ?? listed.data) as { id?: string; state?: { status?: string } }[] | undefined
    const plugin = Array.isArray(entry) ? entry.find((item) => item.id === "google-workspace.gws") : undefined
    if (plugin?.state?.status === "active") break
    if (plugin?.state?.status && plugin.state.status !== "loading") throw new Error(`the plugin failed to load: ${JSON.stringify(plugin.state)}; log: ${serverLog}`)
    if (Date.now() > ready) throw new Error(`the plugin did not finish loading; log: ${serverLog}`)
    await new Promise((resolve) => setTimeout(resolve, 250))
  }

  // The tools RPC registers after the tools; wait until describe answers.
  const registered = Date.now() + 60_000
  for (;;) {
    const described = await host.api("POST", "/api/rpc/google-workspace.gws.tools/describe", { input: {} }, project)
    if (described.status === 200) break
    if (Date.now() > registered) throw new Error(`the tools RPC did not register; log: ${serverLog}`)
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  return host
}

/** A session in the project, with optional session rules. */
export async function session(host: StockHost, agent: string, permissions?: readonly { action: string; resource: string; effect: string }[]): Promise<string> {
  const created = await host.api("POST", "/api/session", { title: `rpc-${agent}-${randomUUID().slice(0, 6)}`, agent, ...(permissions ? { permissions } : {}) }, host.project)
  const data = ((created.data as { data?: unknown })?.data ?? created.data) as { id?: string }
  if (!data.id) throw new Error(`no session id: ${JSON.stringify(created.data)}`)
  return data.id
}

/** A call to a tools RPC method in the project. */
export function rpc(host: StockHost, method: string, sessionID: string, input: unknown = {}, location = host.project) {
  return host.api("POST", `/api/rpc/google-workspace.gws.tools/${method}`, { input: { sessionID, ...(input === undefined ? {} : { input }) } }, location)
}
