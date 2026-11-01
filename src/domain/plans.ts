import { randomBytes } from "node:crypto"
import { GwsError } from "./errors.js"
import type { CommitCategory, Plan } from "./types.js"

/**
 * In-memory, single-use plan store. A plan is bound to the account,
 * session, agent, and category, holds the exact commit argv, and expires
 * after its TTL. It is consumed by exactly one commit attempt; a failed
 * commit does not resurrect it.
 */

const MAX_PLANS = 512

/**
 * The allowlisted preview fields any surface outside the commit itself may
 * show (permission prompts, /gws-status). Never argv, params, url, or a body.
 */
export interface RedactedPreview {
  method: string
  recipients?: string[]
  destination?: string
  bodySummary?: string
  reason?: string
}

export function redactedPreview(plan: Pick<Plan, "preview">): RedactedPreview {
  const { method, recipients, destination, bodySummary, reason } = plan.preview
  const view: RedactedPreview = { method }
  if (recipients && recipients.length > 0) view.recipients = [...recipients]
  if (destination !== undefined) view.destination = destination
  if (bodySummary !== undefined) view.bodySummary = bodySummary
  if (reason !== undefined) view.reason = reason
  return view
}

export class PlanStore {
  private readonly plans = new Map<string, Plan>()

  create(input: Omit<Plan, "id" | "state" | "createdAt" | "expiresAt"> & { ttlSeconds: number }): Plan {
    this.sweep()
    const now = Date.now()
    const { ttlSeconds, ...fields } = input
    const plan: Plan = {
      ...fields,
      id: `plan_${randomBytes(18).toString("base64url")}`,
      state: "ready",
      createdAt: now,
      expiresAt: now + ttlSeconds * 1000,
    }
    this.plans.set(plan.id, plan)
    while (this.plans.size > MAX_PLANS) {
      const oldest = this.plans.keys().next().value
      if (oldest === undefined) break
      const evicted = this.plans.get(oldest)
      if (evicted) this.expire(evicted)
      this.plans.delete(oldest)
    }
    return plan
  }

  get(id: string): Plan | undefined {
    const plan = this.plans.get(id)
    if (!plan) return undefined
    if (plan.state === "ready" && Date.now() >= plan.expiresAt) this.expire(plan)
    return plan
  }

  /** Ready (committable) plans, oldest first, optionally for one session. */
  list(filter: { sessionId?: string } = {}): Plan[] {
    const ready: Plan[] = []
    for (const id of [...this.plans.keys()]) {
      const plan = this.get(id)
      if (plan?.state !== "ready") continue
      if (filter.sessionId !== undefined && plan.sessionId !== filter.sessionId) continue
      ready.push(plan)
    }
    return ready.sort((a, b) => a.createdAt - b.createdAt)
  }

  /** Validate a commit binding without consuming the plan. */
  check(id: string, binding: { sessionId: string; agentId: string; category: CommitCategory }): Plan {
    const plan = this.get(id)
    if (!plan) throw new GwsError("PLAN_NOT_FOUND", "run gws_plan first")
    if (plan.state === "consumed") throw new GwsError("PLAN_ALREADY_USED", "create a new plan")
    if (plan.state === "expired" || Date.now() >= plan.expiresAt) throw new GwsError("PLAN_EXPIRED", "create a new plan")
    if (plan.state === "committing") throw new GwsError("PLAN_ALREADY_USED", "plan is committing", { next: "Wait for the running commit to finish; do not commit this plan again." })
    if (plan.sessionId !== binding.sessionId || plan.agentId !== binding.agentId) {
      throw new GwsError("PLAN_CALLER_MISMATCH", "a plan is bound to the session and agent that created it")
    }
    if (plan.category !== binding.category) {
      throw new GwsError("CATEGORY_MISMATCH", "use the commit tool that matches the plan category", { next: "Commit with the tool named by the plan's category, passing only {planId}." })
    }
    return plan
  }

  acquire(id: string, binding: { sessionId: string; agentId: string; account: string; category: CommitCategory }): Plan {
    const plan = this.check(id, binding)
    if (plan.account !== binding.account) {
      throw new GwsError("PLAN_CALLER_MISMATCH", "a plan is bound to the account that created it")
    }
    plan.state = "committing"
    return plan
  }

  complete(id: string): void {
    const plan = this.plans.get(id)
    if (plan?.state !== "committing") return
    plan.state = "consumed"
  }

  release(id: string): void {
    const plan = this.plans.get(id)
    if (plan && plan.state === "committing") this.expire(plan)
  }

  invalidateAll(): void {
    for (const plan of this.plans.values()) this.expire(plan)
  }

  private expire(plan: Plan): void {
    if (plan.state !== "ready" && plan.state !== "committing") return
    plan.state = "expired"
  }

  private sweep(): void {
    const now = Date.now()
    for (const [id, plan] of this.plans) {
      if (plan.state === "ready" && now >= plan.expiresAt) this.expire(plan)
      if (plan.state === "consumed" || plan.state === "expired" || now >= plan.expiresAt) {
        this.plans.delete(id)
      }
    }
  }
}
