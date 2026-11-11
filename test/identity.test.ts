import { describe, expect, it } from "vitest"
import { idTokenIdentity } from "../src/auth/identity.js"

/** An unsigned JWT-shaped token with these claims; the plugin reads it from Google's token endpoint over TLS. */
const token = (claims: unknown, header: unknown = { alg: "RS256", typ: "JWT" }) =>
  [header, claims].map((part) => Buffer.from(typeof part === "string" ? part : JSON.stringify(part)).toString("base64url")).join(".") + ".c2lnbmF0dXJl"

describe("the signed-in identity from an id_token", () => {
  it("reads a verified email and the hosted domain, lower-cased", () => {
    expect(idTokenIdentity(token({ iss: "https://accounts.google.com", email: "Ada@Example.COM", email_verified: true, hd: "Example.com" }))).toEqual({
      email: "ada@example.com",
      domain: "example.com",
    })
  })

  it("gives a consumer account its email and no domain", () => {
    expect(idTokenIdentity(token({ email: "ada@gmail.com", email_verified: true }))).toEqual({ email: "ada@gmail.com" })
  })

  it("leaves out an email Google has not verified, and keeps the domain", () => {
    expect(idTokenIdentity(token({ email: "ada@example.com", email_verified: false, hd: "example.com" }))).toEqual({ domain: "example.com" })
    expect(idTokenIdentity(token({ email: "ada@example.com", email_verified: "true" }))).toBeUndefined()
    expect(idTokenIdentity(token({ email: "ada@example.com" }))).toBeUndefined()
  })

  it("gives no identity for a malformed token, never an error", () => {
    for (const malformed of [
      undefined,
      null,
      42,
      "",
      "not-a-jwt",
      "a.b",
      "a.b.c.d",
      "a..c",
      "a.b c.d",
      "a.!!!.c",
      token("not json"),
      token("[1,2]"),
      token("null"),
      token(123),
      token({ email: 42, email_verified: true, hd: ["example.com"] }),
      token({ email: "no-at-sign", email_verified: true }),
      token({ email: "two@@example.com", email_verified: true }),
      token({ email: "ada@example.com\n", email_verified: true }),
      token({ hd: "not a domain" }),
      token({ hd: "localhost" }),
      token({}),
      `${"a".repeat(20_000)}.${"b".repeat(10)}.c`,
    ]) {
      expect(() => idTokenIdentity(malformed), String(malformed).slice(0, 40)).not.toThrow()
      expect(idTokenIdentity(malformed), String(malformed).slice(0, 40)).toBeUndefined()
    }
  })
})
