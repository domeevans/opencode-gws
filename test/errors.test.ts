import { readdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { ErrorCode, GwsError, cancelledError, isErrorCode } from "../src/domain/errors.js"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const TABLE = join(ROOT, "src", "domain", "errors.ts")

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    return entry.isDirectory() ? files(path) : /\.tsx?$/.test(entry.name) ? [path] : []
  })
}

describe("error code table", () => {
  it("has an entry for every code the source raises", () => {
    const source = files(join(ROOT, "src"))
      .filter((file) => file !== TABLE)
      .map((file) => readFileSync(file, "utf8"))
      .join("\n")
    const raised = new Set([
      ...[...source.matchAll(/["`]([A-Z][A-Z_]{3,}): /g)].map((match) => match[1]!),
      ...[...source.matchAll(/new GwsError\(\s*"([A-Z][A-Z_]+)"/g)].map((match) => match[1]!),
    ])
    expect(raised.size).toBeGreaterThan(25)
    expect([...raised].filter((code) => !isErrorCode(code)).sort()).toEqual([])
  })

  // The other direction: the table, and so the documented Errors section, lists no code nothing raises.
  it("lists only codes the source names", () => {
    const source = files(join(ROOT, "src"))
      .filter((file) => file !== TABLE)
      .map((file) => readFileSync(file, "utf8"))
      .join("\n")
    const unused = Object.keys(ErrorCode).filter((code) => !new RegExp(`["\`']${code}\\b`).test(source))
    expect(unused).toEqual([])
  })

  it("gives every code a meaning and a next step written as sentences, without internal jargon", () => {
    for (const [code, entry] of Object.entries(ErrorCode)) {
      expect(code).toMatch(/^[A-Z][A-Z_]+$/)
      for (const text of [entry.meaning, entry.next]) {
        expect(text, code).toMatch(/^(?:[A-Z]|gws\b).*\.$/s)
        expect(text, code).not.toMatch(/\bWS-[A-Z]|TODO|reviewed package|manifest hash|acceptance|evidence/i)
      }
    }
  })

  it("imports nothing, so scripts can load it directly", () => {
    expect(readFileSync(TABLE, "utf8")).not.toMatch(/^\s*import\s/m)
  })
})

describe("GwsError", () => {
  it("reads CODE: What happened. Next step: What to do.", () => {
    const error = new GwsError("PLAN_EXPIRED", "create a new plan")
    expect(error.message).toBe(`PLAN_EXPIRED: Create a new plan. Next step: ${ErrorCode.PLAN_EXPIRED.next}`)
    expect(error).toMatchObject({ code: "PLAN_EXPIRED", next: ErrorCode.PLAN_EXPIRED.next })
    expect(error.enableUrl).toBeUndefined()
    expect(String(error)).toMatch(/^Error: PLAN_EXPIRED: /)
  })

  it("keeps a message that ends a sentence, and takes a specific next step and enable link", () => {
    const error = new GwsError("API_DISABLED", "Gmail API is disabled.", { next: "Enable it.", enableUrl: "https://console.cloud.google.com/x" })
    expect(error.message).toBe("API_DISABLED: Gmail API is disabled. Next step: Enable it.")
    expect(error).toMatchObject({ code: "API_DISABLED", next: "Enable it.", enableUrl: "https://console.cloud.google.com/x" })
  })

  it("reads an Error that starts with a code, keeping a stated next step or adding the table's, ending with a full stop", () => {
    const stated = GwsError.from(new Error("AUTH_REQUIRED: 'work' is not signed in. Next step: Sign in with /connect"))
    expect(stated).toMatchObject({ code: "AUTH_REQUIRED", next: "Sign in with /connect", message: "AUTH_REQUIRED: 'work' is not signed in. Next step: Sign in with /connect." })
    const bare = GwsError.from(new Error("BINARY_TRUST_FAILED: not a regular file: /x"))
    expect(bare).toMatchObject({ code: "BINARY_TRUST_FAILED", message: `BINARY_TRUST_FAILED: Not a regular file: /x. Next step: ${ErrorCode.BINARY_TRUST_FAILED.next}` })
    const own = new GwsError("TIMEOUT", "slow")
    expect(GwsError.from(own)).toBe(own)
  })

  it("does not read other errors as plugin errors", () => {
    expect(GwsError.from(new Error("NOT_A_CODE: x"))).toBeUndefined()
    expect(GwsError.from(new Error("PermissionRejected: gws.read"))).toBeUndefined()
    expect(GwsError.from(Object.assign(new Error("POLICY_DENIED: x"), { _tag: "Permission.DeniedError" }))).toBeUndefined()
    expect(GwsError.from({ message: "POLICY_DENIED: X" })).toBeUndefined()
    expect(GwsError.from("POLICY_DENIED: x")).toBeUndefined()
  })

  it("reports cancellation as CANCELLED", () => {
    expect(cancelledError()).toMatchObject({ code: "CANCELLED", message: expect.stringMatching(/^CANCELLED: The call was cancelled; the gws process was stopped\. Next step: /) })
  })
})
