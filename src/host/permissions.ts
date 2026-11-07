import { redactedPreview } from "../domain/plans.js"
import type { Plan } from "../domain/types.js"
import type { Target } from "../runtime/operations.js"

/**
 * Host permission bridge. OpenCode only hides a tool for a `deny` rule on
 * its `options.permission` action; an `ask` rule takes effect only when the
 * tool calls `permission.assert`. These builders produce that input. They
 * are pure so the exact resources, save patterns, and redacted metadata are
 * testable without a host.
 */

/** A tool call in a session. */
interface ToolCall {
  sessionID: string
  agent: string
  messageID: string
  id: string
}

export type Caller = ToolCall

export interface PermissionRequest {
  sessionID: string
  agent: string
  action: string
  resources: string[]
  save?: string[]
  metadata: Record<string, unknown>
  source: { type: "tool"; messageID: string; id: string }
}

function resource(account: string, operation: string): string {
  return `${account}:${operation}`
}

function base(call: Caller, action: string): Pick<PermissionRequest, "sessionID" | "agent" | "action" | "source"> {
  return {
    sessionID: call.sessionID,
    agent: call.agent,
    action,
    source: { type: "tool", messageID: call.messageID, id: call.id },
  }
}

/** Local, account-free tools (status, catalog). */
export function localRequest(call: Caller, action: string): PermissionRequest {
  return { ...base(call, action), resources: ["*"], save: ["*"], metadata: {} }
}

/** Account-scoped tools that resolve an operation (schema, read, plan). */
export function operationRequest(
  call: Caller,
  action: string,
  target: Pick<Target, "account" | "operation" | "service"> & Partial<Pick<Target, "category">>,
): PermissionRequest {
  const id = resource(target.account, target.operation)
  return {
    ...base(call, action),
    resources: [id],
    save: [id],
    metadata: compact({ account: target.account, operation: target.operation, service: target.service, category: target.category }),
  }
}

/** Redacted, allowlisted view of a stored plan for the approval UI. */
export function planMetadata(plan: Plan): Record<string, unknown> {
  return compact({
    planId: plan.id,
    category: plan.category,
    operation: plan.operation,
    account: plan.account,
    ...redactedPreview(plan),
    expiresAt: new Date(plan.expiresAt).toISOString(),
  })
}

const SAVABLE = new Set(["write", "export"])

/**
 * Commit assertion: `gws.<category>` on `<account>:<operation>`. Write and
 * export offer "Always" for that exact resource. Send, share, delete, and
 * admin pass no save, so they ask every time unless a user rule allows them.
 */
export function commitRequests(call: Caller, action: string, plan: Plan): PermissionRequest[] {
  const id = resource(plan.account, plan.operation)
  const request: PermissionRequest = { ...base(call, action), resources: [id], metadata: planMetadata(plan) }
  if (SAVABLE.has(plan.category)) request.save = [id]
  return [request]
}

function compact(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined))
}
