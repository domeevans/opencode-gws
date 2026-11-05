import { describe, expect, it } from "vitest"
import { catalog } from "../src/domain/manifest.js"
import { registerSkills } from "../src/host/skills.js"
import { account, testConfig } from "./support/config.js"

const scoped = (overrides: Record<string, unknown> = {}, services = ["gmail", "drive"]) =>
  testConfig({ accounts: { personal: account({ services }) }, ...overrides })

describe("model-facing service scoping", () => {
  it("accepts an explicit services allowlist and canonicalizes accounts", () => {
    const config = scoped({ services: ["gmail", "reports"] }, ["gmail", "drive", "reports"])
    expect(config.services).toEqual(["gmail", "admin-reports"])
    expect(config.accounts.personal?.enabledServices).toEqual(["gmail", "drive", "admin-reports"])
  })

  it("rejects an unknown service", () => {
    expect(() => scoped({ services: ["docz"] })).toThrow(/unknown service/)
  })

  it("rejects a service no account enables", () => {
    expect(() => scoped({ services: ["docs"] })).toThrow(/which no account enables/)
  })

  it("filters the catalog to the visible services", () => {
    const { entries, total } = catalog({ limit: 200 }, new Set(["gmail"]))
    expect(total).toBe(87)
    expect(entries.every((entry) => entry.service === "gmail")).toBe(true)
  })

  it("still registers both skills when only some services are visible", async () => {
    const config = scoped()
    const added: Array<{ id: string }> = []
    const registered = await registerSkills(
      {
        skill: {
          transform: async (callback: (draft: { add: (skill: unknown) => void }) => void) => {
            callback({ add: (skill) => added.push(skill as { id: string }) })
          },
        },
      } as never,
      config,
    )
    expect(registered).toBe(2)
    expect(added.map((skill) => skill.id)).toEqual(["opencode-gws", "opencode-gws-recipes"])
  })
})
