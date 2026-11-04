import { describe, expect, it } from "vitest"
import { evaluatePolicy, type PolicyFacts } from "../src/domain/policy.js"
import { recipientPlan } from "../src/domain/recipients.js"
import type { Category, MethodEntry, PluginConfig, PolicyRule, Request } from "../src/domain/types.js"
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

const raw = (to: string) => Buffer.from(`To: ${to}\r\nSubject: s\r\n\r\nHello`).toString("base64url")
const request = (overrides: RequestExtras = {}) => requestFor("gmail.users.messages.send", { body: { raw: raw("alice@example.com") }, ...overrides })

/** The facts the runtime resolves for a request that needs no read. */
const facts = (entry: MethodEntry, category: Category, req: Request, accountDomains?: string[]): PolicyFacts => ({
  recipients: recipientPlan(entry.id, category, req).known,
  accountDomains,
})
const evaluate = (config: PluginConfig, entry: MethodEntry, category: Category, req: Request, accountDomains?: string[]) =>
  evaluatePolicy(config, entry, category, req, facts(entry, category, req, accountDomains))

const config = (rules: PolicyRule[] = []): PluginConfig =>
  testConfig({
    accounts: { personal: account({ services: ["gmail", "drive"] }) },
    policy: { rules },
  })

describe("policy engine", () => {
  it("does not block a send unless a deny rule matches", () => {
    expect(evaluate(config(), entry(), "send", request()).effect).toBe("allow")
  })

  it("denies a matching category with a blanket deny rule", () => {
    const decision = evaluate(config([{ id: "no-send", effect: "deny", categories: ["send"], accounts: ["personal"], services: ["gmail"] }]), entry(), "send", request())
    expect(decision).toMatchObject({ effect: "deny", ruleId: "no-send" })
  })

  it("denies a recipient outside the allowed domains and allows one inside", () => {
    const rule: PolicyRule = { id: "send-domain", effect: "deny", categories: ["send"], allowedRecipientDomains: ["example.com"] }
    const outside = evaluate(config([rule]), entry(), "send", request({ body: { raw: raw("alice@other.com") } }))
    expect(outside.effect).toBe("deny")
    expect(outside.violations.join(" ")).toMatch(/outside allowed domains/)
    expect(evaluate(config([rule]), entry(), "send", request()).effect).toBe("allow")
  })

  it("enforces an exact recipient list", () => {
    const rule: PolicyRule = { id: "self-only", effect: "deny", categories: ["send"], allowedRecipients: ["me@example.com"] }
    expect(evaluate(config([rule]), entry(), "send", request({ body: { raw: raw("me@example.com") } })).effect).toBe("allow")
    expect(evaluate(config([rule]), entry(), "send", request({ body: { raw: raw("other@example.com") } })).effect).toBe("deny")
  })

  it("denies public sharing when the rule disables it", () => {
    const decision = evaluate(
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
    const decision = evaluate(gmailOnly, entry({ service: "drive", id: "drive.files.list", category: "read" }), "read", requestFor("drive.files.list"))
    expect(decision.effect).toBe("deny")
    expect(decision.violations).toContain("service-disabled")
  })

  it("reads helper recipients from operation.input", () => {
    const decision = evaluate(
      config([{ id: "send-domain", effect: "deny", categories: ["send"], allowedRecipientDomains: ["example.com"] }]),
      entry({ id: "gmail.send", category: "send" }),
      "send",
      requestFor("gmail.send", { input: { to: "alice@other.com", subject: "s", body: "b" } }),
    )
    expect(decision.effect).toBe("deny")
    expect(decision.violations.join(" ")).toMatch(/outside allowed domains/)
  })

  it("checks helper attachment paths against allowed read roots", () => {
    const decision = evaluate(
      config([{ id: "root", effect: "deny", categories: ["send"], allowedReadRoots: ["/tmp/allowed"] }]),
      entry({ id: "gmail.send", category: "send" }),
      "send",
      requestFor("gmail.send", { input: { to: "alice@example.com", subject: "s", body: "b", attachments: ["/tmp/other/file.pdf"] } }),
    )
    expect(decision.effect).toBe("deny")
    expect(decision.violations.join(" ")).toMatch(/outside allowed read roots/)
  })

  it("denies a path outside the allowed write root", () => {
    const decision = evaluate(
      config([{ id: "root", effect: "deny", categories: ["export"], allowedWriteRoots: ["/tmp/allowed"] }]),
      entry({ id: "drive.files.export", service: "drive", category: "export" }),
      "export",
      requestFor("drive.files.export", { download: { path: "/tmp/other/file.pdf" } }),
    )
    expect(decision.effect).toBe("deny")
    expect(decision.violations.join(" ")).toMatch(/outside allowed write roots/)
  })

  it("never commits deploy or watch", () => {
    expect(evaluate(config(), entry({ category: "deploy" }), "deploy", request()).violations).toContain("never-committable")
    expect(evaluate(config(), entry({ category: "watch" }), "watch", request()).effect).toBe("deny")
  })

  it("skips only the recipient constraints while recipients are pending", () => {
    const rule: PolicyRule = { id: "send-domain", effect: "deny", categories: ["send"], allowedRecipientDomains: ["example.com"] }
    const outside = request({ body: { raw: raw("alice@other.com") } })
    expect(evaluatePolicy(config([rule]), entry(), "send", outside, "pending").effect).toBe("allow")
    expect(evaluatePolicy(config([{ id: "no-send", effect: "deny", categories: ["send"] }]), entry(), "send", outside, "pending").effect).toBe("deny")
  })

  it("says RECIPIENTS_UNKNOWN only when nothing else denies", () => {
    const rule: PolicyRule = { id: "send-domain", effect: "deny", categories: ["send"], allowedRecipientDomains: ["example.com"] }
    const unknown = { recipients: { addresses: ["alice@other.com"], domains: [], unknown: "the draft could not be read" } }
    expect(evaluatePolicy(config([rule]), entry(), "send", request(), { recipients: { ...unknown.recipients, addresses: [] } })).toMatchObject({ effect: "deny", code: "RECIPIENTS_UNKNOWN" })
    expect(evaluatePolicy(config([rule]), entry(), "send", request(), unknown)).toMatchObject({ effect: "deny", code: "POLICY_DENIED" })
  })

  it("measures external recipients against the account's domains", () => {
    const rule: PolicyRule = { id: "internal", effect: "deny", categories: ["send"], allowExternalRecipients: false }
    const all = request({ body: { raw: raw("a@evil.com, b@evil.com") } })
    expect(evaluate(config([rule]), entry(), "send", all, ["example.com"]).effect).toBe("deny")
    expect(evaluate(config([rule]), entry(), "send", request(), ["example.com"]).effect).toBe("allow")
    expect(evaluate(config([rule]), entry(), "send", request())).toMatchObject({ effect: "deny", code: "ACCOUNT_DOMAIN_UNKNOWN" })
  })

  it("checks a domain share against every recipient constraint", () => {
    const share = entry({ id: "drive.permissions.create", service: "drive", category: "share" })
    const req = requestFor("drive.permissions.create", { body: { role: "reader", type: "domain", domain: "other.com" } })
    for (const rule of [
      { id: "domains", effect: "deny", allowedRecipientDomains: ["example.com"] },
      { id: "exact", effect: "deny", allowedRecipients: ["alice@example.com"] },
      { id: "denied", effect: "deny", deniedRecipientDomains: ["other.com"] },
    ] satisfies PolicyRule[]) {
      expect(evaluate(config([rule]), share, "share", req).violations.join(" ")).toMatch(/\*@other\.com/)
    }
  })
})
