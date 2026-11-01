import * as z from "zod"
import { OAuthClientSchema } from "../domain/config.js"
import type { AccessLevel } from "../domain/types.js"
import type { ClientChoice } from "./client.js"

/**
 * What a Google sign-in stores in the OpenCode credential's `metadata`,
 * next to the tokens: the client it used (so refresh keeps working when the
 * default changes), the access level, and the scopes it requested and
 * Google granted. It lives only in OpenCode's credential store; the plugin
 * writes no credential or client file.
 */

const SignInMetadata = z.object({
  clientId: OAuthClientSchema.shape.clientId,
  clientSecret: OAuthClientSchema.shape.clientSecret,
  clientSource: z.enum(["account", "plugin", "pasted"]),
  access: z.enum(["read", "write"]),
  requestedScopes: z.array(z.string()),
  grantedScopes: z.array(z.string()),
})

export type SignInMetadata = z.output<typeof SignInMetadata>

export function signInMetadata(input: {
  client: ClientChoice
  access: AccessLevel
  requestedScopes: readonly string[]
  grantedScopes: readonly string[]
}): SignInMetadata {
  return {
    clientId: input.client.client.clientId,
    clientSecret: input.client.client.clientSecret,
    clientSource: input.client.source,
    access: input.access,
    requestedScopes: [...input.requestedScopes],
    grantedScopes: [...input.grantedScopes],
  }
}

/** The stored sign-in, or undefined when the metadata is missing or malformed. */
export function readSignIn(metadata: Readonly<Record<string, unknown>> | undefined): SignInMetadata | undefined {
  const parsed = SignInMetadata.safeParse(metadata)
  return parsed.success ? parsed.data : undefined
}

/** The client a stored sign-in used. */
export function signInClient(metadata: SignInMetadata): ClientChoice {
  return { client: { clientId: metadata.clientId, clientSecret: metadata.clientSecret }, source: metadata.clientSource }
}
