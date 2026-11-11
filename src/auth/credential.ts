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
 */

const SignInMetadata = z.object({
  clientId: ClientIdSchema,
  clientSecret: ClientSecretSchema,
  clientRedirectUris: z.array(z.string()).optional(),
  clientSource: z.enum(["account", "plugin", "pasted"]),
  access: z.enum(["read", "write"]),
  requestedScopes: z.array(z.string()),
  grantedScopes: z.array(z.string()),
  email: z.string().optional(),
  domain: z.string().optional(),
})

export type SignInMetadata = z.output<typeof SignInMetadata>

export function signInMetadata(input: {
  client: ClientChoice
  access: AccessLevel
  requestedScopes: readonly string[]
  grantedScopes: readonly string[]
  identity?: SignInIdentity | undefined
}): SignInMetadata {
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

/** The stored sign-in, or undefined when the metadata is missing or malformed. */
export function readSignIn(metadata: Readonly<Record<string, unknown>> | undefined): SignInMetadata | undefined {
  const parsed = SignInMetadata.safeParse(metadata)
  return parsed.success ? parsed.data : undefined
}

/** The client a stored sign-in used. */
export function signInClient(metadata: SignInMetadata): ClientChoice {
  const { clientId, clientSecret, clientRedirectUris } = metadata
  return { client: { clientId, clientSecret, ...(clientRedirectUris ? { redirectUris: clientRedirectUris } : {}) }, source: metadata.clientSource }
}
