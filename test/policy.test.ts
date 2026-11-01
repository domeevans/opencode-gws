import { describe, expect, it } from "vitest"
import { evaluatePolicy } from "../src/domain/policy.js"
import type { MethodEntry, PluginConfig, PolicyRule } from "../src/domain/types.js"
import { account, testConfig } from "./support/config.js"
import { request as requestFor, type RequestExtras } from "./support/requests.js"

const entry = (overrides: Partial<MethodEntry> = {}): MethodEntry => ({
  id: "gmail.users.messages.send",
  service: "gmail",
  path: ["users", "messages"],
  method: "send",
  httpMethod: "POST",
  pathTemplate: null,
  scopes: [],
  category: "send",
  ...overrides,
})

const request = (overrides: RequestExtras = {}) => requestFor("gmail.users.messages.send", { body: { to: "alice@example.com" }, ...overrides })

const config = (rules: PolicyRule[] = []): PluginConfig =>
  testConfig({
    accounts: { personal: account({ services: ["gmail", "drive"] }) },
    policy: { rules },
  })

describe("policy engine", () => {
  it("does not block a send unless a deny rule matches", () => {
    expect(evaluatePolicy(config(), entry(), "send", request()).effect).toBe("allow")
  })

  it("denies a matching category with a blanket deny rule", () => {
    const decision = evaluatePolicy(config([{ id: "no-send", effect: "deny", categories: ["send"], accounts: ["personal"], services: ["gmail"] }]), entry(), "send", request())
    expect(decision).toMatchObject({ effect: "deny", ruleId: "no-send" })
  })

  it("denies a recipient outside the allowed domains and allows one inside", () => {
    const rule: PolicyRule = { id: "send-domain", effect: "deny", categories: ["send"], allowedRecipientDomains: ["example.com"] }
    const outside = evaluatePolicy(config([rule]), entry(), "send", request({ body: { to: "alice@other.com" } }))
    expect(outside.effect).toBe("deny")
    expect(outside.violations.join(" ")).toMatch(/outside allowed domains/)
    expect(evaluatePolicy(config([rule]), entry(), "send", request()).effect).toBe("allow")
  })

  it("enforces an exact recipient list", () => {
    const rule: PolicyRule = { id: "self-only", effect: "deny", categories: ["send"], allowedRecipients: ["me@example.com"] }
    expect(evaluatePolicy(config([rule]), entry(), "send", request({ body: { to: "me@example.com" } })).effect).toBe("allow")
    expect(evaluatePolicy(config([rule]), entry(), "send", request({ body: { to: "other@example.com" } })).effect).toBe("deny")
  })

  it("denies public sharing when the rule disables it", () => {
    const decision = evaluatePolicy(
      config([{ id: "no-public", effect: "deny", categories: ["share"], allowPublicSharing: false }]),
      entry({ id: "drive.permissions.create", service: "drive", category: "share" }),
      "share",
      requestFor("drive.permissions.create", { body: { role: "anyone", type: "anyone" } }),
    )
    expect(decision.effect).toBe("deny")
    expect(decision.violations.join(" ")).toMatch(/public sharing/)
  })

  it("denies a service the account has not enabled", () => {
    const gmailOnly = config()
    gmailOnly.accounts.personal!.enabledServices = ["gmail"]
    const decision = evaluatePolicy(gmailOnly, entry({ service: "drive", id: "drive.files.list", category: "read" }), "read", requestFor("drive.files.list"))
    expect(decision.effect).toBe("deny")
    expect(decision.violations).toContain("service-disabled")
  })

  it("reads helper recipients from operation.input", () => {
    const decision = evaluatePolicy(
      config([{ id: "send-domain", effect: "deny", categories: ["send"], allowedRecipientDomains: ["example.com"] }]),
      entry({ id: "gmail.send", category: "send" }),
      "send",
      requestFor("gmail.send", { input: { to: "alice@other.com", subject: "s", body: "b" } }),
    )
    expect(decision.effect).toBe("deny")
    expect(decision.violations.join(" ")).toMatch(/outside allowed domains/)
  })

  it("checks helper attachment paths against allowed read roots", () => {
    const decision = evaluatePolicy(
      config([{ id: "root", effect: "deny", categories: ["send"], allowedReadRoots: ["/tmp/allowed"] }]),
      entry({ id: "gmail.send", category: "send" }),
      "send",
      requestFor("gmail.send", { input: { to: "alice@example.com", subject: "s", body: "b", attachments: ["/tmp/other/file.pdf"] } }),
    )
    expect(decision.effect).toBe("deny")
    expect(decision.violations.join(" ")).toMatch(/outside allowed read roots/)
  })

  it("denies a path outside the allowed write root", () => {
    const decision = evaluatePolicy(
      config([{ id: "root", effect: "deny", categories: ["export"], allowedWriteRoots: ["/tmp/allowed"] }]),
      entry({ id: "drive.files.export", service: "drive", category: "export" }),
      "export",
      requestFor("drive.files.export", { download: { path: "/tmp/other/file.pdf" } }),
    )
    expect(decision.effect).toBe("deny")
    expect(decision.violations.join(" ")).toMatch(/outside allowed write roots/)
  })

  it("never commits deploy or watch", () => {
    expect(evaluatePolicy(config(), entry({ category: "deploy" }), "deploy", request()).violations).toContain("never-committable")
    expect(evaluatePolicy(config(), entry({ category: "watch" }), "watch", request()).effect).toBe("deny")
  })
})
