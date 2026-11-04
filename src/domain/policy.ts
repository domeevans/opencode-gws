import { underRoot as insideRoot } from "./files.js"
import { domainOf, type Recipients } from "./recipients.js"
import type { Category, MethodEntry, PluginConfig, PolicyRule, Request } from "./types.js"

/**
 * Inner policy gate. OpenCode permissions are the outer gate; this is
 * evaluated after the manifest resolves a command and before a read runs
 * or a plan is created. A plugin deny is absolute.
 *
 * Rules are deny-only. A rule with no constraint denies whatever it matches.
 * A rule with a constraint denies only when that constraint is violated.
 * Deploy and watch are never committable. Admin is the admin gate, not a rule.
 *
 * Recipient constraints fail closed: when a matching rule limits
 * recipients and the recipients of the call could not all be determined,
 * or `allowExternalRecipients: false` applies and the account's own domain
 * is unknown, the call is refused.
 */

/** What the recipient constraints check, resolved by the runtime. */
export interface PolicyFacts {
  recipients: Recipients
  /** The account's own email domains, for allowExternalRecipients; undefined when unknown. */
  accountDomains?: readonly string[]
}

export interface PolicyDecision {
  /** `allow` means plugin policy does not block. Commits still ask through the host rules. */
  effect: "allow" | "deny"
  ruleId?: string
  violations: string[]
  /**
   * The code a deny raises: RECIPIENTS_UNKNOWN or ACCOUNT_DOMAIN_UNKNOWN
   * when that is the only reason, POLICY_DENIED otherwise.
   */
  code: "POLICY_DENIED" | "RECIPIENTS_UNKNOWN" | "ACCOUNT_DOMAIN_UNKNOWN"
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

/** True when a rule limits who a call may reach. */
function limitsRecipients(rule: PolicyRule): boolean {
  return (
    rule.allowedRecipientDomains !== undefined ||
    rule.allowedRecipients !== undefined ||
    rule.deniedRecipientDomains !== undefined ||
    rule.allowExternalRecipients === false
  )
}

/** The rules that match a call. */
function matching(config: PluginConfig, entry: MethodEntry, category: Category, request: Request): PolicyRule[] {
  return config.policy.rules.filter((rule) => matches(rule, category, request.account, entry.service, entry.id))
}

/** True when a matching rule sets allowExternalRecipients to false, so the account's own domain is needed. */
export function needsAccountDomains(config: PluginConfig, entry: MethodEntry, category: Category, request: Request): boolean {
  return matching(config, entry, category, request).some((rule) => rule.allowExternalRecipients === false)
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

/**
 * Evaluate the plugin policy for one call. `facts` carries the resolved
 * recipients; `"pending"` skips the recipient constraints, for the check
 * before a plan's recipients are read. The plan then evaluates again with
 * the facts, so a recipient constraint is never skipped for a commit.
 */
export function evaluatePolicy(
  config: PluginConfig,
  entry: MethodEntry,
  category: Category,
  request: Request,
  facts: PolicyFacts | "pending",
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
  const refuse = (violation: string): PolicyDecision => ({ effect: "deny", violations: [violation], constraints, code: "POLICY_DENIED" })

  if (entry.category === "deny" || entry.schemaError) return refuse("manifest-deny")
  if (!config.accounts[request.account]) return refuse("account-unknown")
  const profile = config.accounts[request.account]!
  const service = entry.service
  if (!profile.enabledServices.includes(service)) return refuse("service-disabled")

  // Deploy and watch are never committable, whatever a rule says.
  if (category === "deploy" || category === "watch" || category === "deny") return refuse("never-committable")

  // Admin is a separately gated authority: the config switch must be on and
  // the service must be in the admin allowlist, independent of any rule.
  // The host ask rule is the human prompt; policy does not also require an allow rule.
  if (category === "admin") {
    if (!config.admin.enabled) return refuse("admin-disabled")
    if (!config.admin.allowedServices.includes(service)) return refuse("admin-service-not-allowed")
  }

  let denied = false
  let ruleId: string | undefined
  // Violations that only say something could not be determined.
  let unknownRecipients = 0
  let unknownDomain = 0

  const readPaths = [
    ...(request.upload?.path ? [request.upload.path] : []),
    ...helperPaths(request, ["path", "file", "filePath", "source", "attachments"]),
  ]
  const writePaths = [
    ...(request.download?.path ? [request.download.path] : []),
    ...helperPaths(request, ["destination", "output", "outPath"]),
  ]
  const recipients = facts === "pending" ? undefined : facts.recipients
  // Each address, and each domain shared with as a whole.
  const targets = recipients
    ? [
        ...recipients.addresses.map((address) => ({ label: address, address, domain: domainOf(address) })),
        ...recipients.domains.map((domain) => ({ label: `*@${domain}`, address: undefined, domain })),
      ]
    : []
  const own = facts === "pending" || !facts.accountDomains ? undefined : new Set(facts.accountDomains.map((value) => value.toLowerCase()))
  const isPublic = publicSharing(request) || recipients?.public === true

  for (const rule of matching(config, entry, category, request)) {
    const before = violations.length

    if (recipients && limitsRecipients(rule)) {
      if (recipients.unknown) {
        violations.push(`rule ${rule.id} limits recipients, but they could not be determined: ${recipients.unknown}`)
        unknownRecipients++
      }
      if (rule.allowedRecipientDomains) {
        const allowed = new Set(rule.allowedRecipientDomains.map((value) => value.toLowerCase()))
        const bad = targets.filter((target) => !allowed.has(target.domain))
        if (bad.length > 0) violations.push(`recipients outside allowed domains: ${bad.map((target) => target.label).join(", ")}`)
      }
      if (rule.allowedRecipients) {
        const allowed = new Set(rule.allowedRecipients.map((value) => value.trim().toLowerCase()))
        const bad = targets.filter((target) => target.address === undefined || !allowed.has(target.address))
        if (bad.length > 0) violations.push(`recipients not in allowedRecipients: ${bad.map((target) => target.label).join(", ")}`)
      }
      if (rule.deniedRecipientDomains) {
        const deniedDomains = new Set(rule.deniedRecipientDomains.map((value) => value.toLowerCase()))
        const bad = targets.filter((target) => deniedDomains.has(target.domain))
        if (bad.length > 0) violations.push(`recipients in denied domains: ${bad.map((target) => target.label).join(", ")}`)
      }
      if (rule.allowExternalRecipients === false && (targets.length > 0 || recipients.unknown)) {
        if (!own) {
          violations.push(`rule ${rule.id} disables external recipients, but the account's own domain is unknown`)
          unknownDomain++
        } else {
          const external = targets.filter((target) => !own.has(target.domain))
          if (external.length > 0) violations.push(`external recipients are disabled: ${external.map((target) => target.label).join(", ")}`)
        }
      }
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
    // A definite violation is final; an unknown alone says what to supply.
    const definite = violations.length - unknownRecipients - unknownDomain
    const code = definite > 0 || violations.length === 0 ? "POLICY_DENIED" : unknownRecipients > 0 ? "RECIPIENTS_UNKNOWN" : "ACCOUNT_DOMAIN_UNKNOWN"
    return { effect: "deny", ruleId, violations: violations.length > 0 ? violations : [`denied by rule ${ruleId ?? "policy"}`], constraints, code }
  }
  return { effect: "allow", ruleId, violations, constraints, code: "POLICY_DENIED" }
}
