import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { join } from "node:path"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"
import type { Request } from "../src/domain/types.js"
import type { Runtime } from "../src/runtime/index.js"
import { account, testRuntime } from "./support/config.js"
import { request } from "./support/requests.js"

// A fake gws that enforces the real CLI's rule: --upload, --output, and -a
// paths must be relative and inside the cwd. It records each call's cwd and
// the bytes it saw, writes downloads from a control file, and can block.
let dir: string
let binary: string
let log: string
let control: string
let blocked: string

const ctx = { sessionId: "ses_1", agentId: "build" }

beforeAll(() => {
  dir = mkdtempSync(join(process.cwd(), ".files-test-"))
  binary = join(dir, "gws")
  log = join(dir, "calls.log")
  control = join(dir, "download.bin")
  blocked = join(dir, "block")
  writeFileSync(
    binary,
    `#!/bin/sh
if [ "$1" = "--version" ]; then echo "gws 0.22.5"; exit 0; fi
echo "cwd=$(pwd -P) argv=$*" >> '${log}'
dry=0; out=""
for arg in "$@"; do [ "$arg" = "--dry-run" ] && dry=1; done
while [ $# -gt 0 ]; do
  case "$1" in
    --upload|--output|-a)
      flag="$1"; path="$2"; shift
      case "$path" in
        /*|*..*) printf '{"error":{"code":400,"message":"%s %s resolves outside the current directory"}}' "$flag" "$path"; exit 3;;
      esac
      if [ "$flag" = "--output" ]; then out="$path"; else
        [ -f "$path" ] || { printf '{"error":{"code":400,"message":"missing %s"}}' "$path"; exit 3; }
        echo "read $path $(cat "$path")" >> '${log}'
      fi;;
  esac
  shift
done
if [ -f '${blocked}' ]; then echo "blocked" >> '${log}'; exec sleep 30; fi
if [ $dry = 1 ]; then printf '{"dry_run":true}'; exit 0; fi
if [ -n "$out" ]; then cp '${control}' "$out"; printf '{"status":"success","saved_file":"%s"}' "$out"; exit 0; fi
printf '{"id":"file-1"}'
`,
  )
  chmodSync(binary, 0o755)
})

afterAll(() => rmSync(dir, { recursive: true, force: true }))

let roots: { read: string; write: string; outside: string }
let runtime: Runtime | undefined

beforeEach(() => {
  writeFileSync(log, "")
  writeFileSync(control, "downloaded bytes")
  rmSync(blocked, { force: true })
  const base = mkdtempSync(join(dir, "roots-"))
  roots = { read: join(base, "read"), write: join(base, "write"), outside: join(base, "outside") }
  for (const path of Object.values(roots)) mkdirSync(path)
})

afterEach(() => {
  runtime?.close()
  runtime = undefined
})

async function setup(execution: Record<string, unknown> = {}, rules: unknown[] = []): Promise<Runtime> {
  runtime = await testRuntime({
    binary: { path: binary },
    accounts: { personal: account({ services: ["drive", "gmail"] }) },
    policy: { rules },
    execution: { allowedReadRoots: [roots.read], allowedWriteRoots: [roots.write], ...execution },
  })
  return runtime
}

function upload(path: string): Request {
  return request("drive.files.create", { body: { name: "notes.txt" }, upload: { path, mime: "text/plain" } })
}

function download(path: string, overwrite?: boolean): Request {
  return request("drive.files.get", { params: { fileId: "file-1", alt: "media" }, download: { path, overwrite } })
}

function calls(): string[] {
  return readFileSync(log, "utf8").split("\n").filter(Boolean)
}

function stages(rt: Runtime): string[] {
  return readdirSync(rt.workDir).filter((name) => name.startsWith("call-"))
}

const sha = (text: string) => createHash("sha256").update(text).digest("hex")

describe("upload staging", () => {
  it("passes gws a relative staged copy at plan and at commit, and cleans up", async () => {
    const rt = await setup()
    const source = join(roots.read, "notes.txt")
    writeFileSync(source, "hello")
    const plan = await rt.plan(upload(source), ctx)
    expect(plan.preview.uploads).toEqual([source])
    const result = await rt.commit("write", { planId: plan.planId }, ctx)
    expect(result.result).toEqual({ id: "file-1" })

    const log = calls()
    const invocations = log.filter((line) => line.startsWith("cwd="))
    expect(invocations).toHaveLength(2)
    for (const line of invocations) {
      expect(line).toContain("--upload in/0/notes.txt --upload-content-type text/plain")
      expect(line).not.toContain(roots.read)
      expect(line).toContain(`cwd=${realpathSync(rt.workDir)}/call-`)
    }
    expect(log.filter((line) => line === "read in/0/notes.txt hello")).toHaveLength(2)
    expect(stages(rt)).toEqual([])
  })

  it("refuses a commit when the file changed after planning, and expires the plan", async () => {
    const rt = await setup()
    const source = join(roots.read, "notes.txt")
    writeFileSync(source, "hello")
    const plan = await rt.plan(upload(source), ctx)
    writeFileSync(source, "HELLO")
    await expect(rt.commit("write", { planId: plan.planId }, ctx)).rejects.toThrow(/^UPLOAD_CHANGED:/)
    expect(calls().filter((line) => line.startsWith("cwd="))).toHaveLength(1)
    await expect(rt.commit("write", { planId: plan.planId }, ctx)).rejects.toThrow(/PLAN_EXPIRED/)
    expect(stages(rt)).toEqual([])
  })

  it("refuses paths outside the read roots, including through a symlink", async () => {
    const rt = await setup()
    const secret = join(roots.outside, "secret.txt")
    writeFileSync(secret, "secret")
    await expect(rt.plan(upload(secret), ctx)).rejects.toThrow(/^POLICY_DENIED:.*outside allowed read roots/)
    const link = join(roots.read, "link.txt")
    symlinkSync(secret, link)
    await expect(rt.plan(upload(link), ctx)).rejects.toThrow(/^POLICY_DENIED: Upload path .* resolves outside allowed read roots/)
    expect(calls()).toEqual([])
    expect(stages(rt)).toEqual([])
  })

  it("applies policy-rule read roots to the resolved path as well", async () => {
    const narrow = join(roots.read, "narrow")
    mkdirSync(narrow)
    const rt = await setup({}, [{ id: "narrow", effect: "deny", categories: ["write"], allowedReadRoots: [narrow] }])
    const wide = join(roots.read, "wide.txt")
    writeFileSync(wide, "x")
    symlinkSync(wide, join(narrow, "alias.txt"))
    await expect(rt.plan(upload(join(narrow, "alias.txt")), ctx)).rejects.toThrow(/^POLICY_DENIED: Upload path/)
  })

  it("refuses non-regular files and enforces maxUploadBytes", async () => {
    const rt = await setup({ maxUploadBytes: 4 })
    await expect(rt.plan(upload(roots.read), ctx)).rejects.toThrow(/^UPLOAD_INVALID:.*not a regular file/)
    await expect(rt.plan(upload(join(roots.read, "missing.txt")), ctx)).rejects.toThrow(/^UPLOAD_INVALID:.*does not exist/)
    const big = join(roots.read, "big.txt")
    writeFileSync(big, "12345")
    await expect(rt.plan(upload(big), ctx)).rejects.toThrow(/^UPLOAD_LIMIT:/)
    expect(calls()).toEqual([])
    expect(stages(rt)).toEqual([])
  })

  it("stages gmail attachments for a helper plan", async () => {
    const rt = await setup()
    const a = join(roots.read, "a.txt")
    writeFileSync(a, "alpha")
    const plan = await rt.plan(request("gmail.send", { input: { to: "a@example.com", subject: "s", body: "b", attachments: [a] } }), ctx)
    expect(plan.preview.uploads).toEqual([a])
    expect(calls()).toContain("read in/0/a.txt alpha")
  })
})

describe("download delivery", () => {
  it("writes to a staged relative path, then delivers to the destination", async () => {
    const rt = await setup()
    const destination = join(roots.write, "out.bin")
    const plan = await rt.plan(download(destination), ctx)
    expect(plan.category).toBe("export")
    const result = await rt.commit("export", { planId: plan.planId }, ctx)
    expect(readFileSync(destination, "utf8")).toBe("downloaded bytes")
    expect(result.file).toEqual({ path: destination, bytes: 16, sha256: sha("downloaded bytes") })
    for (const line of calls()) expect(line).toContain("--output out/out.bin")
    expect(stages(rt)).toEqual([])
  })

  it("refuses to overwrite unless download.overwrite is true", async () => {
    const rt = await setup()
    const destination = join(roots.write, "out.bin")
    writeFileSync(destination, "keep me")
    await expect(rt.plan(download(destination), ctx)).rejects.toThrow(/^DOWNLOAD_EXISTS:/)
    expect(calls()).toEqual([])

    const plan = await rt.plan(download(destination, true), ctx)
    expect(plan.preview.overwrite).toBe(true)
    await rt.commit("export", { planId: plan.planId }, ctx)
    expect(readFileSync(destination, "utf8")).toBe("downloaded bytes")
  })

  it("refuses at commit, leaving the plan ready, when the file appeared after planning", async () => {
    const rt = await setup()
    const destination = join(roots.write, "late.bin")
    const plan = await rt.plan(download(destination), ctx)
    writeFileSync(destination, "arrived first")
    await expect(rt.commit("export", { planId: plan.planId }, ctx)).rejects.toThrow(/^DOWNLOAD_EXISTS:/)
    expect(readFileSync(destination, "utf8")).toBe("arrived first")
    rmSync(destination)
    await rt.commit("export", { planId: plan.planId }, ctx)
    expect(readFileSync(destination, "utf8")).toBe("downloaded bytes")
  })

  it("refuses destinations outside the write roots, including through a symlinked parent", async () => {
    const rt = await setup()
    await expect(rt.plan(download(join(roots.outside, "x.bin")), ctx)).rejects.toThrow(/^POLICY_DENIED:/)
    const escaping = join(roots.write, "escape")
    symlinkSync(roots.outside, escaping)
    await expect(rt.plan(download(join(escaping, "x.bin")), ctx)).rejects.toThrow(/^POLICY_DENIED: Download path .* resolves outside allowed write roots/)
    await expect(rt.plan(download(join(roots.write, "missing", "x.bin")), ctx)).rejects.toThrow(/^DOWNLOAD_INVALID:/)
    expect(calls()).toEqual([])
  })

  it("enforces maxDownloadBytes before anything reaches the destination", async () => {
    const rt = await setup({ maxDownloadBytes: 8 })
    const destination = join(roots.write, "big.bin")
    const plan = await rt.plan(download(destination), ctx)
    await expect(rt.commit("export", { planId: plan.planId }, ctx)).rejects.toThrow(/^DOWNLOAD_LIMIT:/)
    expect(existsSync(destination)).toBe(false)
    expect(stages(rt)).toEqual([])
  })

  it("removes the staging directory when a commit is cancelled", async () => {
    const rt = await setup()
    const source = join(roots.read, "notes.txt")
    writeFileSync(source, "hello")
    const plan = await rt.plan(upload(source), ctx)
    writeFileSync(blocked, "")
    const controller = new AbortController()
    const pending = rt.commit("write", { planId: plan.planId }, { ...ctx, signal: controller.signal })
    for (let i = 0; i < 100 && !calls().includes("blocked"); i++) await new Promise((resolve) => setTimeout(resolve, 20))
    expect(stages(rt)).toHaveLength(1)
    controller.abort()
    await expect(pending).rejects.toThrow(/^CANCELLED:/)
    expect(stages(rt)).toEqual([])
  })
})
