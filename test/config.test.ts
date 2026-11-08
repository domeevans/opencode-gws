import { describe, expect, it } from "vitest"
import { signInForm } from "../src/auth/form.js"
import { loadConfig } from "../src/domain/config.js"
import { loadManifest } from "../src/domain/manifest.js"
import { FAKE_GWS, TEST_CLIENT, account, testConfig } from "./support/config.js"

const policy = { rules: [{ id: "no-write", effect: "deny" as const, categories: ["write" as const] }] }

describe("config", () => {
  it("loads a strict config and applies defaults", () => {
    const config = testConfig({ policy })
    expect(config.accounts.personal?.enabledServices).toEqual(["gmail"])
    expect(config.execution.maxPages).toBe(10)
    expect(config.policy.rules).toEqual([{ id: "no-write", effect: "deny", categories: ["write"] }])
    expect(config.policy.planTtlSeconds).toBe(300)
  })

  it("rejects unknown keys with OPTIONS_INVALID, naming the option, and one next step", () => {
    expect(() => testConfig({ response: { mode: "summary" } })).toThrow(/^OPTIONS_INVALID: The plugin options are not valid \(options: .*response.*\)\. Next step: Fix the plugin options in opencode\.json\.$/)
    expect(() => testConfig({ accounts: { a: account({ services: ["docz"] }) } })).toThrow(
      /^OPTIONS_INVALID: Account 'a' enables the unknown service 'docz'\. Next step: Fix accounts\.a\.enabledServices in the plugin options\.$/,
    )
  })

  it("takes binary.path as an absolute path and allowUntestedHost as a boolean that defaults to false", () => {
    expect(testConfig()).toMatchObject({ binary: { path: FAKE_GWS }, allowUntestedHost: false })
    expect(testConfig({ allowUntestedHost: true }).allowUntestedHost).toBe(true)
    expect(() => testConfig({ binary: { path: "bin/gws" } })).toThrow(/absolute/)
    expect(() => testConfig({ allowUntestedHost: "yes" })).toThrow()
  })

  it("takes access as one of the three values, and defaults to all", () => {
    expect(testConfig().access).toBe("all")
    for (const access of ["all", "ask-changes", "read-only"] as const) expect(testConfig({ access }).access).toBe(access)
    expect(() => testConfig({ access: "sometimes" })).toThrow(/access: Invalid option: expected one of "all"\|"ask-changes"\|"read-only"/)
  })

  it.each([false, true])("strictly rejects unsupported allowScriptWrapper=%s", value => {
    expect(() => testConfig()).not.toThrow()
    expect(() => testConfig({ binary: { allowScriptWrapper: value } })).toThrow(/allowScriptWrapper/)
  })

  it("requires at least one account when accounts is given", () => {
    expect(() => testConfig({ accounts: {} })).toThrow(/^OPTIONS_INVALID: The accounts option has no account\. Next step: Add at least one account alias/)
  })

  it("defaults the audit sink to JSONL in the plugin's state directory", () => {
    expect(testConfig().audit).toEqual({ enabled: true, path: undefined })
    // Removed options are refused, not ignored.
    for (const removed of [{ audit: { sink: "stderr" } }, { skills: { exclude: [] } }, { execution: { pageDelayMs: 0 } }, { execution: { schemaTimeoutMs: 1 } }]) {
      expect(() => testConfig(removed), JSON.stringify(removed)).toThrow(/OPTIONS_INVALID/)
    }
  })
})

describe("accounts", () => {
  // Keep needs delegation, Model Armor has no helper that runs, and admin-reports needs an admin privilege most accounts lack.
  it("creates one interactive default account with every service but Keep, Model Armor and admin-reports at Read and write when accounts is omitted", () => {
    const services = loadManifest()
      .services.map((service) => service.alias)
      .filter((service) => !["keep", "modelarmor", "admin-reports"].includes(service))
    for (const options of [undefined, {}]) {
      expect(loadConfig(options).accounts).toEqual({
        default: { mode: "interactive", enabledServices: services, access: "write", scopes: [] },
      })
    }
  })

  it("says in the default form nothing about Keep, and in a Keep account's form that Keep needs domain-wide delegation", () => {
    expect(signInForm("default", loadConfig(undefined).accounts.default!, undefined)[2].description).not.toMatch(/delegation/)
    const notes = loadConfig({ accounts: { notes: { enabledServices: ["keep"], access: "write" } } }).accounts.notes!
    const access = signInForm("notes", notes, undefined)[2]
    expect(access.description).toContain("keep needs domain-wide delegation, which a Workspace admin sets up, so this sign-in requests none of its scopes; with delegation, add them to accounts.notes.scopes.")
    for (const option of access.options) expect(option.description).not.toMatch(/auth\/keep/)
    const delegated = loadConfig({ accounts: { notes: { enabledServices: ["keep"], access: "write", scopes: ["keep"] } } }).accounts.notes!
    expect(signInForm("notes", delegated, undefined)[2].description).not.toMatch(/delegation/)
  })

  it("keeps the default sign-in form's Read-only choice, with write as the default", () => {
    const profile = loadConfig(undefined).accounts.default!
    const access = signInForm("default", profile, undefined)[2]
    expect(access.default).toBe("write")
    expect(access.options.map((option) => option.value)).toEqual(["read", "write"])
  })

  it("makes mode default to interactive and access to read", () => {
    const profile = testConfig({ accounts: { work: { enabledServices: ["drive"] } } }).accounts.work
    expect(profile).toEqual({ mode: "interactive", enabledServices: ["drive"], access: "read", scopes: [] })
  })

  it("hides write on the sign-in form only when access is explicitly read", () => {
    const explicit = loadConfig({ accounts: { a: { enabledServices: ["gmail"], access: "read" } } }).accounts.a!
    expect(explicit.accessSpecified).toBe(true)
    expect(signInForm("a", explicit, undefined)[2].options.map((option) => option.value)).toEqual(["read"])
    const omitted = loadConfig({ accounts: { a: { enabledServices: ["gmail"] } } }).accounts.a!
    expect(omitted.accessSpecified).toBeUndefined()
    expect(signInForm("a", omitted, undefined)[2].options.map((option) => option.value)).toEqual(["read", "write"])
    expect(signInForm("a", loadConfig({}).accounts.default!, undefined)[2].options.map((option) => option.value)).toEqual(["read", "write"])
  })

  it("takes access as one level or a per-service map of enabled services", () => {
    expect(testConfig({ accounts: { a: account({ access: "write" }) } }).accounts.a?.access).toBe("write")
    expect(testConfig({ accounts: { a: account({ services: ["gmail", "drive"], access: { Drive: "write" } }) } }).accounts.a?.access).toEqual({ drive: "write" })
    expect(() => testConfig({ accounts: { a: account({ access: { drive: "write" } }) } })).toThrow(/does not enable/)
    expect(() => testConfig({ accounts: { a: account({ access: "admin" as never }) } })).toThrow()
  })

  it("normalises extra scopes to URLs and rejects malformed ones", () => {
    const profile = testConfig({ accounts: { a: account({ scopes: ["directory.readonly", "https://www.googleapis.com/auth/directory.readonly"] }) } }).accounts.a
    expect(profile?.scopes).toEqual(["https://www.googleapis.com/auth/directory.readonly"])
    expect(() => testConfig({ accounts: { a: account({ scopes: ["two words"] }) } })).toThrow(/Account 'a' has an invalid scope/)
  })

  it("takes an OAuth client per account and at plugin level, in Google's format", () => {
    const config = testConfig({ oauthClient: TEST_CLIENT, accounts: { a: account({ oauthClient: TEST_CLIENT }) } })
    expect(config.oauthClient).toEqual(TEST_CLIENT)
    expect(config.accounts.a?.oauthClient).toEqual(TEST_CLIENT)
    expect(() => testConfig({ oauthClient: { clientId: "not-a-client-id", clientSecret: "secret" } })).toThrow(/Google OAuth client ID/)
    expect(() => testConfig({ oauthClient: { ...TEST_CLIENT, extra: true } })).toThrow()
  })

  it("keeps headless modes explicit, with no sign-in options", () => {
    const config = testConfig({
      accounts: {
        ci: { mode: "credentials_file", enabledServices: ["drive"], credentialsFileEnv: "GWS_CREDENTIALS" },
        bot: { mode: "access_token", enabledServices: ["gmail"], tokenEnv: "GWS_TOKEN" },
      },
    })
    expect(config.accounts.ci).toEqual({ mode: "credentials_file", enabledServices: ["drive"], access: "read", scopes: [], credentialsFileEnv: "GWS_CREDENTIALS" })
    expect(config.accounts.bot).toEqual({ mode: "access_token", enabledServices: ["gmail"], access: "read", scopes: [], tokenEnv: "GWS_TOKEN" })
    for (const extra of [{ access: "write" }, { scopes: ["drive"] }, { oauthClient: TEST_CLIENT }]) {
      expect(() => testConfig({ accounts: { ci: { mode: "credentials_file", enabledServices: ["drive"], credentialsFileEnv: "X", ...extra } } })).toThrow()
    }
  })

  it.each([
    ["configDir", { accounts: { a: { ...account(), configDir: "/tmp/gws" } } }],
    ["keyringBackend", { accounts: { a: { ...account(), keyringBackend: "file" } } }],
    ["auth", { auth: { enabled: false } }],
  ])("rejects the removed %s option", (_name, overrides) => {
    expect(() => testConfig(overrides)).toThrow()
  })
})
