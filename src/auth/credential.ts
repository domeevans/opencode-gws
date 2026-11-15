import * as z from "zod"
import { ClientIdSchema, ClientSecretSchema } from "../domain/config.js"
import type { AccessLevel } from "../domain/types.js"
import type { ClientChoice } from "./client.js"
import type { SignInIdentity } from "./identity.js"

/**
 * What a Google sign-in stores in the OpenCode credential's `metadata`,
 * next to the tokens: the client it used (so refresh keeps working when the
 * default changes; a Web client also keeps its redirect URIs), the access
 * level, the scopes it requested and Google granted, and the signed-in email and Workspace domain from the id_token.
 * It lives only in OpenCode's credential store; the plugin writes no credential or client file.
 *
 * It is read two ways:
 * - **every call** reads it with `readSignIn`: the access level, the scopes, the email and the domain. The client is
 *   optional there, because a copy that cannot renew carries none of its secret: Jelly's copy of a person's sign-in
 *   for an agent (D210) keeps every metadata key but the secret-named ones, so `clientSecret` is left out.
 * - **a renewal** (`refreshGoogle`) and a new sign-in's reuse of the previous client read it with `renewableSignIn`,
 *   which needs the client ID and secret. Without them the sign-in is still read, but never renewed.
 */

const SignInRead = z.object({
  clientId: ClientIdSchema.optional(),
  clientRedirectUris: z.array(z.string()).optional(),
  clientSource: z.enum(["account", "plugin", "pasted"]).optional(),
  access: z.enum(["read", "write"]),
  requestedScopes: z.array(z.string()),
  grantedScopes: z.array(z.string()),
  email: z.string().optional(),
  domain: z.string().optional(),
})

const SignInRenew = SignInRead.extend({
  clientId: ClientIdSchema,
  clientSecret: ClientSecretSchema,
  clientSource: z.enum(["account", "plugin", "pasted"]),
})

/** What every call reads of a stored sign-in. */
export type SignIn = z.output<typeof SignInRead>
/** A stored sign-in that can be renewed: it carries the client it used, secret included. */
export type RenewableSignIn = z.output<typeof SignInRenew>

export function signInMetadata(input: {
  client: ClientChoice
  access: AccessLevel
  requestedScopes: readonly string[]
  grantedScopes: readonly string[]
  identity?: SignInIdentity | undefined
}): RenewableSignIn {
  const { redirectUris } = input.client.client
  return {
    clientId: input.client.client.clientId,
    clientSecret: input.client.client.clientSecret,
    ...(redirectUris ? { clientRedirectUris: [...redirectUris] } : {}),
    clientSource: input.client.source,
    access: input.access,
    requestedScopes: [...input.requestedScopes],
    grantedScopes: [...input.grantedScopes],
    ...(input.identity?.email ? { email: input.identity.email } : {}),
    ...(input.identity?.domain ? { domain: input.identity.domain } : {}),
  }
}

/** The stored sign-in as every call reads it, or undefined when the metadata is missing or malformed. */
export function readSignIn(metadata: Readonly<Record<string, unknown>> | undefined): SignIn | undefined {
  const parsed = SignInRead.safeParse(metadata)
  return parsed.success ? parsed.data : undefined
}

/** The stored sign-in with the client a renewal needs, or undefined when it has none (an agent's copy, for one). */
export function renewableSignIn(metadata: Readonly<Record<string, unknown>> | undefined): RenewableSignIn | undefined {
  const parsed = SignInRenew.safeParse(metadata)
  return parsed.success ? parsed.data : undefined
}

/** The client a renewable sign-in used. */
export function signInClient(metadata: RenewableSignIn): ClientChoice {
  const { clientId, clientSecret, clientRedirectUris } = metadata
  return { client: { clientId, clientSecret, ...(clientRedirectUris ? { redirectUris: clientRedirectUris } : {}) }, source: metadata.clientSource }
}

/**
 * The refresh token of Jelly's copy of a sign-in for an agent: the host keeps the real one, renews it in the person's
 * own engine, and puts the next copy in before this one claims to run out. A plugin that sees it never renews: it
 * asks for a new sign-in, without a network call.
 */
export const HOST_OWNED_REFRESH = "jelly-host-owns-refresh"

/** Whether the credential's renewal belongs to the host (Jelly's agent copy), not to this plugin. */
export function isHostOwnedRefresh(credential: { readonly refresh?: string }): boolean {
  return credential.refresh === HOST_OWNED_REFRESH
}
