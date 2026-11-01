import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { z } from "zod"
import { buildCommand, itemCap } from "../src/domain/command.js"
import { RequestInput, StatusInput } from "../src/domain/contract.js"
import { commandIndex } from "../src/domain/manifest.js"
import { capPageItems, inlineCap } from "../src/domain/result.js"
import type { Request } from "../src/domain/types.js"
import type { Runtime } from "../src/runtime/index.js"
import { testConfig, testRuntime } from "./support/config.js"
import { request } from "./support/requests.js"

/**
 * Every advertised tool input does something. These tests fail if a field
 * is accepted but ignored, and the schema walk fails if a field is
 * described as reserved or ignored again.
 */

function descriptions(schema: z.ZodType): string[] {
  const json = JSON.stringify(z.toJSONSchema(schema))
  return [...json.matchAll(/"description":"([^"]*)"/g)].map((match) => match[1]!)
}

describe("honest contract", () => {
  it("advertises no reserved or ignored input", () => {
    for (const schema of [RequestInput, StatusInput]) {
      for (const text of descriptions(schema)) expect(text).not.toMatch(/reserved|ignored/i)
    }
  })

  it("rejects the removed inputs instead of silently dropping them", () => {
    const base = request("gmail.users.getProfile")
    expect(RequestInput.safeParse({ ...base, sanitization: { mode: "block" } }).success).toBe(false)
    expect(RequestInput.safeParse({ ...base, response: { mode: "file" } }).success).toBe(false)
    expect(StatusInput.safeParse({ includeBinaryFingerprint: true }).success).toBe(false)
    expect(StatusInput.safeParse({}).success).toBe(true)
  })
})

describe("pagination.maxItems", () => {
  const config = testConfig({ execution: { maxPages: 10, maxItems: 50 } })
  const entry = commandIndex().methods.get("gmail.users.messages.list")!
  const list = (pagination: Request["pagination"], params: Record<string, unknown> = { userId: "me" }): Request =>
    request("gmail.users.messages.list", { params, fields: "messages(id),nextPageToken", pagination })
  const pageLimit = (argv: string[]) => Number(argv[argv.indexOf("--page-limit") + 1])

  it("follows pages, and is clamped by execution and policy limits", () => {
    expect(itemCap(list({ maxItems: 20 }), { maxPages: 10, maxItems: 50 })).toBe(20)
    expect(itemCap(list({ maxItems: 500 }), { maxPages: 10, maxItems: 50 })).toBe(50)
    expect(itemCap(list({ all: true }), { maxPages: 10, maxItems: 7 })).toBe(7)
    expect(buildCommand(entry, list({ maxItems: 20 }), config, { dryRun: false, category: "read" }).argv).toContain("--page-all")
  })

  it("stops fetching once a known page size covers maxItems", () => {
    const argv = (pagination: Request["pagination"], params?: Record<string, unknown>) =>
      buildCommand(entry, list(pagination, params), config, { dryRun: false, category: "read", limits: { maxPages: 10, maxItems: 50 } }).argv
    expect(pageLimit(argv({ maxItems: 25 }, { userId: "me", maxResults: 10 }))).toBe(3)
    expect(pageLimit(argv({ maxItems: 500 }, { userId: "me", maxResults: 10 }))).toBe(5)
    expect(pageLimit(argv({ maxItems: 25 }))).toBe(10)
    expect(pageLimit(argv({ all: true, maxPages: 4 }, { userId: "me", maxResults: 10 }))).toBe(4)
    expect(
      pageLimit(buildCommand(entry, list({ all: true }), config, { dryRun: false, category: "read", limits: { maxPages: 2, maxItems: 50 } }).argv),
    ).toBe(2)
  })

  it("cuts the item list, drops the cut page's token and later pages", () => {
    const pages = [
      { messages: [{ id: 1 }, { id: 2 }], nextPageToken: "a" },
      { messages: [{ id: 3 }, { id: 4 }], nextPageToken: "b" },
      { messages: [{ id: 5 }] },
    ]
    expect(capPageItems(pages, 3)).toEqual({
      data: [pages[0], { messages: [{ id: 3 }] }],
      pages: 2,
      items: 3,
      capped: true,
    })
    expect(capPageItems(pages, 4)).toEqual({ data: [pages[0], pages[1]], pages: 2, items: 4, capped: true })
    expect(capPageItems(pages, 10)).toEqual({ data: pages, pages: 3, items: 5, capped: false })
  })

  it("counts `items` first, treats array-free pages as empty, and refuses to guess otherwise", () => {
    expect(capPageItems({ items: [1, 2, 3], kind: "x", other: [9] }, 2)).toMatchObject({ data: [{ items: [1, 2], kind: "x", other: [9] }], items: 2, capped: true })
    expect(capPageItems([{ resultSizeEstimate: 0 }], 2)).toEqual({ data: [{ resultSizeEstimate: 0 }], pages: 1, items: 0, capped: false })
    const ambiguous = [{ a: [1, 2, 3], b: [4] }]
    expect(capPageItems(ambiguous, 1)).toEqual({ data: ambiguous, pages: 1, capped: false })
    expect(capPageItems(undefined, 1)).toEqual({ data: [], pages: 0, items: 0, capped: false })
  })
})

describe("response.maxInlineBytes", () => {
  it("can only lower the mode's cap", () => {
    expect(inlineCap(1000)).toBe(1000)
    expect(inlineCap(1000, "summary", 10)).toBe(10)
    expect(inlineCap(1000, "summary", 5000)).toBe(1000)
    expect(inlineCap(1000, "full", 2 * 1024 * 1024)).toBe(2 * 1024 * 1024)
    expect(inlineCap(1000, "full", 8 * 1024 * 1024)).toBe(5 * 1024 * 1024)
  })
})

// ── End to end through the runtime with a paging fake gws ───────────────

let dir: string
let binary: string
let log: string
let runtime: Runtime | undefined

beforeAll(() => {
  dir = mkdtempSync(join(process.cwd(), ".contract-test-"))
  binary = join(dir, "gws")
  log = join(dir, "argv.log")
  writeFileSync(
    binary,
    `#!/bin/sh
if [ "$1" = "--version" ]; then echo "gws 0.22.5"; exit 0; fi
echo "$*" >> '${log}'
printf '%s\\n' '{"messages":[{"id":"1"},{"id":"2"}],"nextPageToken":"a"}' '{"messages":[{"id":"3"},{"id":"4"}],"nextPageToken":"b"}'
`,
  )
  chmodSync(binary, 0o755)
})

afterAll(() => rmSync(dir, { recursive: true, force: true }))
afterEach(() => {
  runtime?.close()
  runtime = undefined
})

describe("paginated reads through the runtime", () => {
  it("applies maxItems, the policy rule's maxItems, and maxInlineBytes", async () => {
    writeFileSync(log, "")
    runtime = await testRuntime({
      binary: { path: binary },
      policy: { rules: [{ id: "few", effect: "deny", categories: ["read"], maxItems: 2 }] },
    })
    const read = request("gmail.users.messages.list", {
      params: { userId: "me" },
      fields: "messages(id),nextPageToken",
      pagination: { maxItems: 3 },
      response: { maxInlineBytes: 16 },
    })
    const output = await runtime.read(read, { sessionId: "s", agentId: "a" })
    expect(output.data).toEqual([{ messages: [{ id: "1" }, { id: "2" }], nextPageToken: "a" }])
    expect(output.pagination).toEqual({ pages: 1, items: 2, capped: true })
    expect(output.truncated).toBe(true)
    expect(readFileSync(log, "utf8")).toContain("--page-all")
  })
})
