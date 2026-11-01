import { describe, expect, it } from "vitest"
import { PlanStore, redactedPreview } from "../src/domain/plans.js"

const binding = { sessionId: "ses_1", agentId: "build", account: "personal", category: "send" as const }

function store(): PlanStore {
  const plans = new PlanStore()
  plans.create({
    account: "personal",
    sessionId: "ses_1",
    agentId: "build",
    category: "send",
    operation: "gmail.users.messages.send",
    service: "gmail",
    argv: ["gmail", "users", "messages", "send"],
    preview: { method: "POST", params: {}, account: "personal", category: "send" },
    ttlSeconds: 300,
  })
  return plans
}

describe("plan store", () => {
  it("is single-use", () => {
    const plans = store()
    const [id] = [...plans["plans"].keys()]
    plans.acquire(id!, binding)
    plans.complete(id!)
    expect(() => plans.acquire(id!, binding)).toThrow(/PLAN_ALREADY_USED/)
  })

  it("checks a binding without consuming the plan", () => {
    const plans = store()
    const [id] = [...plans["plans"].keys()]
    expect(plans.check(id!, binding).state).toBe("ready")
    expect(() => plans.check(id!, { ...binding, category: "write" })).toThrow(/CATEGORY_MISMATCH/)
    expect(() => plans.check(id!, { ...binding, agentId: "other" })).toThrow(/PLAN_CALLER_MISMATCH/)
    expect(plans.acquire(id!, binding).state).toBe("committing")
    expect(() => plans.check(id!, binding)).toThrow(/PLAN_ALREADY_USED/)
  })

  it("rejects a category mismatch", () => {
    const plans = store()
    const [id] = [...plans["plans"].keys()]
    expect(() => plans.acquire(id!, { ...binding, category: "delete" })).toThrow(/CATEGORY_MISMATCH/)
  })

  it("rejects a different session or agent", () => {
    const plans = store()
    const [id] = [...plans["plans"].keys()]
    expect(() => plans.acquire(id!, { ...binding, sessionId: "ses_2" })).toThrow(/PLAN_CALLER_MISMATCH/)
  })

  it("reports a different account as a caller mismatch and leaves the plan ready", () => {
    const plans = store()
    const [id] = [...plans["plans"].keys()]
    expect(() => plans.acquire(id!, { ...binding, account: "work" })).toThrow(/^PLAN_CALLER_MISMATCH:/)
    expect(plans.get(id!)?.state).toBe("ready")
  })

  it("expires a plan at its TTL", () => {
    const plans = store()
    const [id, plan] = [...plans["plans"].entries()][0]!
    plan.expiresAt = Date.now() - 1
    expect(() => plans.acquire(id, binding)).toThrow(/PLAN_EXPIRED/)
  })

  it("invalidates all plans on reload", () => {
    const plans = store()
    const [id] = [...plans["plans"].keys()]
    plans.invalidateAll()
    expect(() => plans.acquire(id!, binding)).toThrow(/PLAN_EXPIRED/)
  })

  it("lists ready plans only, optionally for one session", () => {
    const plans = store()
    const [first] = [...plans["plans"].keys()]
    const other = plans.create({ ...plans.get(first!)!, sessionId: "ses_2", ttlSeconds: 300 })
    expect(plans.list().map((plan) => plan.id)).toEqual([first, other.id])
    expect(plans.list({ sessionId: "ses_2" }).map((plan) => plan.id)).toEqual([other.id])
    plans.acquire(first!, binding)
    expect(plans.list().map((plan) => plan.id)).toEqual([other.id])
  })

  it("keeps a redacted preview to the allowlisted fields", () => {
    const preview = redactedPreview({
      preview: {
        method: "POST",
        url: "gmail/v1/users/{userId}/messages/send",
        params: { q: "secret" },
        bodySummary: "object(raw) 10 bytes",
        recipients: [],
        account: "personal",
        category: "send",
      },
    })
    expect(preview).toEqual({ method: "POST", bodySummary: "object(raw) 10 bytes" })
  })
})
