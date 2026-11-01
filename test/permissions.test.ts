import { describe, expect, it } from "vitest"
import { commitRequests, localRequest, operationRequest, planMetadata } from "../src/host/permissions.js"
import type { Plan } from "../src/domain/types.js"

const call = { sessionID: "ses_1", agent: "build", messageID: "msg_1", id: "call_1" }
const source = { type: "tool", messageID: "msg_1", id: "call_1" }

const SECRET_BODY = "Dear Bob, the launch code is 0000"
const TOKEN = "ya29.secret-access-token"

const plan = (overrides: Partial<Plan> = {}): Plan => ({
  id: "plan_abcdefghijklmnopqrstuvwx",
  account: "personal",
  sessionId: "ses_1",
  agentId: "build",
  category: "send",
  operation: "gmail.users.messages.send",
  service: "gmail",
  argv: ["gmail", "users", "messages", "send", "--json", JSON.stringify({ raw: SECRET_BODY }), "--token", TOKEN],
  createdAt: 0,
  expiresAt: 300_000,
  state: "ready",
  preview: {
    method: "POST",
    url: "gmail/v1/users/{userId}/messages/send",
    params: { userId: "me", q: SECRET_BODY },
    bodySummary: "object(raw) 64 bytes",
    recipients: ["bob@example.com"],
    account: "personal",
    category: "send",
  },
  ...overrides,
})

describe("permission requests", () => {
  it("asserts local tools on the wildcard resource", () => {
    expect(localRequest(call, "gws.status")).toEqual({
      sessionID: "ses_1",
      agent: "build",
      action: "gws.status",
      resources: ["*"],
      save: ["*"],
      metadata: {},
      source,
    })
  })

  it("scopes read, plan, and schema to account:operation with a narrow save", () => {
    const request = operationRequest(call, "gws.read", {
      account: "personal",
      operation: "gmail.users.messages.list",
      service: "gmail",
      category: "read",
    })
    expect(request.action).toBe("gws.read")
    expect(request.resources).toEqual(["personal:gmail.users.messages.list"])
    expect(request.save).toEqual(["personal:gmail.users.messages.list"])
    expect(request.metadata).toEqual({ account: "personal", operation: "gmail.users.messages.list", service: "gmail", category: "read" })
    expect(request.source).toEqual(source)
  })

  it("offers Always only for write and export, on that exact account:operation", () => {
    for (const category of ["write", "export"] as const) {
      const [request] = commitRequests(call, `gws.${category}`, plan({ category, operation: "drive.files.update" }))
      expect(request!.save).toEqual(["personal:drive.files.update"])
      expect(request!.save).not.toContain("*")
    }
    for (const category of ["send", "share", "delete", "admin"] as const) {
      const [request] = commitRequests(call, `gws.${category}`, plan({ category }))
      expect(request!.action).toBe(`gws.${category}`)
      expect(request!.resources).toEqual([`personal:${plan().operation}`])
      expect(request!.save).toBeUndefined()
    }
  })

  it("shows a redacted plan preview and never the body, params, argv, or token", () => {
    const metadata = planMetadata(plan({ category: "admin", preview: { ...plan().preview, category: "admin", reason: "ticket 42" } }))
    expect(metadata).toEqual({
      planId: "plan_abcdefghijklmnopqrstuvwx",
      category: "admin",
      operation: "gmail.users.messages.send",
      account: "personal",
      method: "POST",
      recipients: ["bob@example.com"],
      bodySummary: "object(raw) 64 bytes",
      reason: "ticket 42",
      expiresAt: new Date(300_000).toISOString(),
    })
    const serialized = JSON.stringify(commitRequests(call, "gws.send", plan()))
    expect(serialized).not.toContain(SECRET_BODY)
    expect(serialized).not.toContain(TOKEN)
    expect(serialized).not.toContain("--json")
    expect(serialized).not.toContain("userId")
    expect(serialized).not.toContain("gws.confirm")
  })
})
