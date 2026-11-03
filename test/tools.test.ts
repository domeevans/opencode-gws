import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { z } from "zod"
import { Error as ToolError } from "@opencode/plugin/promise/tool"
import { CommitInput, RequestInput } from "../src/domain/contract.js"
import type { PermissionRequest } from "../src/host/permissions.js"
import { statusSource } from "../src/host/rpc.js"
import { NAMESPACE, registerTools, render } from "../src/host/tools.js"
import type { Runtime } from "../src/runtime/index.js"
import { account, testRuntime } from "./support/config.js"
import { request } from "./support/requests.js"

interface Result {
  output: Record<string, unknown>
  content: string
  metadata: Record<string, unknown>
}

interface RegisteredTool {
  name: string
  description: string
  input: z.ZodType
  output: z.ZodType
  options: { namespace: string; permission: string; codemode: boolean; pinned?: boolean }
  execute: (input: unknown, context: Record<string, unknown>) => Promise<Result>
}

// The fake gws lives under the repo, not os.tmpdir(): binary trust rejects
// world-writable ancestors such as /tmp.
let dir: string
let binary: string
let slow: string
let failing: string
let failurePath: string
let log: string
let pidFile: string

const SCHEMA_JSON = JSON.stringify({
  httpMethod: "GET",
  path: "gmail/v1/users/{userId}/profile",
  scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
  parameterOrder: ["userId"],
  parameters: { userId: { type: "string", location: "path" } },
})

beforeAll(() => {
  dir = mkdtempSync(join(process.cwd(), ".tools-test-"))
  binary = join(dir, "gws")
  slow = join(dir, "gws-slow")
  failing = join(dir, "gws-failing")
  failurePath = join(dir, "failure")
  log = join(dir, "argv.log")
  pidFile = join(dir, "slow.pid")
  writeFileSync(
    binary,
    `#!/bin/sh\necho "$*" >> '${log}'\nif [ "$1" = "--version" ]; then echo "gws 0.22.5"; exit 0; fi\nif [ "$1" = "schema" ]; then printf '%s' '${SCHEMA_JSON}'; exit 0; fi\nprintf '{"messages":[{"id":"m1"}]}'\n`,
  )
  // Answers the version probe, then blocks until killed.
  writeFileSync(slow, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "gws 0.22.5"; exit 0; fi\necho $$ > '${pidFile}'\nexec sleep 30\n`)
  // Prints the failure file's first line as stdout and exits with its second line.
  writeFileSync(failing, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "gws 0.22.5"; exit 0; fi\n/usr/bin/head -n 1 '${failurePath}'\nexit "$(/usr/bin/sed -n 2p '${failurePath}')"\n`)
  for (const file of [binary, slow, failing]) chmodSync(file, 0o755)
})

afterAll(() => rmSync(dir, { recursive: true, force: true }))

function context(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { sessionID: "ses_1", agent: "build", messageID: "msg_1", id: "call_1", signal: new AbortController().signal, progress: async () => {}, ...overrides }
}

const sendRequest = request("gmail.users.messages.send", { params: { userId: "me" }, body: { raw: "c2VjcmV0IGJvZHk" } })

const listRequest = request("gmail.users.messages.list", { params: { userId: "me" }, fields: "messages(id)" })

interface Harness {
  runtime: Runtime
  tools: Map<string, RegisteredTool>
  namespaces: Array<{ name: string; description: string }>
  calls: PermissionRequest[]
  /** Arguments passed to each ctx.permission.assert call. */
  arities: number[]
  hooks: Array<[string, unknown]>
}

let harness: Harness | undefined

async function setup(
  policy: Record<string, unknown>,
  reject: (request: PermissionRequest) => boolean = () => false,
  options: {
    binary?: string
    maxInlineBytes?: number
    accounts?: Record<string, unknown>
    pending?: (request: PermissionRequest) => Promise<void> | undefined
  } = {},
): Promise<Harness> {
  writeFileSync(log, "")
  const runtime = await testRuntime({
    binary: { path: options.binary ?? binary },
    policy,
    execution: options.maxInlineBytes ? { maxInlineBytes: options.maxInlineBytes } : undefined,
    ...(options.accounts ? { accounts: options.accounts } : {}),
  })
  const tools = new Map<string, RegisteredTool>()
  const namespaces: Harness["namespaces"] = []
  const calls: PermissionRequest[] = []
  const arities: number[] = []
  const hooks: Array<[string, unknown]> = []
  const ctx = {
    tool: {
      transform: async (callback: (editor: unknown) => void) => {
        callback({
          add: (tool: RegisteredTool) => tools.set(tool.name, tool),
          namespace: (namespace: Harness["namespaces"][number]) => namespaces.push(namespace),
        })
      },
    },
    permission: {
      hook: async (name: string, callback: unknown) => {
        hooks.push([name, callback])
      },
      assert: async (...args: [PermissionRequest]) => {
        const [request] = args
        arities.push(args.length)
        calls.push(request)
        await options.pending?.(request)
        if (reject(request)) throw new Error(`PermissionRejected: ${request.action}`)
      },
    },
  }
  await registerTools(ctx as never, runtime, statusSource(runtime, async () => []))
  harness = { runtime, tools, namespaces, calls, arities, hooks }
  return harness
}

function tool(h: Harness, name: string): RegisteredTool {
  const found = h.tools.get(name)
  if (!found) throw new Error(`tool ${name} not registered`)
  return found
}

function gwsInvocations(): string[] {
  return existsSync(log) ? readFileSync(log, "utf8").split("\n").filter((line) => line && line !== "--version") : []
}

function commits(): string[] {
  return gwsInvocations().filter((line) => !line.includes("--dry-run"))
}

afterEach(() => {
  harness?.runtime.close()
  harness = undefined
})

describe("tool registration", () => {
  it("declares the gws namespace and eleven tools with input and output schemas", async () => {
    const h = await setup({})
    expect(h.namespaces).toEqual([NAMESPACE])
    expect(NAMESPACE.description).toMatch(/catalog.*schema.*read.*plan.*planId.*untrusted/s)
    expect([...h.tools.keys()]).toEqual(["status", "catalog", "schema", "read", "plan", "write", "send", "share", "delete", "export", "admin"])
    for (const registered of h.tools.values()) {
      expect(registered.options).toMatchObject({ namespace: "gws", permission: `gws.${registered.name}` })
      expect(registered.input).toBeInstanceOf(z.ZodType)
      expect(registered.output).toBeInstanceOf(z.ZodType)
      expect(registered.description.length).toBeGreaterThan(20)
    }
  })

  it("keeps commits and reads out of Code Mode and pins the entry points", async () => {
    const h = await setup({})
    const exposure = Object.fromEntries([...h.tools].map(([name, registered]) => [name, { codemode: registered.options.codemode, pinned: registered.options.pinned }]))
    expect(exposure).toEqual({
      status: { codemode: true, pinned: undefined },
      catalog: { codemode: true, pinned: true },
      schema: { codemode: true, pinned: undefined },
      read: { codemode: false, pinned: undefined },
      plan: { codemode: true, pinned: true },
      write: { codemode: false, pinned: undefined },
      send: { codemode: false, pinned: undefined },
      share: { codemode: false, pinned: undefined },
      delete: { codemode: false, pinned: undefined },
      export: { codemode: false, pinned: undefined },
      admin: { codemode: false, pinned: undefined },
    })
    // The host reserves `execute` for Code Mode, so no direct tool may take that name.
    expect(h.tools.has("execute")).toBe(false)
    // The Code Mode namespace text names gws_read as the direct tool it is, never as a Code Mode call.
    expect(NAMESPACE.description).toContain("the direct tool gws_read")
    expect(NAMESPACE.description).not.toMatch(/\bwith read\b/)
  })

  it("describes what each tool does without internal jargon, and names the direct commit tools", async () => {
    const h = await setup({})
    const texts = [NAMESPACE.description, ...[...h.tools.values()].map((registered) => registered.description)]
    for (const text of texts) expect(text).not.toMatch(/\b(?:No network|WS-[A-Z]|manifest hash|adapter|discovery kind|TODO)\b/i)
    for (const name of ["gws_write", "gws_send", "gws_share", "gws_delete", "gws_export", "gws_admin"]) {
      expect(NAMESPACE.description).toContain(name)
      expect(tool(h, "plan").description).toContain(name)
    }
    expect(tool(h, "status").description).toMatch(/sign-in/)
    expect(tool(h, "status").description).not.toMatch(/no network/i)
  })

  it("describes every input field the model sees", async () => {
    const h = await setup({})
    const undocumented: string[] = []
    const visit = (schema: Record<string, unknown>, path: string): void => {
      const properties = (schema["properties"] ?? {}) as Record<string, Record<string, unknown>>
      for (const [key, child] of Object.entries(properties)) {
        if (typeof child["description"] !== "string") undocumented.push(`${path}.${key}`)
        visit(child, `${path}.${key}`)
      }
      for (const variant of (schema["oneOf"] ?? schema["anyOf"] ?? []) as Record<string, unknown>[]) visit(variant, path)
    }
    for (const registered of h.tools.values()) visit(z.toJSONSchema(registered.input) as Record<string, unknown>, registered.name)
    expect(undocumented).toEqual([])
  })
})

describe("input validation", () => {
  it("rejects unknown keys and operations that are not ids", () => {
    const cases: unknown[] = [
      { ...listRequest, extra: 1 },
      { ...listRequest, operation: { id: "gmail.users.messages.list" } },
      { ...listRequest, operation: { kind: "discovery", service: "gmail", resources: ["users", "messages"], method: "list" } },
      { ...listRequest, operation: "gmail users messages list" },
      { ...listRequest, operation: "gmail.+triage" },
      { ...listRequest, operation: "gmail" },
      { ...listRequest, input: "--max 5" },
      { ...listRequest, pagination: { all: true, pageToken: "x" } },
      { ...listRequest, upload: { path: "/a", shell: true } },
      { ...listRequest, response: { mode: "raw" } },
      request("gmail.users.messages.list", { account: "" }),
    ]
    for (const input of cases) expect(RequestInput.safeParse(input).success, JSON.stringify(input)).toBe(false)
    expect(RequestInput.safeParse(listRequest).success).toBe(true)
    const { account: _named, ...unnamed } = listRequest
    expect(RequestInput.safeParse(unnamed).success).toBe(true)
    expect(RequestInput.safeParse(request("gmail.triage", { input: { max: 5 } })).success).toBe(true)
  })

  it("refuses helper flags on a method and method fields on a helper before asking or spawning", async () => {
    const h = await setup({})
    await expect(tool(h, "read").execute({ ...listRequest, input: { max: 5 } }, context())).rejects.toThrow(
      /^GWS_VALIDATION_ERROR: 'gmail.users.messages.list' is a method and takes params and body, not input\. Next step: /,
    )
    await expect(tool(h, "read").execute(request("gmail.triage", { params: { max: 5 } }), context())).rejects.toThrow(
      /^GWS_VALIDATION_ERROR: 'gmail.triage' is a helper and takes its flags in input, not params\. Next step: Move the flags into input/,
    )
    expect(h.calls).toEqual([])
    expect(gwsInvocations()).toEqual([])
  })

  it("accepts only {planId} on a commit tool", () => {
    expect(CommitInput.safeParse({ planId: "plan_aaaaaaaaaaaaaaaaaaaaaaaa" }).success).toBe(true)
    expect(CommitInput.safeParse({ planId: "plan_aaaaaaaaaaaaaaaaaaaaaaaa", account: "personal" }).success).toBe(false)
    expect(CommitInput.safeParse({ planId: "short" }).success).toBe(false)
    expect(CommitInput.safeParse({ ...sendRequest }).success).toBe(false)
  })

  it("refuses invalid input in execute before asking or spawning", async () => {
    const h = await setup({})
    await expect(tool(h, "read").execute({ ...listRequest, argv: ["x"] }, context())).rejects.toThrow(/GWS_VALIDATION_ERROR/)
    await expect(tool(h, "send").execute({ planId: "plan_aaaaaaaaaaaaaaaaaaaaaaaa", body: {} }, context())).rejects.toThrow(/GWS_VALIDATION_ERROR/)
    await expect(tool(h, "status").execute({ verbose: true }, context())).rejects.toThrow(/GWS_VALIDATION_ERROR/)
    expect(h.calls).toEqual([])
    expect(gwsInvocations()).toEqual([])
  })
})

describe("typed outputs", () => {
  it("returns output that conforms to each tool's own output schema", async () => {
    const h = await setup({})
    const results: Array<[string, Result]> = []
    const runTool = async (name: string, input: unknown): Promise<Result> => {
      const result = await tool(h, name).execute(input, context())
      results.push([name, result])
      return result
    }
    await runTool("status", {})
    await runTool("catalog", { service: "gmail", limit: 3 })
    await runTool("schema", request("gmail.users.getProfile"))
    await runTool("schema", request("gmail.triage"))
    await runTool("read", listRequest)
    const plan = await runTool("plan", sendRequest)
    await runTool("send", { planId: plan.output["planId"] })

    for (const [name, result] of results) {
      const parsed = tool(h, name).output.safeParse(result.output)
      expect(parsed.success, `${name}: ${JSON.stringify(parsed.error?.issues)}`).toBe(true)
      expect(JSON.parse(result.content)).toEqual(JSON.parse(JSON.stringify(result.output)))
      expect(result.metadata).toMatchObject({ tool: `gws.${name}` })
      expect(typeof result.metadata["durationMs"]).toBe("number")
    }
    const read = results.find(([name]) => name === "read")![1]
    expect(read.output).toMatchObject({ ok: true, operation: "gmail.users.messages.list", data: { messages: [{ id: "m1" }] } })
    expect(read.metadata).toMatchObject({ operation: "gmail.users.messages.list", category: "read", account: "personal" })
    expect(JSON.stringify(results.map(([, result]) => result.metadata))).not.toContain("c2VjcmV0IGJvZHk")
  })

  it("bounds the text rendering at maxInlineBytes but keeps the structured output whole", async () => {
    const h = await setup({}, undefined, { maxInlineBytes: 64 })
    const result = await tool(h, "catalog").execute({ service: "gmail", limit: 20 }, context())
    expect((result.output["entries"] as unknown[]).length).toBe(20)
    expect(result.content).toMatch(/…\[truncated: 64 of \d+ bytes shown/)
    expect(result.metadata["truncated"]).toBe(true)
  })

  it("lets a read lower its own inline cap with response.maxInlineBytes", async () => {
    const h = await setup({})
    const whole = await tool(h, "read").execute(listRequest, context())
    expect(whole.metadata["truncated"]).toBeUndefined()
    const cut = await tool(h, "read").execute({ ...listRequest, response: { maxInlineBytes: 32 } }, context())
    expect(cut.content).toMatch(/…\[truncated: 32 of \d+ bytes shown/)
    expect(cut.output["truncated"]).toBe(false)
    expect(cut.metadata["truncated"]).toBe(true)
  })

  it("renders small payloads as compact JSON", () => {
    expect(render({ a: 1 }, 1024)).toEqual({ text: '{"a":1}', truncated: false })
  })
})

describe("cancellation and progress", () => {
  function alive(pid: number): boolean {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  async function waitFor(check: () => boolean, ms = 5_000): Promise<void> {
    const deadline = Date.now() + ms
    while (!check()) {
      if (Date.now() > deadline) throw new Error("timed out")
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }

  it("kills a running gws on abort and rejects with CANCELLED", async () => {
    rmSync(pidFile, { force: true })
    const h = await setup({}, undefined, { binary: slow })
    const controller = new AbortController()
    const pending = tool(h, "read").execute(listRequest, context({ signal: controller.signal }))
    await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim().length > 0)
    const pid = Number(readFileSync(pidFile, "utf8").trim())
    expect(alive(pid)).toBe(true)
    const started = Date.now()
    controller.abort()
    await expect(pending).rejects.toThrow(/^CANCELLED:/)
    expect(Date.now() - started).toBeLessThan(5_000)
    await waitFor(() => !alive(pid))
  })

  it("does not spawn gws when the signal is already aborted", async () => {
    const h = await setup({})
    const controller = new AbortController()
    controller.abort()
    await expect(tool(h, "read").execute(listRequest, context({ signal: controller.signal }))).rejects.toThrow(/^CANCELLED:/)
    expect(gwsInvocations()).toEqual([])
  })

  it("leaves a plan ready when its commit is cancelled before running", async () => {
    const h = await setup({})
    const plan = await tool(h, "plan").execute(sendRequest, context())
    const controller = new AbortController()
    controller.abort()
    const planId = plan.output["planId"] as string
    await expect(tool(h, "send").execute({ planId }, context({ signal: controller.signal }))).rejects.toThrow(/^CANCELLED:/)
    expect(h.runtime.plans.get(planId)?.state).toBe("ready")
    expect(commits()).toEqual([])
  })

  it("reports resolving, running, and parsing progress", async () => {
    const h = await setup({})
    const updates: Array<Record<string, unknown>> = []
    await tool(h, "read").execute(listRequest, context({ progress: async (update: Record<string, unknown>) => void updates.push(update) }))
    expect(updates.map((update) => update["status"])).toEqual(["resolving", "running", "parsing"])
    expect(updates.every((update) => update["operation"] === "gmail.users.messages.list")).toBe(true)
  })

  it("ignores a failing progress sink", async () => {
    const h = await setup({})
    const result = await tool(h, "read").execute(listRequest, context({ progress: async () => Promise.reject(new Error("host down")) }))
    expect(result.output["ok"]).toBe(true)
  })
})

describe("tool permission assertions", () => {
  it("does not register a permission hook", async () => {
    const { hooks } = await setup({})
    expect(hooks).toEqual([])
  })

  it("asserts every tool action before doing work", async () => {
    const h = await setup({})
    await tool(h, "status").execute({}, context())
    await tool(h, "catalog").execute({ service: "gmail", limit: 1 }, context())
    await tool(h, "read").execute(listRequest, context())
    expect(h.calls.map((call) => [call.action, call.resources])).toEqual([
      ["gws.status", ["*"]],
      ["gws.catalog", ["*"]],
      ["gws.read", ["personal:gmail.users.messages.list"]],
    ])
    expect(h.calls[2]).toMatchObject({ sessionID: "ses_1", agent: "build", source: { type: "tool", messageID: "msg_1", id: "call_1" } })
  })

  it("passes ctx.permission.assert exactly one input with no signal", async () => {
    const h = await setup({})
    await tool(h, "read").execute(listRequest, context())
    const plan = await tool(h, "plan").execute(sendRequest, context())
    await tool(h, "send").execute({ planId: plan.output["planId"] }, context())
    expect(h.arities).toEqual([1, 1, 1])
    for (const call of h.calls) expect(Object.keys(call)).not.toContain("signal")
  })

  it("rejects with CANCELLED during a pending assert, and a late approval spawns nothing", async () => {
    let approve!: () => void
    let asked!: () => void
    const asking = new Promise<void>((resolve) => { asked = resolve })
    const h = await setup({}, undefined, {
      pending: (request) => {
        if (request.action !== "gws.send") return undefined
        asked()
        return new Promise<void>((resolve) => { approve = resolve })
      },
    })
    const plan = await tool(h, "plan").execute(sendRequest, context())
    const planId = plan.output["planId"] as string
    const controller = new AbortController()
    const pending = tool(h, "send").execute({ planId }, context({ signal: controller.signal }))
    await asking
    controller.abort()
    await expect(pending).rejects.toThrow(/^CANCELLED:/)
    approve()
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(commits()).toEqual([])
    expect(h.runtime.plans.get(planId)?.state).toBe("ready")
  })

  it("propagates a rejection and never runs gws", async () => {
    const h = await setup({}, (request) => request.action === "gws.read")
    await expect(tool(h, "read").execute(listRequest, context())).rejects.toThrow(/PermissionRejected: gws.read/)
    expect(gwsInvocations()).toEqual([])
  })

  it("refuses an unknown operation before asking", async () => {
    const h = await setup({})
    const unknown = request("gmail.users.messages.nope", { params: { userId: "me" }, fields: "messages(id)" })
    await expect(tool(h, "read").execute(unknown, context())).rejects.toThrow(/OPERATION_UNKNOWN/)
    expect(h.calls).toEqual([])
  })

  it("refuses an unknown plan without asserting", async () => {
    const h = await setup({})
    await expect(tool(h, "send").execute({ planId: "plan_aaaaaaaaaaaaaaaaaaaaaaaa" }, context())).rejects.toThrow(/PLAN_NOT_FOUND/)
    expect(h.calls).toEqual([])
  })

  it("scopes a schema request to account:operation and refuses a disabled service before asking", async () => {
    const h = await setup({})
    await tool(h, "schema").execute(request("gmail.users.getProfile"), context())
    expect(h.calls.map((call) => [call.action, call.resources])).toEqual([["gws.schema", ["personal:gmail.users.getProfile"]]])
    await expect(
      tool(h, "schema").execute(request("drive.files.list"), context()),
    ).rejects.toThrow(/POLICY_DENIED/)
    expect(h.calls).toHaveLength(1)
  })
})

describe("commit permission assertions", () => {
  async function plan(h: Harness): Promise<string> {
    const result = await tool(h, "plan").execute(sendRequest, context())
    expect(result.output).not.toHaveProperty("requiresConfirmation")
    return result.output["planId"] as string
  }

  it("asks gws.send once, with no Always, and commits after approval", async () => {
    const h = await setup({})
    const planId = await plan(h)
    await tool(h, "send").execute({ planId }, context())
    expect(h.calls.map((call) => [call.action, call.resources, call.save])).toEqual([
      ["gws.plan", ["personal:gmail.users.messages.send"], ["personal:gmail.users.messages.send"]],
      ["gws.send", ["personal:gmail.users.messages.send"], undefined],
    ])
    expect(h.calls[1]!.metadata).toMatchObject({ planId, category: "send", operation: "gmail.users.messages.send", account: "personal", method: "POST" })
    expect(JSON.stringify(h.calls)).not.toContain("c2VjcmV0IGJvZHk")
    expect(JSON.stringify(h.calls)).not.toContain("gws.confirm")
    expect(commits()).toHaveLength(1)
  })

  it("does not commit when the category action is rejected, and the plan stays unconsumed", async () => {
    const h = await setup({}, (request) => request.action === "gws.send")
    const planId = await plan(h)
    await expect(tool(h, "send").execute({ planId }, context())).rejects.toThrow(/PermissionRejected: gws.send/)
    expect(h.calls.map((call) => call.action)).toEqual(["gws.plan", "gws.send"])
    expect(commits()).toEqual([])
    expect(h.runtime.plans.get(planId)?.state).toBe("ready")
  })

  it("refuses the wrong commit tool before asking", async () => {
    const h = await setup({})
    const planId = await plan(h)
    await expect(tool(h, "write").execute({ planId }, context())).rejects.toThrow(/CATEGORY_MISMATCH/)
    expect(h.calls.map((call) => call.action)).toEqual(["gws.plan"])
  })
})

describe("errors the model sees", () => {
  async function failure(h: Harness, name: string, input: unknown): Promise<ToolError> {
    const error = await tool(h, name).execute(input, context()).then(
      () => undefined,
      (thrown: unknown) => thrown,
    )
    expect(error).toBeInstanceOf(ToolError)
    return error as ToolError
  }

  it("turns a plugin error into a Tool.Error with the code, the next step, and the message", async () => {
    const h = await setup({})
    const error = await failure(h, "send", { planId: "plan_aaaaaaaaaaaaaaaaaaaaaaaa" })
    expect(error.message).toBe("PLAN_NOT_FOUND: Run gws_plan first. Next step: Create a plan with gws_plan, then commit its planId.")
    expect(error.metadata).toEqual({ code: "PLAN_NOT_FOUND", next: "Create a plan with gws_plan, then commit its planId." })
    expect(error.error).toBeUndefined()
  })

  it("gives every rejected input a code and a next step", async () => {
    const h = await setup({})
    const error = await failure(h, "status", { verbose: true })
    expect(error.message).toMatch(/^GWS_VALIDATION_ERROR: .*\. Next step: Fix the request as the message says; gws_schema shows/)
    expect(error.metadata).toMatchObject({ code: "GWS_VALIDATION_ERROR" })
  })

  it("carries the enable link of a disabled API in the message and in metadata", async () => {
    const url = "https://console.developers.google.com/apis/api/gmail.googleapis.com/overview?project=123456"
    writeFileSync(
      failurePath,
      `${JSON.stringify({ error: { code: 403, message: `Gmail API has not been used in project 123456 before or it is disabled. Enable it by visiting ${url} then retry.`, reason: "accessNotConfigured", enable_url: url } })}\n1\n`,
    )
    const h = await setup({}, undefined, { binary: failing })
    const error = await failure(h, "read", listRequest)
    expect(error.message).toMatch(/^API_DISABLED: Gmail API has not been used in project 123456/)
    expect(error.message).toContain(`Next step: Ask the user to open ${url} and enable the API for project 123456, then wait about a minute and retry.`)
    expect(error.metadata).toEqual({ code: "API_DISABLED", next: expect.stringContaining(url), enableUrl: url })
  })

  it.each([
    [2, "AUTH_REQUIRED", { error: { code: 401, message: "Access denied.", reason: "authError" } }],
    [3, "GWS_VALIDATION_ERROR", { error: { code: 400, message: "bad --params", reason: "validationError" } }],
    [4, "GWS_DISCOVERY_ERROR", { error: { code: 0, message: "could not fetch the Discovery document", reason: "discoveryError" } }],
    [5, "GWS_INTERNAL_ERROR", { error: { code: 0, message: "unexpected failure" } }],
    [1, "GWS_API_ERROR", { error: { code: 404, message: "Requested entity was not found." } }],
  ])("reads gws exit %s as %s", async (exit, code, payload) => {
    writeFileSync(failurePath, `${JSON.stringify(payload)}\n${exit}\n`)
    const h = await setup({}, undefined, { binary: failing })
    const error = await failure(h, "read", listRequest)
    expect(error.message).toMatch(new RegExp(`^${code}: .*\\. Next step: `))
    expect(error.metadata).toMatchObject({ code })
  })

  it("passes a host permission rejection through untouched", async () => {
    const rejected = Object.assign(new Error("The user rejected permission to use this specific tool call"), { _tag: "Permission.DeclinedError" })
    const h = await setup({}, undefined, { pending: () => Promise.reject(rejected) })
    await expect(tool(h, "read").execute(listRequest, context())).rejects.toBe(rejected)
    expect(gwsInvocations()).toEqual([])
  })
})

describe("accounts", () => {
  const two = { personal: account({ services: ["gmail"] }), work: account({ services: ["gmail"] }) }

  it("uses the only configured account when the call names none", async () => {
    const h = await setup({})
    const { account: _named, ...unnamed } = listRequest
    const result = await tool(h, "read").execute(unnamed, context())
    expect(result.metadata).toMatchObject({ account: "personal", operation: "gmail.users.messages.list" })
    expect(h.calls.map((call) => call.resources)).toEqual([["personal:gmail.users.messages.list"]])
    const schema = await tool(h, "schema").execute({ operation: "gmail.users.getProfile" }, context())
    expect(schema.output).toMatchObject({ ok: true, account: "personal" })
  })

  it("requires an account when several are configured, and lists them", async () => {
    const h = await setup({}, undefined, { accounts: two })
    const { account: _named, ...unnamed } = listRequest
    await expect(tool(h, "read").execute(unnamed, context())).rejects.toThrow(
      /^ACCOUNT_REQUIRED: 2 accounts are configured \(personal, work\); the call must name one\. Next step: Pass account with one of the configured aliases/,
    )
    await expect(tool(h, "read").execute({ ...listRequest, account: "home" }, context())).rejects.toThrow(
      /^ACCOUNT_UNKNOWN: 'home' is not configured\. Next step: Pass one of the configured accounts: personal, work\.$/,
    )
    expect(h.calls).toEqual([])
    const work = await tool(h, "read").execute({ ...listRequest, account: "work" }, context())
    expect(work.metadata).toMatchObject({ account: "work" })
  })
})

describe("helpers", () => {
  it("shows a runnable helper's input flags in gws_schema", async () => {
    const h = await setup({})
    const result = await tool(h, "schema").execute({ operation: "gmail.triage" }, context())
    const helper = result.output["helper"] as { id: string; input?: { type?: string; properties?: Record<string, unknown> } }
    expect(helper.id).toBe("gmail.triage")
    expect(helper.input?.type).toBe("object")
    expect(Object.keys(helper.input?.properties ?? {})).toContain("max")
  })

  it("marks in gws_schema why an ordinary sign-in cannot run a method: app-only, or domain-wide delegation", async () => {
    const h = await setup({}, undefined, { accounts: { personal: account({ services: ["chat", "keep", "gmail"] }) } })
    const keep = await tool(h, "schema").execute({ operation: "keep.notes.list" }, context())
    expect(keep.output).toMatchObject({ restriction: "domain-wide-delegation" })
    expect(keep.output).not.toHaveProperty("appOnly")
    const chat = await tool(h, "schema").execute({ operation: "chat.spaces.messages.attachments.get" }, context())
    expect(chat.output).toMatchObject({ appOnly: true, restriction: "app-only" })
    const gmail = await tool(h, "schema").execute({ operation: "gmail.users.getProfile" }, context())
    expect(gmail.output).not.toHaveProperty("restriction")
  })

  it("names the method to use for a helper that cannot run", async () => {
    const h = await setup({}, undefined, { accounts: { personal: account({ services: ["gmail", "calendar"] }) } })
    await expect(tool(h, "plan").execute(request("calendar.insert", { input: { summary: "x" } }), context())).rejects.toThrow(
      /^HELPER_UNSUPPORTED: 'calendar.insert' has no adapter yet; it is cataloged but not executable\. Next step: Use the method "calendar.events.insert" instead/,
    )
    const schema = await tool(h, "schema").execute({ operation: "calendar.insert" }, context())
    expect((schema.output["helper"] as Record<string, unknown>)["input"]).toBeUndefined()
  })
})

describe("catalog, plan, and send", () => {
  it("finds the send method by words, plans it by id without an account, and sends with only the planId", async () => {
    const h = await setup({})
    const found = await tool(h, "catalog").execute({ query: "send email" }, context())
    const entry = (found.output["entries"] as Array<Record<string, unknown>>).find((item) => item["id"] === "gmail.users.messages.send")
    expect(entry).toMatchObject({ kind: "method", category: "send", executable: true, commitTool: "gws_send" })
    const planned = await tool(h, "plan").execute(
      { operation: entry!["id"], params: { userId: "me" }, body: { raw: "c2VjcmV0IGJvZHk" }, reason: " weekly report to the team " },
      context(),
    )
    expect(planned.output).toMatchObject({ category: "send", preview: { account: "personal", reason: "weekly report to the team" } })
    const sent = await tool(h, "send").execute({ planId: planned.output["planId"] }, context())
    expect(sent.output).toMatchObject({ ok: true, category: "send", operation: "gmail.users.messages.send" })
    expect(commits()).toHaveLength(1)
  })
})
