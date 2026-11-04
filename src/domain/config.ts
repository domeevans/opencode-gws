import { isAbsolute } from "node:path"
import * as z from "zod"
import { GwsError } from "./errors.js"
import type { AccountProfile, PluginConfig } from "./types.js"
import { adminServices, canonicalService, loadManifest } from "./manifest.js"
import { redirectProblem } from "./redirect.js"
import { DELEGATION_SERVICES } from "./restricted.js"
import { scopeUrl } from "./scopes.js"

const absolutePath = z.string().min(1).refine((value) => isAbsolute(value), {
  message: "must be an absolute path",
})

const envVarName = z.string().regex(/^[A-Z_][A-Z0-9_]*$/, {
  message: "must be an environment variable name (values are resolved at runtime, never stored)",
})

/** A Google OAuth client ID and secret. */
export const CLIENT_ID_PATTERN = /^[A-Za-z0-9-]+\.apps\.googleusercontent\.com$/
export const CLIENT_SECRET_PATTERN = /^[A-Za-z0-9_-]+$/

export const ClientIdSchema = z.string().regex(CLIENT_ID_PATTERN, { message: "must be a Google OAuth client ID (…apps.googleusercontent.com)" })
export const ClientSecretSchema = z.string().regex(CLIENT_SECRET_PATTERN, { message: "must be a Google OAuth client secret" })

/** A Desktop app client's ID and secret. */
export const DesktopClientSchema = z.strictObject({ clientId: ClientIdSchema, clientSecret: ClientSecretSchema })

/**
 * Google's downloaded client JSON: `installed` for a Desktop app client, or
 * `web` for a Web application client, which must list its redirect URIs.
 * Other keys (project_id, auth_uri, …) are ignored.
 */
export const ClientJsonSchema = z.union([
  z
    .object({ installed: z.object({ client_id: ClientIdSchema, client_secret: ClientSecretSchema }) })
    .transform(({ installed }) => ({ clientId: installed.client_id, clientSecret: installed.client_secret })),
  z
    .object({ web: z.object({ client_id: ClientIdSchema, client_secret: ClientSecretSchema, redirect_uris: z.array(z.string().min(1)).min(1) }) })
    .transform(({ web }) => ({ clientId: web.client_id, clientSecret: web.client_secret, redirectUris: web.redirect_uris })),
])

/** An OAuth client option: a Desktop client's ID and secret, or Google's client JSON. */
export const OAuthClientSchema = z.union([DesktopClientSchema, ClientJsonSchema])

const accessLevel = z.enum(["read", "write"])

/**
 * The services an interactive account enables when it names none: every
 * manifest service a person's sign-in can use. Services that need
 * domain-wide delegation (Keep) are left out: no ordinary sign-in can run
 * them, and Google refuses the whole consent for a delegation scope.
 */
export function defaultServices(): string[] {
  return loadManifest()
    .services.map((service) => service.alias)
    .filter((service) => !DELEGATION_SERVICES.includes(service))
}

/**
 * With no `accounts` option, one interactive account enables the default
 * services at Read and write, so one consent grants every scope the plugin
 * can use. Every change still needs a plan, the ask, and a commit; the form
 * still offers Read-only.
 */
function defaultAccounts(): Record<string, { mode: "interactive"; access: "write" }> {
  return { default: { mode: "interactive", access: "write" } }
}

const enabledServices = z.array(z.string().min(1)).min(1)

/** `mode` may be omitted: an account is interactive unless it names a headless mode. */
const accountProfile = z.preprocess(
  (value) => (value !== null && typeof value === "object" && !Array.isArray(value) && !("mode" in value) ? { ...value, mode: "interactive" } : value),
  z.discriminatedUnion("mode", [
    z.strictObject({
      mode: z.literal("interactive"),
      // Omitted: the default services, so a host need not know the manifest.
      enabledServices: enabledServices.optional(),
      access: z.union([accessLevel, z.record(z.string().min(1), accessLevel)]).optional(),
      scopes: z.array(z.string().min(1)).optional(),
      oauthClient: OAuthClientSchema.optional(),
    }),
    z.strictObject({
      mode: z.literal("credentials_file"),
      enabledServices,
      credentialsFileEnv: envVarName,
    }),
    z.strictObject({
      mode: z.literal("access_token"),
      enabledServices,
      tokenEnv: envVarName,
    }),
  ]),
)

const policyRule = z.strictObject({
  id: z.string().min(1),
  effect: z.literal("deny"),
  categories: z.array(z.enum(["read", "write", "send", "share", "delete", "export", "admin", "deploy", "watch", "deny"])).optional(),
  accounts: z.array(z.string()).optional(),
  services: z.array(z.string()).optional(),
  operations: z.array(z.string()).optional(),
  allowedRecipientDomains: z.array(z.string()).optional(),
  allowedRecipients: z.array(z.string()).optional(),
  deniedRecipientDomains: z.array(z.string()).optional(),
  allowExternalRecipients: z.boolean().optional(),
  allowPublicSharing: z.boolean().optional(),
  allowedReadRoots: z.array(absolutePath).optional(),
  allowedWriteRoots: z.array(absolutePath).optional(),
  maxPages: z.number().int().positive().optional(),
  maxItems: z.number().int().positive().optional(),
})

const configSchema = z.strictObject({
  accounts: z.record(z.string().min(1), accountProfile).optional(),
  services: z.array(z.string().min(1)).min(1).optional(),
  oauthClient: OAuthClientSchema.optional(),
  redirectUri: z.string().min(1).optional(),
  callbackPort: z.number().int().min(1).max(65_535).optional(),
  policy: z
    .strictObject({
      planTtlSeconds: z.number().int().positive().optional(),
      rules: z.array(policyRule).optional(),
    })
    .optional(),
  execution: z
    .strictObject({
      timeoutMs: z.number().int().positive().optional(),
      schemaTimeoutMs: z.number().int().positive().optional(),
      maxPages: z.number().int().positive().optional(),
      maxItems: z.number().int().positive().optional(),
      pageDelayMs: z.number().int().nonnegative().optional(),
      maxStdoutBytes: z.number().int().positive().optional(),
      maxStderrBytes: z.number().int().positive().optional(),
      maxInlineBytes: z.number().int().positive().optional(),
      maxUploadBytes: z.number().int().positive().optional(),
      maxDownloadBytes: z.number().int().positive().optional(),
      allowedReadRoots: z.array(absolutePath).optional(),
      allowedWriteRoots: z.array(absolutePath).optional(),
    })
    .optional(),
  audit: z
    .strictObject({
      enabled: z.boolean().optional(),
      sink: z.enum(["stderr", "jsonl"]).optional(),
      path: absolutePath.optional(),
    })
    .optional(),
  skills: z
    .strictObject({
      enabled: z.boolean().optional(),
      include: z.array(z.string()).optional(),
      exclude: z.array(z.string()).optional(),
    })
    .optional(),
  binary: z
    .strictObject({
      path: absolutePath.optional(),
    })
    .optional(),
  allowUntestedHost: z.boolean().optional(),
  admin: z
    .strictObject({
      enabled: z.boolean().optional(),
      requireReason: z.boolean().optional(),
      allowedServices: z.array(z.string().min(1)).optional(),
    })
    .optional(),
})

const DEFAULT_LIMITS = {
  maxPages: 10,
  maxItems: 1_000,
  pageDelayMs: 100,
  maxStdoutBytes: 5 * 1024 * 1024,
  maxStderrBytes: 1 * 1024 * 1024,
  maxInlineBytes: 256 * 1024,
  maxUploadBytes: 25 * 1024 * 1024,
  maxDownloadBytes: 100 * 1024 * 1024,
} as const

/** A plugin-options error, naming the option and how to fix it. */
function invalid(detail: string, next = "Fix the plugin options in opencode.json."): GwsError {
  return new GwsError("OPTIONS_INVALID", detail, { next })
}

export function loadConfig(raw: unknown): PluginConfig {
  const result = configSchema.safeParse(raw ?? {})
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `${issue.path.join(".") || "options"}: ${issue.message}`).join("; ")
    throw invalid(`The plugin options are not valid (${issues})`)
  }
  const parsed = result.data
  if (parsed.redirectUri !== undefined) {
    const problem = redirectProblem(parsed.redirectUri)
    if (problem) throw invalid(`The redirectUri option ${problem}`, "Set redirectUri to the absolute URL Google redirects to, such as https://host.example/oauth/return.")
    if (parsed.callbackPort === undefined) throw invalid("The redirectUri option is set without callbackPort", "Set callbackPort to the local port the redirect reaches.")
  }
  const configured: Record<string, z.output<typeof accountProfile>> = parsed.accounts ?? defaultAccounts()
  if (Object.keys(configured).length === 0) {
    throw invalid("The accounts option has no account", "Add at least one account alias to accounts, or remove accounts for the default account.")
  }

  const known = new Set(loadManifest().services.map((service) => service.alias))
  const accounts: Record<string, AccountProfile> = {}
  for (const [alias, profile] of Object.entries(configured)) {
    const enabled = [...new Set((profile.enabledServices ?? defaultServices()).map(canonicalService))]
    for (const service of enabled) {
      if (!known.has(service)) throw invalid(`Account '${alias}' enables the unknown service '${service}'`, `Fix accounts.${alias}.enabledServices in the plugin options.`)
    }
    const interactive = profile.mode === "interactive" ? profile : undefined
    const accessSpecified = interactive?.access !== undefined && parsed.accounts !== undefined
    let access: AccountProfile["access"] = "read"
    if (typeof interactive?.access === "string") access = interactive.access
    else if (interactive?.access) {
      access = {}
      for (const [name, level] of Object.entries(interactive.access)) {
        const service = canonicalService(name)
        if (!enabled.includes(service)) throw invalid(`Account '${alias}' sets access for '${name}', which it does not enable`, `Fix accounts.${alias}.access in the plugin options.`)
        access[service] = level
      }
    }
    const scopes = (interactive?.scopes ?? []).map((scope) => {
      try {
        return scopeUrl(scope)
      } catch (error) {
        throw invalid(`Account '${alias}' has an invalid scope: ${(error as Error).message}`, `Fix accounts.${alias}.scopes in the plugin options.`)
      }
    })
    accounts[alias] = {
      mode: profile.mode,
      enabledServices: enabled,
      access,
      ...(accessSpecified ? { accessSpecified } : {}),
      scopes: [...new Set(scopes)],
      ...(interactive?.oauthClient ? { oauthClient: interactive.oauthClient } : {}),
      ...(profile.mode === "credentials_file" ? { credentialsFileEnv: profile.credentialsFileEnv } : {}),
      ...(profile.mode === "access_token" ? { tokenEnv: profile.tokenEnv } : {}),
    }
  }

  const enabledByAccounts = new Set(Object.values(accounts).flatMap((profile) => profile.enabledServices))
  const services = parsed.services ? [...new Set(parsed.services.map(canonicalService))] : undefined
  if (services) {
    for (const service of services) {
      if (!known.has(service)) throw invalid(`The services option names the unknown service '${service}'`, "Fix services in the plugin options.")
      if (!enabledByAccounts.has(service)) {
        throw invalid(`The services option names '${service}', which no account enables`, "Fix services in the plugin options.")
      }
    }
  }

  return {
    accounts,
    services,
    ...(parsed.oauthClient ? { oauthClient: parsed.oauthClient } : {}),
    redirect: {
      ...(parsed.redirectUri !== undefined ? { redirectUri: parsed.redirectUri } : {}),
      ...(parsed.callbackPort !== undefined ? { callbackPort: parsed.callbackPort } : {}),
    },
    binary: {
      path: parsed.binary?.path,
    },
    allowUntestedHost: parsed.allowUntestedHost ?? false,
    policy: {
      planTtlSeconds: parsed.policy?.planTtlSeconds ?? 300,
      rules: parsed.policy?.rules ?? [],
    },
    execution: {
      timeoutMs: parsed.execution?.timeoutMs ?? 120_000,
      schemaTimeoutMs: parsed.execution?.schemaTimeoutMs ?? 15_000,
      maxPages: parsed.execution?.maxPages ?? DEFAULT_LIMITS.maxPages,
      maxItems: parsed.execution?.maxItems ?? DEFAULT_LIMITS.maxItems,
      pageDelayMs: parsed.execution?.pageDelayMs ?? DEFAULT_LIMITS.pageDelayMs,
      maxStdoutBytes: parsed.execution?.maxStdoutBytes ?? DEFAULT_LIMITS.maxStdoutBytes,
      maxStderrBytes: parsed.execution?.maxStderrBytes ?? DEFAULT_LIMITS.maxStderrBytes,
      maxInlineBytes: parsed.execution?.maxInlineBytes ?? DEFAULT_LIMITS.maxInlineBytes,
      maxUploadBytes: parsed.execution?.maxUploadBytes ?? DEFAULT_LIMITS.maxUploadBytes,
      maxDownloadBytes: parsed.execution?.maxDownloadBytes ?? DEFAULT_LIMITS.maxDownloadBytes,
      allowedReadRoots: parsed.execution?.allowedReadRoots ?? [],
      allowedWriteRoots: parsed.execution?.allowedWriteRoots ?? [],
    },
    audit: {
      enabled: parsed.audit?.enabled ?? true,
      sink: parsed.audit?.sink ?? "jsonl",
      path: parsed.audit?.path,
    },
    skills: {
      enabled: parsed.skills?.enabled ?? true,
      include: parsed.skills?.include ?? [],
      exclude: parsed.skills?.exclude ?? [],
    },
    admin: {
      enabled: parsed.admin?.enabled ?? true,
      requireReason: parsed.admin?.requireReason ?? true,
      allowedServices: parsed.admin?.allowedServices ?? adminServices(),
    },
  }
}
