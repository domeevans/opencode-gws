import { spawn } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import ts from "typescript"
import { afterEach, describe, expect, it, vi } from "vitest"
import { AUDIT_MAX_BYTES, Audit, auditErrorCode } from "../src/domain/audit.js"
import { GwsError } from "../src/domain/errors.js"

const cleanup: (() => void)[] = []
afterEach(() => { for (const fn of cleanup.splice(0)) fn(); vi.useRealTimers(); vi.restoreAllMocks() })
function audit(write?: (line: string, signal: AbortSignal) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "gws-audit-")), path = join(dir, "audit.jsonl")
  const sink = new Audit({ enabled: true, sink: "jsonl", path }, "test", write)
  cleanup.push(() => { sink.close?.(); rmSync(dir, { force: true, recursive: true }) })
  return { sink, path }
}

// Exercise the real Audit implementation in an isolated process: an unhandled
// stream error must fail this test, rather than being caught by the test runner.
const compile = (file: string) =>
  ts.transpileModule(readFileSync(new URL(file, import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
const compiled = compile("../src/domain/audit.ts")
const errors = compile("../src/domain/errors.ts")
const code = `
const moduleErrors = {exports:{}};
new Function('require','module','exports', ${JSON.stringify(errors)})(require, moduleErrors, moduleErrors.exports);
const moduleAudit = {exports:{}};
new Function('require','module','exports', ${JSON.stringify(compiled)})(id => id === './manifest.js' ? { commandIndex: () => ({methods:new Map(), helpers:new Map()}) } : id === './errors.js' ? moduleErrors.exports : require(id), moduleAudit, moduleAudit.exports);
const sink = new moduleAudit.exports.Audit({enabled:true,sink:'stderr'},'test');
process.on('uncaughtExceptionMonitor', error => console.log(JSON.stringify({uncaught:error.code})));
process.stdin.once('data', () => {
  sink.emit({event:'plugin.loaded',outcome:'success'});
  setTimeout(() => { console.log(JSON.stringify({degraded:sink.degraded})); sink.close(); }, 250);
});
console.log('ready');
`

async function run(closedPipe: boolean): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, ["-e", code], { env: { PATH: "/usr/bin:/bin" }, stdio: ["pipe", "pipe", "pipe"] })
  let stdout = "", stderr = "", sent = false
  const timeout = setTimeout(() => child.kill("SIGKILL"), 5_000)
  child.stderr.on("data", chunk => { stderr += chunk })
  child.stdout.on("data", chunk => {
    stdout += chunk
    if (sent || !stdout.includes("ready")) return
    sent = true
    if (closedPipe) {
      child.stderr.once("close", () => child.stdin.end("go"))
      child.stderr.destroy()
    } else child.stdin.end("go")
  })
  try {
    return await new Promise((resolve, reject) => {
      child.once("error", reject)
      child.once("close", code => resolve({ code, stdout, stderr }))
    })
  } finally { clearTimeout(timeout) }
}

describe("audit sink", () => {
  it("projects known fields and fixed error codes instead of arbitrary error text", async () => {
    const { sink, path } = audit()
    sink.emit({ event: "operation.read", outcome: "error", operation: "drive.files.get", errorCode: "AUTH_REQUIRED: PRIVATE_TOKEN", body: "PRIVATE_BODY", reason: "PRIVATE_REASON" } as never)
    await vi.waitFor(() => expect(readFileSync(path, "utf8")).toContain("operation.read"), { timeout: 5000 })
    const text = readFileSync(path, "utf8")
    expect(text).not.toContain("PRIVATE_")
    expect(JSON.parse(text).errorCode).toBe("UNKNOWN_ERROR")
    sink.emit({ event: "PRIVATE_EVENT", outcome: "error", operation: "PRIVATE_OPERATION" } as never)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(readFileSync(path, "utf8")).not.toContain("PRIVATE_")
  })

  it("records caller rpc and drops any other caller value", async () => {
    const { sink, path } = audit()
    sink.emit({ event: "operation.read", outcome: "success", caller: "rpc" })
    sink.emit({ event: "operation.read", outcome: "success", caller: "PRIVATE_CALLER" } as never)
    await vi.waitFor(() => expect(readFileSync(path, "utf8").trim().split("\n")).toHaveLength(2), { timeout: 5000 })
    const [rpc, other] = readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line))
    expect(rpc.caller).toBe("rpc")
    expect(other).not.toHaveProperty("caller")
  })

  it("makes a failed sink observably degraded without throwing into successful work", async () => {
    const { sink } = audit(async () => { throw new Error("PRIVATE_FAILURE") })
    expect(() => sink.emit({ event: "plugin.loaded", outcome: "success" })).not.toThrow()
    await vi.waitFor(() => expect(sink.degraded).toBe(true), { timeout: 5000 })
  })

  it("bounds a stalled sink to one active write and a finite queue, then drops queued work", async () => {
    vi.useFakeTimers()
    let writes = 0, signal: AbortSignal | undefined
    const { sink } = audit(async (_line, control) => { writes++; signal = control; await new Promise(() => {}) })
    for (let i = 0; i < 1_000; i++) sink.emit({ event: "plugin.loaded", outcome: "success" })
    await vi.advanceTimersByTimeAsync(101)
    expect(sink.degraded).toBe(true)
    expect(writes).toBe(1)
    expect(signal?.aborted).toBe(true)
    sink.emit({ event: "plugin.loaded", outcome: "success" })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(writes).toBe(1)
  })

  it("extracts only recognized runtime error prefixes", () => {
    expect(auditErrorCode(new GwsError("API_DISABLED", "PRIVATE_DETAIL", { enableUrl: "https://console.cloud.google.com/x" }))).toBe("API_DISABLED")
    expect(auditErrorCode(new Error("AUTH_REQUIRED: PRIVATE_DETAIL"))).toBe("AUTH_REQUIRED")
    expect(auditErrorCode(new Error("NOT_A_CODE: PRIVATE_DETAIL"))).toBe("UNKNOWN_ERROR")
    expect(auditErrorCode(new Error("PRIVATE_DETAIL"))).toBe("UNKNOWN_ERROR")
    expect(auditErrorCode({ message: "PRIVATE_DETAIL" })).toBe("UNKNOWN_ERROR")
  })

  it("stores only codes from the error table", async () => {
    const lines: string[] = []
    const { sink } = audit(async (line) => { lines.push(line) })
    sink.emit({ event: "operation.read", outcome: "error", errorCode: "GWS_DISCOVERY_ERROR" })
    sink.emit({ event: "operation.read", outcome: "error", errorCode: "NOT_A_CODE" })
    await vi.waitFor(() => expect(lines).toHaveLength(2), { timeout: 5000 })
    expect(lines.map((line) => JSON.parse(line).errorCode)).toEqual(["GWS_DISCOVERY_ERROR", "UNKNOWN_ERROR"])
  })

  it("does not start queued or future writes after close, even when the in-flight sink settles late", async () => {
    let done!: () => void
    const writer = vi.fn(async () => { await new Promise<void>(resolve => { done = resolve }) })
    const { sink } = audit(writer)
    sink.emit({ event: "plugin.loaded", outcome: "success" })
    sink.emit({ event: "plugin.loaded", outcome: "success" })
    await Promise.resolve()
    sink.close()
    done()
    sink.emit({ event: "plugin.loaded", outcome: "success" })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(writer).toHaveBeenCalledTimes(1)
    expect(sink.degraded).toBe(true)
  })
})

describe("audit to stderr", () => {
  it("contains a real closed-stderr EPIPE and reports degradation without crashing", async () => {
    const result = await run(true)
    expect(result.stdout).not.toContain("uncaught")
    expect(result.stdout).toContain('"degraded":true')
    expect(result.code).toBe(0)
  }, 10_000)

  it("writes a complete audit record to a healthy stderr pipe", async () => {
    const result = await run(false)
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('"degraded":false')
    expect(result.stderr).toMatch(/^\[opencode-gws\] .*"event":"plugin.loaded".*\n$/)
  }, 10_000)
})

describe("audit file rotation", () => {
  it("moves a full audit.jsonl to audit.jsonl.1 and starts a new one, keeping one previous file", async () => {
    expect(AUDIT_MAX_BYTES).toBe(5 * 1024 * 1024)
    const { sink, path } = audit()
    writeFileSync(path, `${"x".repeat(AUDIT_MAX_BYTES - 10)}\n`)
    writeFileSync(`${path}.1`, "older\n")
    sink.emit({ event: "plugin.loaded", outcome: "success" })
    await vi.waitFor(() => expect(existsSync(path) && readFileSync(path, "utf8").includes("plugin.loaded")).toBe(true))
    expect(readFileSync(path, "utf8").split("\n").filter(Boolean)).toHaveLength(1)
    expect(statSync(`${path}.1`).size).toBe(AUDIT_MAX_BYTES - 9)
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })
})

