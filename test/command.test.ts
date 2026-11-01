import { describe, expect, it } from "vitest"
import { buildCommand, maskExample } from "../src/domain/command.js"
import { isApiError, parseResult, redactDryRun } from "../src/domain/result.js"
import type { MethodEntry } from "../src/domain/types.js"
import { testConfig } from "./support/config.js"
import { request as requestFor, type RequestExtras } from "./support/requests.js"

const entry = (overrides: Partial<MethodEntry> = {}): MethodEntry => ({
  id: "gmail.users.messages.list",
  service: "gmail",
  path: ["users", "messages"],
  method: "list",
  httpMethod: "GET",
  pathTemplate: "gmail/v1/users/{userId}/messages",
  scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
  category: "read",
  ...overrides,
})

const config = testConfig({
  policy: { rules: [] },
  execution: {
    timeoutMs: 1000,
    schemaTimeoutMs: 1000,
    maxPages: 10,
    maxItems: 100,
    pageDelayMs: 100,
    maxStdoutBytes: 1024,
    maxStderrBytes: 1024,
    maxInlineBytes: 1024,
    maxUploadBytes: 1024,
    maxDownloadBytes: 1024,
    allowedReadRoots: [],
    allowedWriteRoots: [],
  },
  audit: { enabled: false },
  skills: { enabled: false },
  admin: { allowedServices: [] },
})

const request = (overrides: RequestExtras = {}, id = "gmail.users.messages.list") => requestFor(id, { params: { userId: "me" }, ...overrides })

function paramsOf(argv: string[]): Record<string, unknown> {
  const index = argv.indexOf("--params")
  return JSON.parse(argv[index + 1]!) as Record<string, unknown>
}

describe("argv builder", () => {
  it("uses the service, resource path, and method exactly once", () => {
    const built = buildCommand(entry(), request({ fields: "messages(id,threadId)" }), config, { dryRun: false, category: "read" })
    expect(built.argv.slice(0, 4)).toEqual(["gmail", "users", "messages", "list"])
    expect(paramsOf(built.argv).fields).toBe("messages(id,threadId)")
    expect(built.argv).toContain("--format")
  })

  it("carries a request body through --json, never a shell", () => {
    const built = buildCommand(
      entry({ id: "gmail.users.drafts.create", path: ["users", "drafts"], method: "create", httpMethod: "POST", category: "write" }),
      request({ body: { message: { raw: "abc" } } }, "gmail.users.drafts.create"),
      config,
      { dryRun: true, category: "write" },
    )
    const index = built.argv.indexOf("--json")
    expect(index).toBeGreaterThan(-1)
    expect(JSON.parse(built.argv[index + 1]!)).toEqual({ message: { raw: "abc" } })
    expect(built.argv).toContain("--dry-run")
  })

  it("clamps pagination and emits page flags", () => {
    const built = buildCommand(
      entry(),
      request({ fields: "messages(id)", pagination: { all: true, maxPages: 999, delayMs: 25 } }),
      config,
      { dryRun: false, category: "read" },
    )
    expect(built.argv[built.argv.indexOf("--page-limit") + 1]).toBe("10")
    expect(built.argv[built.argv.indexOf("--page-delay") + 1]).toBe("25")
  })

  it("requires a field mask for list/search", () => {
    expect(() => buildCommand(entry(), request({ params: { userId: "me" } }), config, { dryRun: false, category: "read" })).toThrow(/Field mask/)
  })

  it("gives a field-mask example from the operation's own service and resource", () => {
    expect(() => buildCommand(entry(), request({ params: { userId: "me" } }), config, { dryRun: false, category: "read" })).toThrow('e.g. "messages(id),nextPageToken"')
    expect(maskExample({ id: "drive.files.list", service: "drive" })).toBe("files(id),nextPageToken")
    expect(maskExample({ id: "calendar.events.list", service: "calendar" })).toBe("items(id),nextPageToken")
    expect(maskExample({ id: "chat.spaces.messages.search", service: "chat" })).toBe("messages(id),nextPageToken")
  })

  it("refuses a persistent download on a read", () => {
    expect(() =>
      buildCommand(entry(), request({ fields: "messages(id)", download: { path: "/tmp/x" } }), config, { dryRun: false, category: "read" }),
    ).toThrow(/gws_export/)
  })
})

describe("result parser", () => {
  const result = (stdout: string) => ({
    exitCode: 0,
    signal: null,
    stdout: Buffer.from(stdout),
    stderr: Buffer.alloc(0),
    durationMs: 1,
    timedOut: false,
    outputCapped: false,
  })

  it("tolerates the gws stdout preamble", () => {
    const parsed = parseResult(result('Using keyring backend: file\n{"messages":[{"id":"1"}]}'), { maxInlineBytes: 1024 })
    expect(parsed.ok).toBe(true)
    expect(parsed.data).toEqual({ messages: [{ id: "1" }] })
  })

  it("treats an empty 204-style response as success", () => {
    const parsed = parseResult(result(""), { maxInlineBytes: 1024 })
    expect(parsed.ok).toBe(true)
    expect(parsed.data).toBeUndefined()
  })

  it("treats an API error payload as failure even with exit code 0", () => {
    const parsed = parseResult(result('{"error":{"code":404,"message":"Requested entity was not found."}}'), { maxInlineBytes: 1024 })
    expect(parsed.ok).toBe(false)
    expect(isApiError(parsed.data)).toBe(true)
  })

  it("does not treat bracketed table text as JSON", () => {
    const parsed = parseResult(result("date  from  subject\nMon  a@b.com  [ALERT - No severity] something"), { maxInlineBytes: 1024 })
    expect(parsed.ok).toBe(false)
    expect(parsed.raw).toContain("[ALERT")
  })

  it("redacts a dry-run body before it reaches the model", () => {
    expect(redactDryRun({ body: { message: { raw: "secret" } }, dry_run: true })).toEqual({ body: "[redacted]", dry_run: true })
  })

  it("parses NDJSON pages", () => {
    const parsed = parseResult(result('{"messages":[{"id":"1"}]}\n{"messages":[{"id":"2"}]}\n'), { maxInlineBytes: 1024 })
    expect(parsed.data).toEqual([{ messages: [{ id: "1" }] }, { messages: [{ id: "2" }] }])
  })
})
