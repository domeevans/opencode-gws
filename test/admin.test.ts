import { describe, expect, it } from "vitest"
import { PlanStore } from "../src/domain/plans.js"
import { evaluatePolicy } from "../src/domain/policy.js"
import type { MethodEntry } from "../src/domain/types.js"
import { account, testConfig } from "./support/config.js"
import { request, type RequestExtras } from "./support/requests.js"

const configWith = (extra: Record<string, unknown> = {}) =>
  testConfig({
    accounts: { personal: account({ services: ["admin-reports", "modelarmor", "gmail"] }) },
    policy: { rules: [] },
    ...extra,
  })

const adminEntry = (overrides: Partial<MethodEntry> = {}): MethodEntry => ({
  id: "admin-reports.activities.watch",
  service: "admin-reports",
  path: ["activities"],
  method: "watch",
  httpMethod: "POST",
  pathTemplate: "admin/reports/v1/activity/users/{userKey}/applications/{applicationName}/watch",
  scopes: [],
  category: "admin",
  ...overrides,
})

const adminRequest = (overrides: RequestExtras = {}) =>
  request("admin-reports.activities.watch", { reason: "investigate a reported audit gap", ...overrides })

function adminConfig(admin: Record<string, unknown> = { enabled: true }, rules: unknown[] = []) {
  return configWith({
    admin,
    policy: { rules },
  })
}

describe("admin surface", () => {
  it("opens the admin gate by default, for every admin service, with a reason required", () => {
    const config = configWith()
    expect(config.admin.enabled).toBe(true)
    expect(config.admin.requireReason).toBe(true)
    expect(config.admin.allowedServices).toEqual(["admin-reports", "drive", "modelarmor"])
    expect(evaluatePolicy(config, adminEntry(), "admin", adminRequest()).effect).toBe("allow")
  })

  it("denies every admin service when admin.allowedServices is an explicit empty array, gate on by default", () => {
    const config = configWith({ admin: { allowedServices: [] } })
    expect(config.admin.enabled).toBe(true)
    expect(config.admin.allowedServices).toEqual([])
    expect(evaluatePolicy(config, adminEntry(), "admin", adminRequest()).effect).toBe("deny")
  })

  it("denies admin when admin.enabled is false", () => {
    const decision = evaluatePolicy(adminConfig({ enabled: false }), adminEntry(), "admin", adminRequest())
    expect(decision.effect).toBe("deny")
    expect(decision.violations).toContain("admin-disabled")
  })

  it("permits admin when the gate is open, without a policy allow rule", () => {
    const decision = evaluatePolicy(adminConfig({ enabled: true }, []), adminEntry(), "admin", adminRequest())
    expect(decision.effect).toBe("allow")
  })

  it("still denies admin when a deny rule names the admin category", () => {
    const decision = evaluatePolicy(
      adminConfig({ enabled: true }, [{ id: "no-admin", effect: "deny", categories: ["admin"] }]),
      adminEntry(),
      "admin",
      adminRequest(),
    )
    expect(decision.effect).toBe("deny")
    expect(decision.ruleId).toBe("no-admin")
  })

  it("denies an admin plan without a reason when requireReason is default", () => {
    const config = adminConfig()
    const missing = evaluatePolicy(config, adminEntry(), "admin", adminRequest({ reason: undefined }))
    expect(missing.effect).toBe("deny")
    expect(missing.violations).toContain("admin plans require a non-empty reason")

    const blank = evaluatePolicy(config, adminEntry(), "admin", adminRequest({ reason: "   " }))
    expect(blank.effect).toBe("deny")
    expect(blank.violations).toContain("admin plans require a non-empty reason")
  })

  it("allows a missing reason only when requireReason is false", () => {
    const decision = evaluatePolicy(
      adminConfig({ enabled: true, requireReason: false }),
      adminEntry(),
      "admin",
      adminRequest({ reason: undefined }),
    )
    expect(decision.effect).toBe("allow")
  })

  it("denies an admin-class service outside admin.allowedServices", () => {
    const decision = evaluatePolicy(
      adminConfig({ enabled: true, allowedServices: ["modelarmor"] }),
      adminEntry(),
      "admin",
      adminRequest(),
    )
    expect(decision.effect).toBe("deny")
    expect(decision.violations).toContain("admin-service-not-allowed")
  })

  it("rejects a write commit for an admin plan (category mismatch)", () => {
    const plans = new PlanStore()
    const plan = plans.create({
      account: "personal",
      sessionId: "ses_1",
      agentId: "build",
      category: "admin",
      operation: "admin-reports.activities.watch",
      service: "admin-reports",
      argv: ["admin-reports", "activities", "watch"],
      preview: {
        method: "POST",
        params: {},
        account: "personal",
        category: "admin",
        reason: "investigate a reported audit gap",
      },
      ttlSeconds: 300,
    })

    const binding = { sessionId: "ses_1", agentId: "build", account: "personal" }
    expect(() => plans.acquire(plan.id, { ...binding, category: "write" })).toThrow(/CATEGORY_MISMATCH/)
    expect(() => plans.acquire(plan.id, { ...binding, category: "admin" })).not.toThrow()
  })
})
