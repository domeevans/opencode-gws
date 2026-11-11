import type { AccessLevel, AccountProfile, OAuthClient } from "../domain/types.js"
import { resolveClient, type ClientSource } from "./client.js"
import type { SignInMetadata } from "./credential.js"
import { defaultAccess, signInScopes } from "./form.js"

/**
 * One account's sign-in status: what /gws-status, the status RPC, the TUI
 * and gws_status show. Never a token or a client secret.
 */

/** An interactive account's OpenCode connection, as the host reports it. */
export interface ConnectionView {
  /** An active connection exists. */
  connected: boolean
  /** The host marked the connection as needing sign-in again. */
  needsAuth: boolean
  /** The stored sign-in; absent when the credential could not be read. */
  signIn?: Pick<SignInMetadata, "access" | "clientSource" | "grantedScopes" | "email" | "domain">
}

interface AccountSignInStatus {
  /** Interactive: signed in and usable. Headless: its environment variable is set; /gws-doctor checks the credential. */
  connected: boolean
  needsAuth?: true
  /** The signed-in access level; before sign-in, the form's default. */
  access?: AccessLevel
  /** The client the sign-in used; before sign-in, the one it would use. */
  clientSource?: ClientSource
  grantedScopes?: string[]
  /** The signed-in account's verified email address, from the sign-in's id_token. */
  email?: string
  /** The signed-in account's Workspace domain (Google's `hd`); absent for a consumer account. */
  domain?: string
  /** Scopes the enabled services need at this access level that Google did not grant. */
  missingScopes?: string[]
  /** What to do next, as one sentence; absent when nothing is needed. */
  nextStep?: string
}

interface StatusInputs {
  alias: string
  /** The integration's name in /connect. */
  name: string
  integrationID: string
  profile: AccountProfile
  pluginClient?: OAuthClient
  connection?: ConnectionView
  /** The environment the headless credentials come from. */
  env?: Readonly<Record<string, string | undefined>>
}

/** How to sign in: the TUI's /connect entry, or the CLI, which opens the browser itself. */
export function connectStep(name: string, integrationID: string): string {
  return `run /connect and choose ${name}, or run opencode auth login ${integrationID}`
}

export function accountSignInStatus(input: StatusInputs): AccountSignInStatus {
  const { name, integrationID, profile, connection } = input
  if (profile.mode !== "interactive") {
    const variable = profile.mode === "credentials_file" ? profile.credentialsFileEnv : profile.tokenEnv
    if (variable && (input.env ?? process.env)[variable]) return { connected: true }
    return { connected: false, nextStep: `Set ${variable ?? "the credentials variable"} and restart OpenCode.` }
  }
  const configured = resolveClient({ account: profile.oauthClient, plugin: input.pluginClient })
  const connect = connectStep(name, integrationID)
  const access = defaultAccess(profile)
  if (!connection?.connected) {
    return {
      connected: false,
      access,
      ...(configured ? { clientSource: configured.source } : {}),
      nextStep: configured
        ? `To sign in, ${connect}.`
        : `Run /connect and choose ${name}, then enter your Desktop OAuth client ID and secret, or ask your administrator.`,
    }
  }
  const signIn = connection.signIn
  if (connection.needsAuth || !signIn) {
    return {
      connected: false,
      ...(connection.needsAuth ? { needsAuth: true as const } : {}),
      access: signIn?.access ?? access,
      ...(signIn ? { clientSource: signIn.clientSource } : configured ? { clientSource: configured.source } : {}),
      ...(signIn ? { grantedScopes: signIn.grantedScopes, ...identityOf(signIn) } : {}),
      nextStep: `To sign in again, ${connect}.`,
    }
  }
  const missing = signInScopes(profile, signIn.access).filter((scope) => !signIn.grantedScopes.includes(scope))
  return {
    connected: true,
    access: signIn.access,
    clientSource: signIn.clientSource,
    grantedScopes: signIn.grantedScopes,
    ...identityOf(signIn),
    missingScopes: missing,
    ...(missing.length > 0 ? { nextStep: `To sign in again, ${connect}, and approve every scope Google lists.` } : {}),
  }
}

function identityOf(signIn: Pick<SignInMetadata, "email" | "domain">): { email?: string; domain?: string } {
  return { ...(signIn.email ? { email: signIn.email } : {}), ...(signIn.domain ? { domain: signIn.domain } : {}) }
}
