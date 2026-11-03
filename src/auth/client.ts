import type { OAuthClient } from "../domain/types.js"

/**
 * The OAuth client a sign-in uses, and where it came from. No client ships
 * in the package: it is the user's own Desktop app client, or one the
 * organisation sets through `oauthClient`. Google treats an installed
 * app's client secret as non-confidential
 * (https://developers.google.com/identity/protocols/oauth2#installed);
 * security rests on PKCE (S256), the loopback redirect to 127.0.0.1, and
 * the user's consent on Google's own screen, not on the secret. A Web
 * application client, for a host-supplied redirect, has a confidential
 * secret: it stays in the credential store and is never shown.
 */

/** Where a sign-in's client came from: account option, plugin option, or the sign-in form. */
export type ClientSource = "account" | "plugin" | "pasted"

export interface ClientChoice {
  client: OAuthClient
  source: ClientSource
}

interface ClientCandidates {
  account?: OAuthClient
  plugin?: OAuthClient
  pasted?: OAuthClient
  /** The client of the account's current sign-in; reused only when it was entered in the form. */
  previous?: ClientChoice
}

/**
 * Precedence: the account's `oauthClient`, the plugin's `oauthClient`
 * (managed config), the client entered in the sign-in form, then the client
 * entered at the previous sign-in, so signing in again does not ask again.
 */
export function resolveClient(candidates: ClientCandidates): ClientChoice | undefined {
  if (candidates.account) return { client: candidates.account, source: "account" }
  if (candidates.plugin) return { client: candidates.plugin, source: "plugin" }
  if (candidates.pasted) return { client: candidates.pasted, source: "pasted" }
  return candidates.previous?.source === "pasted" ? candidates.previous : undefined
}
