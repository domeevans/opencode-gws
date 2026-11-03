import { describe, expect, it } from "vitest"
import { signInScopes } from "../src/auth/form.js"
import { accountSignInStatus } from "../src/auth/status.js"
import { APP_ONLY_SCOPES, USER_UNUSABLE_METHODS, appOnly } from "../src/domain/app-only.js"
import { loadConfig } from "../src/domain/config.js"
import { catalog, commandIndex, loadManifest } from "../src/domain/manifest.js"
import {
  ACCESS_SCOPES,
  IDENTITY_SCOPES,
  MAX_SCOPES,
  SCOPE_PREFIX,
  WRITE_ACCESS_READS,
  acceptedScopes,
  grantedScopes,
  grants,
  requestedScopes,
  scopeUrl,
} from "../src/domain/scopes.js"

const NEVER_RUN = new Set(["watch", "deploy", "deny"])
const methods = () => [...commandIndex().methods.values()]
const covers = (set: readonly string[], scopes: readonly string[]) => scopes.some((scope) => set.includes(scope))

describe("scope table against the manifest", () => {
  it("has an entry for every manifest service and no other", () => {
    expect(Object.keys(ACCESS_SCOPES).sort()).toEqual(loadManifest().services.map((service) => service.alias).sort())
  })

  it("covers every read with the read set, except reads that need write access or an app's own credentials", () => {
    const uncovered = methods()
      .filter((method) => method.category === "read" && !covers(ACCESS_SCOPES[method.service]!.read, method.scopes))
      .map((method) => method.id)
    expect(uncovered.sort()).toEqual([...WRITE_ACCESS_READS, ...USER_UNUSABLE_METHODS.filter((id) => commandIndex().methods.get(id)?.category === "read")].sort())
  })

  it("covers every method that can run with the write set, admin included, except the app-only methods", () => {
    const uncovered = methods()
      .filter((method) => !NEVER_RUN.has(method.category) && !covers(ACCESS_SCOPES[method.service]!.write, method.scopes))
      .map((method) => method.id)
    expect(uncovered.sort()).toEqual([...USER_UNUSABLE_METHODS].sort())
  })

  it("lists each exception once, as a real manifest method", () => {
    expect(new Set(USER_UNUSABLE_METHODS).size).toBe(USER_UNUSABLE_METHODS.length)
    for (const id of [...WRITE_ACCESS_READS, ...USER_UNUSABLE_METHODS]) expect(commandIndex().methods.has(id), id).toBe(true)
    for (const id of WRITE_ACCESS_READS) {
      expect(appOnly(id), id).toBe(false)
      expect(commandIndex().methods.get(id)?.category).toBe("read")
    }
  })

  it("puts only read-only scopes in the read sets, never a write or app-only scope", () => {
    const viewOnly = new Set([`${SCOPE_PREFIX}script.processes`, `${SCOPE_PREFIX}script.metrics`])
    for (const [service, sets] of Object.entries(ACCESS_SCOPES)) {
      for (const scope of sets.read) {
        expect(scope.endsWith(".readonly") || viewOnly.has(scope), `${service}: ${scope}`).toBe(true)
        expect(APP_ONLY_SCOPES, `${service}: ${scope}`).not.toContain(scope)
      }
    }
  })

  it("lists as app-only exactly the methods that can run but accept only app-only scopes", () => {
    const appOnlyScopes = new Set(APP_ONLY_SCOPES)
    const expected = methods()
      .filter((method) => !NEVER_RUN.has(method.category) && method.scopes.length > 0 && method.scopes.every((scope) => appOnlyScopes.has(scope)))
      .map((method) => method.id)
    expect([...USER_UNUSABLE_METHODS].sort()).toEqual(expected.sort())
  })

  it("never requests an app-only scope or a deployment scope", () => {
    const all = Object.values(ACCESS_SCOPES).flatMap((sets) => [...sets.read, ...sets.write])
    for (const scope of APP_ONLY_SCOPES) expect(all, scope).not.toContain(scope)
    for (const forbidden of ["script.deployments", "drive.scripts", "chat.app.", "chat.admin."]) expect(all.join(" ")).not.toContain(forbidden)
  })

  it("asks for Gmail's full-mailbox, settings, and cloud-platform scopes only at Read and write", () => {
    const read = Object.values(ACCESS_SCOPES).flatMap((sets) => sets.read)
    for (const scope of ["https://mail.google.com/", `${SCOPE_PREFIX}gmail.settings.basic`, `${SCOPE_PREFIX}gmail.settings.sharing`, `${SCOPE_PREFIX}cloud-platform`]) {
      expect(read, scope).not.toContain(scope)
    }
    expect(ACCESS_SCOPES.gmail!.write).toEqual(expect.arrayContaining(["https://mail.google.com/", `${SCOPE_PREFIX}gmail.settings.basic`, `${SCOPE_PREFIX}gmail.settings.sharing`]))
    expect(ACCESS_SCOPES.modelarmor).toEqual({ read: [], write: [`${SCOPE_PREFIX}cloud-platform`] })
  })

  it("keeps the read sets read-only for Gmail, Drive, Calendar, Docs, Sheets, and Slides", () => {
    for (const service of ["gmail", "drive", "calendar", "docs", "sheets", "slides"]) {
      for (const scope of ACCESS_SCOPES[service]!.read) expect(scope, service).toMatch(/\.readonly$/)
    }
    expect(ACCESS_SCOPES.gmail!.read).toEqual([`${SCOPE_PREFIX}gmail.readonly`])
    expect(ACCESS_SCOPES.drive!.read).toEqual([`${SCOPE_PREFIX}drive.readonly`, `${SCOPE_PREFIX}drive.apps.readonly`])
  })

  it("gives composite services the union of their parts", () => {
    expect(ACCESS_SCOPES.workflow!.read).toEqual(expect.arrayContaining([...ACCESS_SCOPES.gmail!.read, ...ACCESS_SCOPES.calendar!.read, ...ACCESS_SCOPES.tasks!.read]))
    expect(ACCESS_SCOPES.events!.write).toEqual(expect.arrayContaining([...ACCESS_SCOPES.chat!.write]))
  })
})

describe("the no-options install", () => {
  const config = loadConfig(undefined)
  const profile = config.accounts.default!
  const requested = requestedScopes(profile.enabledServices, profile.access, profile.scopes)

  it("enables every manifest service at Read and write, with the admin gate on", () => {
    expect(Object.keys(config.accounts)).toEqual(["default"])
    expect(profile).toMatchObject({ mode: "interactive", access: "write" })
    expect([...profile.enabledServices].sort()).toEqual(loadManifest().services.map((service) => service.alias).sort())
    expect(config.admin.enabled).toBe(true)
  })

  it("requests every scope it can use in one consent, under Google's cap", () => {
    expect(requested.length).toBeLessThanOrEqual(MAX_SCOPES)
    expect(requested.length).toBe(46)
    expect(requested).toEqual(expect.arrayContaining([...IDENTITY_SCOPES, "https://mail.google.com/", `${SCOPE_PREFIX}cloud-platform`, `${SCOPE_PREFIX}directory.readonly`]))
    for (const scope of APP_ONLY_SCOPES) expect(requested).not.toContain(scope)
  })

  it("runs on a Read-only sign-in every read that accepts a read-only scope, apart from the app-only methods", () => {
    const read = requestedScopes(profile.enabledServices, "read")
    expect(read.length).toBeLessThanOrEqual(MAX_SCOPES)
    expect(read.length).toBe(38)
    const blocked = methods()
      .filter((method) => method.category === "read" && method.scopes.some((scope) => scope.endsWith(".readonly")) && !appOnly(method.id))
      .filter((method) => !grants(acceptedScopes(method.id), read))
      .map((method) => method.id)
    expect(blocked).toEqual([])
  })

  it("reports write access and no missing scopes once Google grants what the form requested", () => {
    const status = accountSignInStatus({
      alias: "default",
      name: "Google Workspace",
      integrationID: "gws-default",
      profile,
      connection: { connected: true, needsAuth: false, signIn: { access: "write", clientSource: "pasted", grantedScopes: signInScopes(profile, "write") } },
    })
    expect(status).toMatchObject({ connected: true, access: "write", missingScopes: [] })
    expect(signInScopes(profile, "write")).toEqual(requested)
    expect(status).not.toHaveProperty("nextStep")
  })

  it("covers every method once granted, except watch, deploy, deny, and the app-only methods", () => {
    const blocked = methods()
      .filter((method) => !NEVER_RUN.has(method.category) && !grants(acceptedScopes(method.id), requested))
      .map((method) => method.id)
    expect(blocked.sort()).toEqual([...USER_UNUSABLE_METHODS].sort())
    const runnable = methods().filter((method) => !NEVER_RUN.has(method.category) && grants(acceptedScopes(method.id), requested))
    expect(runnable).toHaveLength(methods().length - methods().filter((method) => NEVER_RUN.has(method.category)).length - USER_UNUSABLE_METHODS.length)
    for (const helper of commandIndex().helpers.values()) {
      if (!NEVER_RUN.has(helper.category)) expect(grants(acceptedScopes(helper.id), requested), helper.id).toBe(true)
    }
  })

  it("marks exactly the app-only methods in the catalog", () => {
    const entries = catalog({ include: ["methods"], limit: 200, query: "classroom" }).entries
    const all = [...commandIndex().methods.keys()].flatMap((id) => catalog({ include: ["methods"], query: id, limit: 200 }).entries.filter((entry) => entry.id === id))
    expect(all).toHaveLength(commandIndex().methods.size)
    expect(all.filter((entry) => entry.appOnly === true).map((entry) => entry.id).sort()).toEqual([...USER_UNUSABLE_METHODS].sort())
    expect(entries.some((entry) => entry.appOnly)).toBe(true)
  })
})

describe("requested scopes", () => {
  it("are the read sets plus identity for a read sign-in, and never a write scope", () => {
    const scopes = requestedScopes(["gmail", "drive", "calendar", "docs", "sheets"], "read")
    expect(scopes).toEqual([
      `${SCOPE_PREFIX}gmail.readonly`,
      `${SCOPE_PREFIX}drive.readonly`,
      `${SCOPE_PREFIX}drive.apps.readonly`,
      `${SCOPE_PREFIX}calendar.readonly`,
      `${SCOPE_PREFIX}calendar.acls.readonly`,
      `${SCOPE_PREFIX}documents.readonly`,
      `${SCOPE_PREFIX}spreadsheets.readonly`,
      ...IDENTITY_SCOPES,
    ])
  })

  it("apply per-service access and extra scopes without duplicates", () => {
    const scopes = requestedScopes(["gmail", "drive"], { drive: "write" }, [`${SCOPE_PREFIX}drive`, `${SCOPE_PREFIX}directory.readonly`])
    expect(scopes).toEqual([`${SCOPE_PREFIX}gmail.readonly`, `${SCOPE_PREFIX}drive`, `${SCOPE_PREFIX}drive.apps.readonly`, `${SCOPE_PREFIX}directory.readonly`, ...IDENTITY_SCOPES])
  })

  it("refuse more than Google accepts in one request", () => {
    const extra = Array.from({ length: 70 }, (_, index) => `${SCOPE_PREFIX}extra${index}`)
    expect(() => requestedScopes(["gmail"], "read", extra)).toThrow(/at most 64 scopes/)
  })

  it("normalise short names and keep URLs and openid", () => {
    expect(scopeUrl("gmail.readonly")).toBe(`${SCOPE_PREFIX}gmail.readonly`)
    expect(scopeUrl("https://mail.google.com/")).toBe("https://mail.google.com/")
    expect(scopeUrl("openid")).toBe("openid")
    expect(() => scopeUrl("not a scope")).toThrow(/not an OAuth scope/)
  })
})

describe("granted scopes and the preflight rule", () => {
  it("parse Google's space-separated scope field", () => {
    expect(grantedScopes(`openid ${SCOPE_PREFIX}gmail.readonly  ${SCOPE_PREFIX}gmail.readonly`)).toEqual(["openid", `${SCOPE_PREFIX}gmail.readonly`])
    expect(grantedScopes("")).toBeUndefined()
    expect(grantedScopes(undefined)).toBeUndefined()
  })

  it("accept a method's manifest scopes and a helper's service set", () => {
    expect(acceptedScopes("gmail.users.messages.list")).toContain(`${SCOPE_PREFIX}gmail.readonly`)
    expect(acceptedScopes("gmail.triage")).toEqual([`${SCOPE_PREFIX}gmail.readonly`, ...ACCESS_SCOPES.gmail!.write])
    expect(acceptedScopes("gmail.send")).toEqual(ACCESS_SCOPES.gmail!.write)
    expect(acceptedScopes("modelarmor.sanitize-prompt")).toEqual([`${SCOPE_PREFIX}cloud-platform`])
    expect(acceptedScopes("no.such.operation")).toEqual([])
  })

  it("passes when any accepted scope is granted, or nothing is required", () => {
    const read = requestedScopes(["gmail", "drive"], "read")
    expect(grants(acceptedScopes("gmail.users.messages.list"), read)).toBe(true)
    expect(grants(acceptedScopes("gmail.users.messages.send"), read)).toBe(false)
    expect(grants(acceptedScopes("drive.files.create"), read)).toBe(false)
    expect(grants(acceptedScopes("drive.files.create"), requestedScopes(["drive"], "write"))).toBe(true)
    expect(grants([], [])).toBe(true)
  })
})
