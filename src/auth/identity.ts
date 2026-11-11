/**
 * The signed-in Google account, from the `id_token` Google's token endpoint returns when `openid` is granted: its
 * verified email address and, for a Workspace account, its hosted domain (`hd`). The plugin reads the token straight
 * from the token endpoint over TLS, so, as OpenID Connect Core 3.1.3.7 allows, the TLS check of the issuer stands in
 * for the signature check. Nothing here authorizes anything: status reports it, so a host can tell which account is
 * signed in.
 *
 * A malformed token, or one without a verified email, gives no identity rather than an error: a sign-in still works
 * without it.
 */

export interface SignInIdentity {
  /** The account's email address, only when Google says it is verified. */
  email?: string
  /** The Workspace domain the account belongs to (`hd`); absent for a consumer account. */
  domain?: string
}

/** At most this long: a Google id_token is about 1 KB. */
const MAX_TOKEN_LENGTH = 16 * 1024
const SEGMENT = /^[A-Za-z0-9_-]+$/
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,253}$/
const DOMAIN = /^[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+$/u

/** The identity in an id_token, or undefined when it holds none this plugin can trust. */
export function idTokenIdentity(token: unknown): SignInIdentity | undefined {
  if (typeof token !== "string" || token.length > MAX_TOKEN_LENGTH) return undefined
  const parts = token.split(".")
  if (parts.length !== 3 || !parts.every((part) => SEGMENT.test(part))) return undefined
  let claims: unknown
  try {
    claims = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"))
  } catch {
    return undefined
  }
  if (typeof claims !== "object" || claims === null || Array.isArray(claims)) return undefined
  const record = claims as Record<string, unknown>
  const email = record["email_verified"] === true && typeof record["email"] === "string" && EMAIL.test(record["email"]) ? record["email"].toLowerCase() : undefined
  const domain = typeof record["hd"] === "string" && DOMAIN.test(record["hd"]) ? record["hd"].toLowerCase() : undefined
  if (email === undefined && domain === undefined) return undefined
  return { ...(email === undefined ? {} : { email }), ...(domain === undefined ? {} : { domain }) }
}
