import { underRoot as insideRoot } from "./files.js"
import type { Category, MethodEntry, PluginConfig, PolicyRule, Request } from "./types.js"

/**
 * Inner policy gate. OpenCode permissions are the outer gate; this is
 * evaluated after the manifest resolves a command and before a read runs
 * or a plan is created. A plugin deny is absolute.
 *
 * Rules are deny-only. A rule with no constraint denies whatever it matches.
 * A rule with a constraint denies only when that constraint is violated.
 * Deploy and watch are never committable. Admin is the admin gate, not a rule.
 */

export interface PolicyDecision {
  /** `allow` means plugin policy does not block. Commits still ask through the host rules. */
  effect: "allow" | "deny"
  ruleId?: string
  violations: string[]
  constraints: {
    maxPages: number
    maxItems: number
    maxUploadBytes: number
    maxDownloadBytes: number
    /** Read-root sets that apply (config, then each matching rule); a file must be inside every set. */
    readRoots: string[][]
    writeRoots: string[][]
  }
}

function wildcard(pattern: string): RegExp {
  return new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`)
}

function matches(rule: PolicyRule, category: Category, account: string, service: string, operation: string): boolean {
  if (rule.categories && !rule.categories.includes(category)) return false
  if (rule.accounts && !rule.accounts.includes(account)) return false
  if (rule.services && !rule.services.includes(service)) return false
  if (rule.operations && !rule.operations.some((pattern) => wildcard(pattern).test(operation))) return false
  return true
}

function underRoot(path: string, roots: readonly string[]): boolean {
  return roots.some((root) => insideRoot(path, root))
}

function collectEmails(value: unknown, out: Set<string>): void {
  if (typeof value === "string") {
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) out.add(value.toLowerCase())
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) collectEmails(item, out)
    return
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (key === "email" || key === "emailAddress" || key === "address" || key === "to" || key === "cc" || key === "bcc" || key === "recipient" || key === "attendees") {
        collectEmails(item, out)
      } else if (typeof item === "object") {
        collectEmails(item, out)
      }
    }
  }
}

function emails(request: Request): string[] {
  const out = new Set<string>()
  collectEmails(request.params, out)
  collectEmails(request.body, out)
  collectEmails(request.input, out)
  return [...out]
}

function helperPaths(request: Request, keys: readonly string[]): string[] {
  const input = request.input
  if (!input || typeof input !== "object") return []
  const out: string[] = []
  for (const key of keys) {
    const value = (input as Record<string, unknown>)[key]
    if (typeof value === "string" && value.length > 0) out.push(value)
    if (Array.isArray(value)) {
      for (const item of value) if (typeof item === "string" && item.length > 0) out.push(item)
    }
  }
  return out
}

function publicSharing(request: Request): boolean {
  const haystack = JSON.stringify({ params: request.params ?? {}, body: request.body ?? {}, input: request.input ?? {} }).toLowerCase()
  return /"role"\s*:\s*"(anyone|public)"/.test(haystack) || /"type"\s*:\s*"(anyone|public)"/.test(haystack)
}

function domain(email: string): string {
  return email.slice(email.lastIndexOf("@") + 1)
}

/** A rule with no constraint field is a blanket deny of whatever it matches. */
function constrained(rule: PolicyRule): boolean {
  return (
    rule.allowedRecipientDomains !== undefined ||
    rule.allowedRecipients !== undefined ||
    rule.deniedRecipientDomains !== undefined ||
    rule.allowExternalRecipients !== undefined ||
    rule.allowPublicSharing !== undefined ||
    rule.allowedReadRoots !== undefined ||
    rule.allowedWriteRoots !== undefined ||
    rule.maxPages !== undefined ||
    rule.maxItems !== undefined
  )
}

export function evaluatePolicy(
  config: PluginConfig,
  entry: MethodEntry,
  category: Category,
  request: Request,
): PolicyDecision {
  const constraints = {
    maxPages: config.execution.maxPages,
    maxItems: config.execution.maxItems,
    maxUploadBytes: config.execution.maxUploadBytes,
    maxDownloadBytes: config.execution.maxDownloadBytes,
    readRoots: config.execution.allowedReadRoots.length > 0 ? [config.execution.allowedReadRoots] : [],
    writeRoots: config.execution.allowedWriteRoots.length > 0 ? [config.execution.allowedWriteRoots] : [],
  }
  const violations: string[] = []

  if (entry.category === "deny" || entry.schemaError) {
    return { effect: "deny", violations: ["manifest-deny"], constraints }
  }
  if (!config.accounts[request.account]) {
    return { effect: "deny", violations: ["account-unknown"], constraints }
  }
  const profile = config.accounts[request.account]!
  const service = entry.service
  if (!profile.enabledServices.includes(service)) {
    return { effect: "deny", violations: ["service-disabled"], constraints }
  }

  // Deploy and watch are never committable, whatever a rule says.
  if (category === "deploy" || category === "watch" || category === "deny") {
    return { effect: "deny", violations: ["never-committable"], constraints }
  }

  // Admin is a separately gated authority: the config switch must be on and
  // the service must be in the admin allowlist, independent of any rule.
  // The host ask rule is the human prompt; policy does not also require an allow rule.
  if (category === "admin") {
    if (!config.admin.enabled) {
      return { effect: "deny", violations: ["admin-disabled"], constraints }
    }
    if (!config.admin.allowedServices.includes(service)) {
      return { effect: "deny", violations: ["admin-service-not-allowed"], constraints }
    }
  }

  let denied = false
  let ruleId: string | undefined

  const recipients = emails(request)
  const readPaths = [
    ...(request.upload?.path ? [request.upload.path] : []),
    ...helperPaths(request, ["path", "file", "filePath", "source", "attachments"]),
  ]
  const writePaths = [
    ...(request.download?.path ? [request.download.path] : []),
    ...helperPaths(request, ["destination", "output", "outPath"]),
  ]
  const external = recipients.filter((email) => domain(email) !== domain(recipients[0] ?? ""))
  const isPublic = publicSharing(request)

  for (const rule of config.policy.rules) {
    if (!matches(rule, category, request.account, service, entry.id)) continue
    const before = violations.length

    if (rule.allowedRecipientDomains && recipients.length > 0) {
      const allowed = new Set(rule.allowedRecipientDomains.map((value) => value.toLowerCase()))
      const bad = recipients.filter((email) => !allowed.has(domain(email)))
      if (bad.length > 0) violations.push(`recipients outside allowed domains: ${bad.join(", ")}`)
    }
    if (rule.allowedRecipients && recipients.length > 0) {
      const allowed = new Set(rule.allowedRecipients.map((value) => value.trim().toLowerCase()))
      const bad = recipients.filter((email) => !allowed.has(email))
      if (bad.length > 0) violations.push(`recipients not in allowedRecipients: ${bad.join(", ")}`)
    }
    if (rule.deniedRecipientDomains) {
      const denied = new Set(rule.deniedRecipientDomains.map((value) => value.toLowerCase()))
      const bad = recipients.filter((email) => denied.has(domain(email)))
      if (bad.length > 0) violations.push(`recipients in denied domains: ${bad.join(", ")}`)
    }
    if (rule.allowExternalRecipients === false && external.length > 0) {
      violations.push(`external recipients are disabled: ${external.join(", ")}`)
    }
    if (rule.allowPublicSharing === false && isPublic) {
      violations.push("public sharing is disabled")
    }
    if (rule.allowedReadRoots) {
      constraints.readRoots.push(rule.allowedReadRoots)
      for (const path of readPaths) {
        if (!underRoot(path, rule.allowedReadRoots)) violations.push(`upload path is outside allowed read roots: ${path}`)
      }
    }
    if (rule.allowedWriteRoots) {
      constraints.writeRoots.push(rule.allowedWriteRoots)
      for (const path of writePaths) {
        if (!underRoot(path, rule.allowedWriteRoots)) violations.push(`download path is outside allowed write roots: ${path}`)
      }
    }
    if (rule.maxPages) constraints.maxPages = Math.min(constraints.maxPages, rule.maxPages)
    if (rule.maxItems) constraints.maxItems = Math.min(constraints.maxItems, rule.maxItems)
    // A rule with no constraint is a blanket deny. A constraint rule denies only when it is violated.
    if (!constrained(rule) || violations.length > before) {
      denied = true
      ruleId = rule.id
    }
  }

  if (config.execution.allowedReadRoots.length > 0) {
    for (const path of readPaths) {
      if (!underRoot(path, config.execution.allowedReadRoots)) violations.push(`upload path is outside allowed read roots: ${path}`)
    }
  }
  if (config.execution.allowedWriteRoots.length > 0) {
    for (const path of writePaths) {
      if (!underRoot(path, config.execution.allowedWriteRoots)) violations.push(`download path is outside allowed write roots: ${path}`)
    }
  }

  if (category === "admin" && config.admin.requireReason && !request.reason?.trim()) {
    violations.push("admin plans require a non-empty reason")
  }

  if (violations.length > 0 || denied) {
    return { effect: "deny", ruleId, violations: violations.length > 0 ? violations : [`denied by rule ${ruleId ?? "policy"}`], constraints }
  }
  return { effect: "allow", ruleId, violations, constraints }
}
