import { describe, expect, it } from "vitest"
import { resolveClient } from "../src/auth/client.js"
import { TEST_CLIENT } from "./support/config.js"

const other = { clientId: "222-other.apps.googleusercontent.com", clientSecret: "other-secret" }
const third = { clientId: "333-third.apps.googleusercontent.com", clientSecret: "third-secret" }
const fourth = { clientId: "444-fourth.apps.googleusercontent.com", clientSecret: "fourth-secret" }

describe("client precedence", () => {
  it("is account, then plugin, then entered in the form, then the previous sign-in's, and never a shipped default", () => {
    const previous = { client: fourth, source: "pasted" as const }
    expect(resolveClient({ account: TEST_CLIENT, plugin: other, pasted: third, previous })).toEqual({ client: TEST_CLIENT, source: "account" })
    expect(resolveClient({ plugin: other, pasted: third, previous })).toEqual({ client: other, source: "plugin" })
    expect(resolveClient({ pasted: third, previous })).toEqual({ client: third, source: "pasted" })
    expect(resolveClient({ previous })).toEqual(previous)
    expect(resolveClient({})).toBeUndefined()
  })

  it("reuses only a client entered in the form at the previous sign-in", () => {
    // A configured client is re-derived from the options, never taken from an old sign-in.
    expect(resolveClient({ previous: { client: third, source: "account" } })).toBeUndefined()
    expect(resolveClient({ previous: { client: third, source: "plugin" } })).toBeUndefined()
  })
})
