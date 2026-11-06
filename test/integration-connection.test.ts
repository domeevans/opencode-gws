import { describe, expect, it } from "vitest"
import { integrationConnection } from "../src/host/integrations.js"
import { ALL_SCOPES, storedSignIn } from "./support/config.js"

// The host's integration API, as OpenCode answers it: `connection.active` returns the credential alone, with no status,
// and `integration.get` projects the status the plugin set as `connections[].status`. A status read from `active` is
// therefore always undefined, and a "sign-in required" mark the plugin wrote would never clear.

const ID = "gws-personal"
const CREDENTIAL = { type: "credential" as const, id: "cred_1", label: "joe@example.com", method: "oauth" as const }
const IDS = new Map([["personal", ID]])

function host(shown?: { status: { status: "needs_auth"; message: string } }) {
  const connections = shown ? [{ ...CREDENTIAL, ...shown }] : [CREDENTIAL]
  return {
    integration: {
      get: async ({ integrationID }: { integrationID: string }) => ({ data: { id: integrationID, name: "Google Workspace", connections } }),
      connection: {
        active: async (integrationID: string) => (integrationID === ID ? CREDENTIAL : undefined),
        resolve: async () => storedSignIn("read", ALL_SCOPES),
      },
    },
  }
}

describe("integrationConnection", () => {
  it("reads the sign-in mark the host projects, because connection.active carries no status", async () => {
    const ctx = host({ status: { status: "needs_auth", message: "Google rejected this sign-in. Sign in again." } })
    expect(await ctx.integration.connection.active(ID)).not.toHaveProperty("status")
    expect(await integrationConnection(ctx as never, IDS)("personal")).toMatchObject({ connected: true, needsAuth: true, signIn: { access: "read" } })
  })

  it("clears the mark once the projection has no status", async () => {
    expect(await integrationConnection(host() as never, IDS)("personal")).toMatchObject({ connected: true, needsAuth: false })
  })

  it("reports no account when none is signed in", async () => {
    expect(await integrationConnection(host() as never, IDS)("work")).toEqual({ connected: false, needsAuth: false })
  })
})
