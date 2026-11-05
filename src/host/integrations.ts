import type { Credential } from "@opencode/plugin"
import { resolveClient, type ClientChoice } from "../auth/client.js"
import { readSignIn, signInClient } from "../auth/credential.js"
import { readAnswer, signInForm, signInScopes, type SignInForm } from "../auth/form.js"
import {
  GOOGLE_METHOD_ID,
  authorizeGoogle,
  integrationIdFor,
  integrationIds,
  integrationNames,
  refreshGoogle,
  type GoogleAuthOptions,
  type GoogleOAuthAuthorization,
  type OAuthCredential,
} from "../auth/google.js"
import type { ConnectionView } from "../auth/status.js"
import { AuthStateTracker, type AuthState } from "../domain/auth-state.js"
import { GwsError } from "../domain/errors.js"
import { Lifecycle } from "../domain/lifecycle.js"
import { resolveRedirect } from "../domain/redirect.js"
import type { AccountProfile, OAuthClient, PluginConfig, RedirectConfig } from "../domain/types.js"
import type { AccountCredential } from "../runtime/accounts.js"
import type { IntegrationDraft, PluginContext } from "./context.js"

export { integrationIdFor, integrationIds, integrationNames, sanitizeIntegrationAlias } from "../auth/google.js"

interface GoogleIntegrationMethod {
  id: string
  type: "oauth"
  label: string
  form: SignInForm
}

interface GoogleIntegrationDefinition {
  integrationID: string
  name: string
  alias: string
  method: GoogleIntegrationMethod
  authorize: (answer: Record<string, unknown>) => Promise<GoogleOAuthAuthorization>
  refresh: (credential: OAuthCredential) => Promise<OAuthCredential>
  label: (credential: OAuthCredential) => string | undefined
}

export interface GoogleIntegrationOptions {
  /** The integration's name in /connect; "Google Workspace" unless several accounts sign in. */
  name?: string
  /** The plugin-level `oauthClient`. */
  pluginClient?: OAuthClient
  /** The plugin-level `redirectUri` and `callbackPort`: the form's defaults. */
  redirect?: RedirectConfig
  /** The client of the account's current sign-in, so a re-sign-in can reuse a pasted one. */
  previous?: () => Promise<ClientChoice | undefined>
  auth?: GoogleAuthOptions
}

/**
 * One account's sign-in method: the form, then the browser flow with the
 * client, access, and scopes the answer chose. Everything the answer can
 * get wrong fails here, before any network call.
 */
export function googleIntegration(
  alias: string,
  profile: AccountProfile,
  integrationID = integrationIdFor(alias),
  options: GoogleIntegrationOptions = {},
): GoogleIntegrationDefinition {
  const configured = { account: profile.oauthClient, plugin: options.pluginClient }
  const name = options.name ?? "Google Workspace"
  return {
    integrationID,
    name,
    alias,
    method: {
      id: GOOGLE_METHOD_ID,
      type: "oauth",
      label: "Sign in with Google",
      form: signInForm(alias, profile, resolveClient(configured), options.redirect),
    },
    authorize: async (answer) => {
      const { pasted, access, redirect: entered } = readAnswer(answer)
      // Each field the host filled in wins over its option, which is only the field's default.
      const redirect = resolveRedirect({
        redirectUri: entered.redirectUri ?? options.redirect?.redirectUri,
        callbackPort: entered.callbackPort ?? options.redirect?.callbackPort,
      })
      const previous = pasted ? undefined : await options.previous?.()
      const client = resolveClient({ ...configured, pasted, previous })
      if (!client) {
        throw new Error(
          `AUTH_CLIENT_REQUIRED: No OAuth client is configured for ${alias}. Next step: Run /connect and choose ${name}, then enter your Desktop OAuth client ID and secret, or ask your administrator.`,
        )
      }
      return authorizeGoogle({ alias, client, access, scopes: signInScopes(profile, access), redirect, options: options.auth })
    },
    refresh: (credential) => refreshGoogle({ alias, name, credential, options: options.auth }),
    label: () => alias,
  }
}

/** A plugin error in the shared form (CODE: What happened. Next step: What to do.); anything else unchanged. */
function rethrow(error: unknown): never {
  throw GwsError.from(error) ?? error
}

/** The Google flow returns the host credential shape minus the method-id brand. */
function toHostCredential(credential: OAuthCredential): Credential.OAuth {
  return credential as Credential.OAuth
}

/**
 * Register one OAuth integration per interactive account. The host owns
 * the credential store; this module only defines methods and the browser
 * flow. Headless accounts have no sign-in.
 */
export async function registerIntegrations(
  ctx: PluginContext,
  config: PluginConfig,
  ids: Map<string, string> = integrationIds(config.accounts),
): Promise<number> {
  const resolve = connectionResolver(ctx, new Lifecycle())
  const names = integrationNames(config.accounts)
  const definitions = Object.entries(config.accounts)
    .filter(([, profile]) => profile.mode === "interactive")
    .map(([alias, profile]) => {
      const integrationID = ids.get(alias) ?? integrationIdFor(alias)
      return googleIntegration(alias, profile, integrationID, {
        name: names.get(alias),
        pluginClient: config.oauthClient,
        redirect: config.redirect,
        previous: async () => {
          const signIn = readSignIn((await resolve(integrationID))?.metadata)
          return signIn ? signInClient(signIn) : undefined
        },
      })
    })
  if (definitions.length === 0) return 0

  await ctx.integration.transform((draft: IntegrationDraft) => {
    for (const definition of definitions) {
      draft.update(definition.integrationID, (integration) => {
        integration.name = definition.name
      })
      draft.method.update({
        integrationID: definition.integrationID,
        method: definition.method,
        authorize: async (answer) => {
          const authorization = await definition.authorize(answer).catch(rethrow)
          return { ...authorization, callback: authorization.callback.then(toHostCredential, rethrow) }
        },
        refresh: async (credential) => toHostCredential(await definition.refresh(credential).catch(rethrow)),
        label: definition.label,
      })
    }
  })
  return definitions.length
}

/** The active connection's OAuth credential (refreshed by the host when it is about to expire). */
function connectionResolver(ctx: PluginContext, lifetime: Lifecycle) {
  return async (integrationID: string, signal?: AbortSignal): Promise<Credential.OAuth | undefined> => {
    const connection = await lifetime.wait(() => ctx.integration.connection.active(integrationID), signal)
    if (signal?.aborted || !connection) return undefined
    const credential = await lifetime.wait(() => ctx.integration.connection.resolve(connection), signal)
    return credential?.type === "oauth" ? credential : undefined
  }
}

/**
 * Resolve an interactive account's current sign-in at call time: the
 * access token, which goes only into the gws child environment (see
 * process/env.ts), and the scopes Google granted.
 */
export function integrationTokenProvider(
  ctx: PluginContext,
  config: PluginConfig,
  ids: Map<string, string>,
): (account: string, signal?: AbortSignal) => Promise<AccountCredential | undefined> {
  const lifetime = new Lifecycle()
  const resolve = connectionResolver(ctx, lifetime)
  return async (account, signal) => {
    if (signal?.aborted) return undefined
    const id = ids.get(account)
    if (!id || config.accounts[account]?.mode !== "interactive") return undefined
    const credential = await resolve(id, signal)
    if (signal?.aborted || !credential) return undefined
    const signIn = readSignIn(credential.metadata)
    if (!signIn) throw new Error(`the stored sign-in for '${account}' has no scope record`)
    return { access: credential.access, grantedScopes: signIn.grantedScopes }
  }
}

/**
 * Whether /connect shows this credential as needing a sign-in. `connection.active` returns the credential alone, so
 * the status the host keeps is read from the connection `integration.get` projects.
 */
async function showsNeedsAuth(ctx: PluginContext, integrationID: string, connectionID: string): Promise<boolean> {
  try {
    const { data } = await ctx.integration.get({ integrationID })
    const shown = data.connections?.find((item) => item.type === "credential" && item.id === connectionID)
    return shown?.type === "credential" && shown.status?.status === "needs_auth"
  } catch {
    return false
  }
}

/**
 * An interactive account's connection for status: whether it exists,
 * whether the host marked it as needing sign-in, and the stored sign-in's
 * access, client source, and granted scopes. Never a token or secret.
 */
export function integrationConnection(
  ctx: PluginContext,
  ids: ReadonlyMap<string, string>,
): (account: string, signal?: AbortSignal) => Promise<ConnectionView> {
  const lifetime = new Lifecycle()
  return async (account, signal) => {
    const id = ids.get(account)
    if (!id) return { connected: false, needsAuth: false }
    const connection = await lifetime.wait(() => ctx.integration.connection.active(id), signal)
    if (!connection) return { connected: false, needsAuth: false }
    const needsAuth = connection.type === "credential" && (await lifetime.wait(() => showsNeedsAuth(ctx, id, connection.id), signal))
    let credential: Credential.Value | undefined
    try {
      credential = await lifetime.wait(() => ctx.integration.connection.resolve(connection), signal)
    } catch {
      return { connected: true, needsAuth: true }
    }
    const signIn = credential?.type === "oauth" ? readSignIn(credential.metadata) : undefined
    return {
      connected: true,
      needsAuth,
      ...(signIn ? { signIn: { access: signIn.access, clientSource: signIn.clientSource, grantedScopes: signIn.grantedScopes } } : {}),
    }
  }
}

/**
 * Report sign-in problems on the account's active connection, so the host
 * shows them natively (`needs_auth`), and clear them after the next good
 * call. Only transitions reach the host; reports for one account run in
 * order, and a failed report is retried on the next observation.
 */
export function integrationAuthReporter(
  ctx: PluginContext,
  config: PluginConfig,
  ids: Map<string, string>,
): (account: string, state: AuthState, signal?: AbortSignal) => Promise<void> {
  const tracker = new AuthStateTracker()
  const lifetime = new Lifecycle()
  const queues = new Map<string, Promise<void>>()
  return (account, state, signal) => {
    if (signal?.aborted) return Promise.resolve()
    const integrationID = ids.get(account)
    if (!integrationID || config.accounts[account]?.mode !== "interactive" || !tracker.update(account, state)) return Promise.resolve()
    const report = async (): Promise<void> => {
      try {
        if (signal?.aborted) return
        const connection = await lifetime.wait(() => ctx.integration.connection.active(integrationID), signal)
        if (signal?.aborted) return
        if (!connection) {
          tracker.forget(account)
          return
        }
        await lifetime.wait(() => ctx.integration.connection.status({
          integrationID,
          connection,
          status: state.status === "ok" ? undefined : { status: "needs_auth", message: state.message },
        }), signal)
      } catch {
        tracker.forget(account)
      }
    }
    const next = (queues.get(account) ?? Promise.resolve()).then(report)
    queues.set(account, next)
    return next
  }
}
