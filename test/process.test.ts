import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { errorFromProcess, isApiError, parseResult } from "../src/domain/result.js"
import { buildChildEnv, localEnv } from "../src/process/env.js"
import { runProcess, type RunOptions } from "../src/process/run.js"
import { SchemaClient } from "../src/process/schema.js"
import { account, testConfig } from "./support/config.js"

let dir: string
let sleeper: string
let pages: string
let pidFile: string

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "opencode-gws-process-"))
  sleeper = join(dir, "sleeper")
  pages = join(dir, "pages")
  pidFile = join(dir, "child.pid")
  // The grandchild `sleep` must die too: the kill targets the process group.
  writeFileSync(sleeper, `#!/bin/sh\nsleep 30 &\necho $! > '${pidFile}'\nwait\n`)
  writeFileSync(pages, `#!/bin/sh\nprintf '{"p":1}\\n'\nsleep 0.05\nprintf '{"p":2}\\n'\n`)
  chmodSync(sleeper, 0o755)
  chmodSync(pages, 0o755)
})

afterAll(() => rmSync(dir, { recursive: true, force: true }))

function options(binary: string, overrides: Partial<RunOptions> = {}): RunOptions {
  return { binary, argv: [], cwd: dir, env: { PATH: process.env["PATH"] ?? "" }, timeoutMs: 10_000, maxStdoutBytes: 1024, maxStderrBytes: 1024, ...overrides }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out")
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

describe("runProcess", () => {
  it("kills the whole process group on abort and rejects with CANCELLED", async () => {
    rmSync(pidFile, { force: true })
    const controller = new AbortController()
    const pending = runProcess(options(sleeper, { signal: controller.signal }))
    await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim().length > 0)
    const grandchild = Number(readFileSync(pidFile, "utf8").trim())
    controller.abort()
    await expect(pending).rejects.toThrow(/^CANCELLED:/)
    await waitFor(() => !alive(grandchild))
  })

  it("rejects without spawning when already aborted", async () => {
    rmSync(pidFile, { force: true })
    await expect(runProcess(options(sleeper, { signal: AbortSignal.abort() }))).rejects.toThrow(/^CANCELLED:/)
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(existsSync(pidFile)).toBe(false)
  })

  it("streams stdout chunks to onStdout", async () => {
    const chunks: string[] = []
    const result = await runProcess(options(pages, { onStdout: (chunk) => chunks.push(chunk.toString("utf8")) }))
    expect(result.exitCode).toBe(0)
    expect(chunks.join("")).toBe('{"p":1}\n{"p":2}\n')
  })

  it("reports a timeout as TIMEOUT, not an API error", async () => {
    const result = await runProcess(options(sleeper, { timeoutMs: 100 }))
    expect(result.timedOut).toBe(true)
    expect(errorFromProcess(result, parseResult(result, { maxInlineBytes: 1024 }))).toMatch(/^TIMEOUT:/)
  })
})

describe("fake gws fixture", () => {
  const fake = join(import.meta.dirname, "fixtures", "fake-gws.mjs")
  const gws = (argv: string[], env: Record<string, string>) =>
    runProcess({ binary: process.execPath, argv: [fake, ...argv], cwd: dir, env, timeoutMs: 10_000, maxStdoutBytes: 64 * 1024, maxStderrBytes: 1024 })

  it("reports gws 0.22.5, logs every invocation to FAKE_GWS_LOG, and account-scoped ones to the account directory", async () => {
    const log = join(dir, "invocations.jsonl")
    const account = mkdtempSync(join(dir, "account-"))
    rmSync(log, { force: true })
    const env = { FAKE_GWS_LOG: log, GOOGLE_WORKSPACE_CLI_CONFIG_DIR: account }
    const version = await gws(["--version"], env)
    expect(version.stdout.toString().split("\n")[0]).toBe("gws 0.22.5")
    await gws(["gmail", "users", "messages", "list", "--params", "{}"], env)
    await gws(["gmail", "users", "labels", "create", "--dry-run"], env)
    const lines = (path: string) => readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line))
    const scoped = [
      ["gmail", "users", "messages", "list", "--params", "{}"],
      ["gmail", "users", "labels", "create", "--dry-run"],
    ]
    expect(lines(log)).toEqual([["--version"], ...scoped])
    expect(lines(join(account, "invocations.jsonl"))).toEqual(scoped)
  })

  it.each([
    ["api", 1, "GWS_API_ERROR"],
    ["auth", 2, "AUTH_REQUIRED"],
    ["scope", 1, "AUTH_SCOPE_MISSING"],
    ["disabled", 1, "API_DISABLED"],
    ["validation", 3, "GWS_VALIDATION_ERROR"],
  ])("FAKE_GWS_FAIL=%s fails account-scoped calls with exit %s, read as %s", async (kind, exit, code) => {
    const result = await gws(["drive", "files", "list"], { FAKE_GWS_FAIL: kind })
    expect(result.exitCode).toBe(exit)
    const parsed = parseResult(result, { maxInlineBytes: 64 * 1024 })
    expect(isApiError(parsed.data)).toBe(true)
    expect(errorFromProcess(result, parsed)).toMatch(new RegExp(`^${code}: `))
    const version = await gws(["--version"], { FAKE_GWS_FAIL: kind })
    expect(version.exitCode).toBe(0)
  })
})

describe("SchemaClient", () => {
  it("threads the abort signal into gws schema", async () => {
    const client = new SchemaClient(sleeper, dir, { PATH: process.env["PATH"] ?? "" })
    const controller = new AbortController()
    const pending = client.resolve("gmail", ["users", "getProfile"], controller.signal)
    setTimeout(() => controller.abort(), 50)
    await expect(pending).rejects.toThrow(/^CANCELLED:/)
  })
})

describe("child home isolation", () => {
  const ambientDirs: string[] = []
  const scratch = () => {
    const created = mkdtempSync(join(tmpdir(), "opencode-gws-isolation-"))
    ambientDirs.push(created)
    return created
  }
  afterEach(() => {
    vi.unstubAllEnvs()
    for (const created of ambientDirs.splice(0)) rmSync(created, { recursive: true, force: true })
  })

  it("cannot discover a synthetic ambient ADC file through HOME or XDG paths", async () => {
    const ambient = scratch(), work = scratch(), accountHome = scratch()
    const adc = join(ambient, ".config/gcloud/application_default_credentials.json")
    mkdirSync(dirname(adc), { recursive: true })
    writeFileSync(adc, '{"fixture":true}')
    for (const name of ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME"]) vi.stubEnv(name, ambient)
    vi.stubEnv("GOOGLE_APPLICATION_CREDENTIALS", adc)
    vi.stubEnv("GOOGLE_WORKSPACE_CLI_TOKEN", "ambient-fixture-token")
    const profile = testConfig({ accounts: { test: account({ services: ["drive"] }) }, audit: { enabled: false } }).accounts.test!
    const environments = [localEnv(work), buildChildEnv(profile, accountHome, work)]
    for (const env of environments) {
      expect(env.HOME).toBe(join(work, "home"))
      expect(env.GOOGLE_APPLICATION_CREDENTIALS).toBeUndefined()
      expect(env.GOOGLE_WORKSPACE_CLI_TOKEN).toBeUndefined()
      const result = await runProcess({ binary: process.execPath,
        argv: ["--input-type=module", "-e", "import{existsSync}from'node:fs';import{join}from'node:path';console.log(JSON.stringify({adc:existsSync(join(process.env.HOME,'.config/gcloud/application_default_credentials.json'))}))"],
        cwd: work, env, timeoutMs: 5000, maxStdoutBytes: 1024, maxStderrBytes: 1024 })
      expect(result.exitCode).toBe(0)
      expect(JSON.parse(result.stdout.toString())).toEqual({ adc: false })
    }
    expect(environments[0]!.GOOGLE_WORKSPACE_CLI_CONFIG_DIR).toBe(join(work, "discovery"))
    expect(environments[1]!.GOOGLE_WORKSPACE_CLI_CONFIG_DIR).toBe(accountHome)
    expect(existsSync(adc)).toBe(true)
  })
})
