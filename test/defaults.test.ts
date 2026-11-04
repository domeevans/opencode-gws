import { describe, expect, it } from "vitest"
import { effectiveCategory } from "../src/domain/classify.js"
import { resolveMethod } from "../src/domain/manifest.js"
import { evaluatePolicy } from "../src/domain/policy.js"
import type { Category, MethodEntry, Request } from "../src/domain/types.js"
import { account, testConfig } from "./support/config.js"
import { request as requestFor } from "./support/requests.js"

const config = (policy?: Record<string, unknown>) =>
  testConfig({ accounts: { personal: account({ services: ["gmail", "drive", "calendar", "chat"] }) }, policy })

function method(service: string, resources: string[], name: string): MethodEntry {
  const entry = resolveMethod(service, resources, name)
  if (!entry) throw new Error(`missing ${service}.${resources.join(".")}.${name}`)
  return entry
}

function request(entry: MethodEntry, params?: Record<string, unknown>, body?: unknown): Request {
  return requestFor(entry.id, { params, body })
}

describe("policy does not ask", () => {
  it("does not block reads or commits unless a deny rule matches", () => {
    expect(config().policy).toEqual({ planTtlSeconds: 300, rules: [] })
    const cases: Array<[string, string[], string, Category]> = [
      ["gmail", ["users", "messages"], "list", "read"],
      ["gmail", ["users", "drafts"], "create", "write"],
      ["gmail", ["users", "messages"], "send", "send"],
      ["gmail", ["users", "messages"], "trash", "delete"],
      ["drive", ["files"], "delete", "delete"],
      ["drive", ["permissions"], "create", "share"],
      ["drive", ["files"], "export", "export"],
    ]
    for (const [service, resources, name, category] of cases) {
      const entry = method(service, resources, name)
      const req = request(entry, { userId: "me" })
      expect(effectiveCategory(entry, req)).toBe(category)
      expect(evaluatePolicy(config(), entry, category, req, "pending").effect).toBe("allow")
    }
  })

  it("keeps admin denied until the admin gate is opened", () => {
    const entry: MethodEntry = { ...method("drive", ["files"], "list"), category: "admin" }
    expect(evaluatePolicy(config(), entry, "admin", request(entry), "pending").effect).toBe("deny")
  })

  it("lets a deny rule block one category", () => {
    const entry = method("drive", ["files"], "delete")
    const req = request(entry, { fileId: "x" })
    expect(evaluatePolicy(config({ rules: [{ id: "no-delete", effect: "deny", categories: ["delete"] }] }), entry, "delete", req, "pending").effect).toBe("deny")
    expect(evaluatePolicy(config({ rules: [{ id: "no-write", effect: "deny", categories: ["write"] }] }), method("gmail", ["users", "drafts"], "create"), "write", req, "pending").effect).toBe("deny")
  })

  it("rejects policy.defaults", () => {
    expect(() => config({ defaults: { write: "deny" } } as never)).toThrow(/defaults/)
  })
})

describe("writes that reach other people are sends", () => {
  it("classifies posting a Chat message as send", () => {
    expect(method("chat", ["spaces", "messages"], "create").category).toBe("send")
  })

  it("promotes a Calendar event write that emails attendees", () => {
    for (const name of ["insert", "patch", "update", "quickAdd", "move"]) {
      const entry = method("calendar", ["events"], name)
      expect(effectiveCategory(entry, request(entry, { calendarId: "primary", sendUpdates: "all" }))).toBe("send")
      expect(effectiveCategory(entry, request(entry, { calendarId: "primary", sendUpdates: "externalOnly" }))).toBe("send")
      expect(effectiveCategory(entry, request(entry, { calendarId: "primary", sendUpdates: "none" }))).toBe("write")
      expect(effectiveCategory(entry, request(entry, { calendarId: "primary" }))).toBe("write")
    }
  })

  it("promotes the deprecated sendNotifications, and any sendUpdates but none", () => {
    for (const name of ["insert", "patch", "update", "quickAdd", "move"]) {
      const entry = method("calendar", ["events"], name)
      for (const params of [{ sendNotifications: true }, { sendNotifications: "true" }, { sendNotifications: 1 }, { sendUpdates: "ALL" }, { sendUpdates: "bogus" }, { sendUpdates: "none", sendNotifications: true }]) {
        expect(effectiveCategory(entry, request(entry, { calendarId: "primary", ...params })), `${name} ${JSON.stringify(params)}`).toBe("send")
      }
      for (const params of [{ sendNotifications: false }, { sendNotifications: "false" }, { sendUpdates: "None" }]) {
        expect(effectiveCategory(entry, request(entry, { calendarId: "primary", ...params })), `${name} ${JSON.stringify(params)}`).toBe("write")
      }
    }
  })

  it("keeps a Calendar delete a delete even when it notifies", () => {
    const entry = method("calendar", ["events"], "delete")
    expect(effectiveCategory(entry, request(entry, { calendarId: "primary", eventId: "e", sendUpdates: "all" }))).toBe("delete")
  })
})
