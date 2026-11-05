/**
 * Shared domain types. Host-agnostic: nothing here knows about OpenCode.
 * Types the model sends or receives are inferred from contract.ts.
 */

import type { HelperEntry, Preview, RequestInput } from "./contract.js"
import type { FileSpecs, PlannedFiles } from "./files.js"

export type { HelperEntry } from "./contract.js"

export const CATEGORIES = [
  "read",
  "write",
  "send",
  "share",
  "delete",
  "export",
  "admin",
  "deploy",
  "watch",
  "deny",
] as const

export type Category = (typeof CATEGORIES)[number]
export type CommitCategory = Extract<Category, "write" | "send" | "share" | "delete" | "export" | "admin">

export interface MethodEntry {
  id: string
  service: string
  path: string[]
  method: string
  httpMethod: string
  pathTemplate: string | null
  scopes: string[]
  category: Category
  /** The first sentence of the Discovery description; absent when gws schema failed. */
  description?: string
  schemaError?: string
}

interface ServiceEntry {
  alias: string
  methods: MethodEntry[]
  helpers: HelperEntry[]
}

export interface Manifest {
  gwsVersion: string
  generatedAt: string
  services: ServiceEntry[]
}

/** What a sign-in may do: read only, or read and write. */
export type AccessLevel = "read" | "write"

/**
 * A Google OAuth client: a Desktop app client, or a Web application client
 * with the redirect URIs registered on it (its secret is confidential).
 */
export interface OAuthClient {
  clientId: string
  clientSecret: string
  /** Present only for a Web application client: its authorised redirect URIs, exactly as registered. */
  redirectUris?: string[]
}

/** Where Google sends the browser after consent, when the host supplies it. */
export interface RedirectConfig {
  /** The absolute redirect URL Google sends the browser to. */
  redirectUri?: string
  /** The port the local callback listener binds on 127.0.0.1. */
  callbackPort?: number
}

export interface AccountProfile {
  mode: "interactive" | "credentials_file" | "access_token"
  enabledServices: string[]
  /**
   * The account's own email domains, lowercased: for allowExternalRecipients,
   * a recipient outside them is external. Unset: the signed-in address's domain.
   */
  domains?: string[]
  /**
   * Interactive accounts: the access the sign-in form offers by default,
   * as one level or per service (unlisted services are read). Read unless
   * configured; a sign-in never gets write without an explicit choice.
   */
  access: AccessLevel | Record<string, AccessLevel>
  /**
   * True when the user's account config set `access`. An omitted setting
   * still defaults to read, but the sign-in form may offer write. An explicit
   * `"read"` does not offer write.
   */
  accessSpecified?: boolean
  /** Interactive accounts: extra scope URLs every sign-in requests and shows. */
  scopes: string[]
  /** Interactive accounts: the OAuth client for this account, over the plugin-level one. */
  oauthClient?: OAuthClient
  credentialsFileEnv?: string
  tokenEnv?: string
}

export interface PolicyRule {
  id: string
  effect: "deny"
  categories?: Category[]
  accounts?: string[]
  services?: string[]
  operations?: string[]
  allowedRecipientDomains?: string[]
  allowedRecipients?: string[]
  deniedRecipientDomains?: string[]
  allowExternalRecipients?: boolean
  allowPublicSharing?: boolean
  allowedReadRoots?: string[]
  allowedWriteRoots?: string[]
  maxPages?: number
  maxItems?: number
}

interface PolicyConfig {
  /** Plan lifetime. Approvals are host rules, not a policy effect. */
  planTtlSeconds: number
  rules: PolicyRule[]
}

interface ExecutionConfig {
  timeoutMs: number
  schemaTimeoutMs: number
  maxPages: number
  maxItems: number
  pageDelayMs: number
  maxStdoutBytes: number
  maxStderrBytes: number
  maxInlineBytes: number
  maxUploadBytes: number
  maxDownloadBytes: number
  allowedReadRoots: string[]
  allowedWriteRoots: string[]
}

interface AuditConfig {
  enabled: boolean
  sink: "stderr" | "jsonl"
  /** The JSONL file; the runtime defaults it to `<stateDir>/audit.jsonl`. */
  path?: string
}

interface SkillsConfig {
  enabled: boolean
  include: string[]
  exclude: string[]
}

interface BinaryConfig {
  /** Absolute path to a system gws 0.22.5, used instead of the packaged binary. */
  path?: string
}

/**
 * Admin is a separately gated authority. `enabled` defaults to false,
 * `allowedServices` defaults to every service that has an admin-class
 * manifest entry, and an explicit `allow` rule that names the `admin`
 * category is still required.
 */
interface AdminConfig {
  enabled: boolean
  requireReason: boolean
  allowedServices: string[]
}

export interface PluginConfig {
  accounts: Record<string, AccountProfile>
  /** Optional model-facing service allowlist. Defaults to the union of account enabledServices. */
  services?: string[]
  /** The OAuth client for every interactive account without its own (organisation managed config). */
  oauthClient?: OAuthClient
  /** The sign-in redirect and callback port; unset means a loopback redirect on a random port. */
  redirect: RedirectConfig
  binary: BinaryConfig
  /** Continue on an OpenCode host outside the tested range, with a status warning. */
  allowUntestedHost: boolean
  policy: PolicyConfig
  execution: ExecutionConfig
  audit: AuditConfig
  skills: SkillsConfig
  admin: AdminConfig
}

/** A request with its account resolved: the configured alias it names, or the only one. */
export type Request = Omit<RequestInput, "account"> & { account: string }

export interface BuiltCommand {
  argv: string[]
  category: Category
  service: string
  operation: string
  /** Local files argv refers to by staged relative path. */
  files: FileSpecs
  preview: Preview
}

export interface Plan {
  id: string
  account: string
  sessionId: string
  agentId: string
  category: CommitCategory
  operation: string
  service: string
  argv: string[]
  createdAt: number
  expiresAt: number
  state: "ready" | "committing" | "consumed" | "expired"
  preview: BuiltCommand["preview"]
  /** Files the commit re-stages (and must match by fingerprint) and delivers. */
  files?: PlannedFiles
  /**
   * For a plan that read recipients (a draft, a message being replied to,
   * an event's guests): the request, to read them again at commit, and the
   * recipients the preview showed.
   */
  recheck?: { request: Request; recipients: string[] }
}

/** A finished `gws` child process, as reported by the process layer. */
export interface ProcessResult {
  exitCode: number | null
  signal: NodeJS.Signals | null
  stdout: Buffer
  stderr: Buffer
  durationMs: number
  timedOut: boolean
  outputCapped: boolean
}
