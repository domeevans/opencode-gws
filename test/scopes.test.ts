import { describe, expect, it } from "vitest"
import { signInScopes } from "../src/auth/form.js"
import { accountSignInStatus } from "../src/auth/status.js"
import { doctorTarget, skipDetail } from "../src/auth/doctor.js"
import { APP_ONLY_METHODS, APP_ONLY_SCOPES, DELEGATION_METHODS, DELEGATION_SCOPES, DELEGATION_SERVICES, appOnly, delegationRequired, restriction } from "../src/domain/restricted.js"
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
/** Every method an ordinary sign-in cannot run: app-only, and those that need domain-wide delegation. */
const RESTRICTED: readonly string[] = [...APP_ONLY_METHODS, ...DELEGATION_METHODS]
/** Scopes no access level may request. */
const NEVER_REQUESTED: readonly string[] = [...APP_ONLY_SCOPES, ...DELEGATION_SCOPES]
const methods = () => [...commandIndex().methods.values()]
const covers = (set: readonly string[], scopes: readonly string[]) => scopes.some((scope) => set.includes(scope))

describe("scope table against the manifest", () => {
  it("has an entry for every manifest service and no other", () => {
    expect(Object.keys(ACCESS_SCOPES).sort()).toEqual(loadManifest().services.map((service) => service.alias).sort())
  })

  it("covers every read with the read set, except reads that need write access, an app's own credentials, or domain-wide delegation", () => {
    const uncovered = methods()
      .filter((method) => method.category === "read" && !covers(ACCESS_SCOPES[method.service]!.read, method.scopes))
      .map((method) => method.id)
    expect(uncovered.sort()).toEqual([...WRITE_ACCESS_READS, ...RESTRICTED.filter((id) => commandIndex().methods.get(id)?.category === "read")].sort())
  })

  it("covers every method that can run with the write set, admin included, except the app-only and delegation methods", () => {
    const uncovered = methods()
      .filter((method) => !NEVER_RUN.has(method.category) && !covers(ACCESS_SCOPES[method.service]!.write, method.scopes))
      .map((method) => method.id)
    expect(uncovered.sort()).toEqual([...RESTRICTED].sort())
  })

  it("lists each exception once, as a real manifest method", () => {
    expect(new Set(RESTRICTED).size).toBe(RESTRICTED.length)
    for (const id of [...WRITE_ACCESS_READS, ...RESTRICTED]) expect(commandIndex().methods.has(id), id).toBe(true)
    for (const id of WRITE_ACCESS_READS) {
      expect(restriction(id), id).toBeUndefined()
      expect(commandIndex().methods.get(id)?.category).toBe("read")
    }
    for (const id of APP_ONLY_METHODS) expect([restriction(id), appOnly(id)], id).toEqual(["app-only", true])
    for (const id of DELEGATION_METHODS) expect([restriction(id), appOnly(id)], id).toEqual(["domain-wide-delegation", false])
  })

  it("puts only read-only scopes in the read sets, never a write, app-only or delegation scope", () => {
    const viewOnly = new Set([`${SCOPE_PREFIX}script.processes`, `${SCOPE_PREFIX}script.metrics`])
    for (const [service, sets] of Object.entries(ACCESS_SCOPES)) {
      for (const scope of sets.read) {
        expect(scope.endsWith(".readonly") || viewOnly.has(scope), `${service}: ${scope}`).toBe(true)
        expect(NEVER_REQUESTED, `${service}: ${scope}`).not.toContain(scope)
      }
    }
  })

  it("lists as app-only exactly the methods that can run but accept only app-only scopes", () => {
    const appOnlyScopes = new Set(APP_ONLY_SCOPES)
    const expected = methods()
      .filter((method) => !NEVER_RUN.has(method.category) && method.scopes.length > 0 && method.scopes.every((scope) => appOnlyScopes.has(scope)))
      .map((method) => method.id)
    expect([...APP_ONLY_METHODS].sort()).toEqual(expected.sort())
  })

  it("lists as needing domain-wide delegation exactly the methods that can run but accept only delegation scopes", () => {
    const delegation = new Set(DELEGATION_SCOPES)
    const expected = methods()
      .filter((method) => !NEVER_RUN.has(method.category) && method.scopes.length > 0 && method.scopes.every((scope) => delegation.has(scope)))
      .map((method) => method.id)
    expect([...DELEGATION_METHODS].sort()).toEqual(expected.sort())
    expect(DELEGATION_SCOPES).toEqual([`${SCOPE_PREFIX}keep`, `${SCOPE_PREFIX}keep.readonly`])
  })

  it("names as delegation services exactly the services whose every method needs delegation", () => {
    const delegated = new Set<string>(DELEGATION_METHODS)
    const expected = loadManifest()
      .services.filter((service) => service.methods.length > 0 && service.methods.every((method) => delegated.has(method.id)))
      .map((service) => service.alias)
    expect([...DELEGATION_SERVICES]).toEqual(expected)
  })

  it("never requests an app-only, delegation, or deployment scope at either level", () => {
    const all = Object.values(ACCESS_SCOPES).flatMap((sets) => [...sets.read, ...sets.write])
    for (const scope of NEVER_REQUESTED) expect(all, scope).not.toContain(scope)
    for (const access of ["read", "write"] as const) {
      const every = requestedScopes(loadManifest().services.map((service) => service.alias), access)
      for (const scope of NEVER_REQUESTED) expect(every, `${access}: ${scope}`).not.toContain(scope)
    }
    for (const forbidden of ["script.deployments", "drive.scripts", "chat.app.", "chat.admin."]) expect(all.join(" ")).not.toContain(forbidden)
  })

  it("asks for Gmail's full-mailbox and settings scopes only at Read and write", () => {
    const read = Object.values(ACCESS_SCOPES).flatMap((sets) => sets.read)
    for (const scope of ["https://mail.google.com/", `${SCOPE_PREFIX}gmail.settings.basic`, `${SCOPE_PREFIX}gmail.settings.sharing`]) {
      expect(read, scope).not.toContain(scope)
    }
    expect(ACCESS_SCOPES.gmail!.write).toEqual(expect.arrayContaining(["https://mail.google.com/", `${SCOPE_PREFIX}gmail.settings.basic`, `${SCOPE_PREFIX}gmail.settings.sharing`]))
  })

  // No Model Armor helper can run, and cloud-platform grants the whole Cloud project.
  it("never requests cloud-platform", () => {
    expect(ACCESS_SCOPES.modelarmor).toEqual({ read: [], write: [] })
    const every = Object.values(ACCESS_SCOPES).flatMap((sets) => [...sets.read, ...sets.write])
    expect(every).not.toContain(`${SCOPE_PREFIX}cloud-platform`)
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
  const defaultMethods = () => methods().filter((method) => profile.enabledServices.includes(method.service))

  it("enables every manifest service but the delegation services, Model Armor and admin-reports at Read and write, with the admin gate on", () => {
    expect(Object.keys(config.accounts)).toEqual(["default"])
    expect(profile).toMatchObject({ mode: "interactive", access: "write" })
    expect([...profile.enabledServices].sort()).toEqual(
      loadManifest()
        .services.map((service) => service.alias)
        .filter((service) => !DELEGATION_SERVICES.includes(service) && service !== "modelarmor" && service !== "admin-reports")
        .sort(),
    )
    for (const service of ["keep", "modelarmor", "admin-reports"]) expect(profile.enabledServices).not.toContain(service)
    expect(config.admin.enabled).toBe(true)
  })

  it("requests every scope it can use in one consent, under Google's cap", () => {
    expect(requested.length).toBeLessThanOrEqual(MAX_SCOPES)
    expect(requested.length).toBe(42)
    expect(requested).toEqual(expect.arrayContaining([...IDENTITY_SCOPES, "https://mail.google.com/", `${SCOPE_PREFIX}directory.readonly`]))
    for (const scope of ["cloud-platform", "admin.reports.audit.readonly", "admin.reports.usage.readonly"]) expect(requested).not.toContain(`${SCOPE_PREFIX}${scope}`)
    for (const scope of NEVER_REQUESTED) expect(requested).not.toContain(scope)
  })

  it("runs on a Read-only sign-in every read that accepts a read-only scope, apart from the app-only and delegation methods", () => {
    const read = requestedScopes(profile.enabledServices, "read")
    expect(read.length).toBeLessThanOrEqual(MAX_SCOPES)
    expect(read.length).toBe(35)
    for (const scope of NEVER_REQUESTED) expect(read).not.toContain(scope)
    const blocked = defaultMethods()
      .filter((method) => method.category === "read" && method.scopes.some((scope) => scope.endsWith(".readonly")) && !restriction(method.id))
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

  it("covers every method once granted, except watch, deploy, deny, and the app-only and delegation methods", () => {
    const blocked = defaultMethods()
      .filter((method) => !NEVER_RUN.has(method.category) && !grants(acceptedScopes(method.id), requested))
      .map((method) => method.id)
    expect(blocked.sort()).toEqual([...RESTRICTED].filter((id) => !id.startsWith("keep.")).sort())
    const runnable = defaultMethods().filter((method) => !NEVER_RUN.has(method.category) && grants(acceptedScopes(method.id), requested))
    expect(runnable).toHaveLength(defaultMethods().length - defaultMethods().filter((method) => NEVER_RUN.has(method.category)).length - blocked.length)
    expect(runnable).toHaveLength(398)
    for (const helper of commandIndex().helpers.values()) {
      if (!NEVER_RUN.has(helper.category)) expect(grants(acceptedScopes(helper.id), requested), helper.id).toBe(true)
    }
  })

  it("marks exactly the app-only and delegation methods in the catalog, with the reason", () => {
    const entries = catalog({ include: ["methods"], limit: 200, query: "classroom" }).entries
    const all = [...commandIndex().methods.keys()].flatMap((id) => catalog({ include: ["methods"], query: id, limit: 200 }).entries.filter((entry) => entry.id === id))
    expect(all).toHaveLength(commandIndex().methods.size)
    expect(all.filter((entry) => entry.appOnly === true).map((entry) => entry.id).sort()).toEqual([...APP_ONLY_METHODS].sort())
    expect(all.filter((entry) => entry.restriction === "app-only").map((entry) => entry.id).sort()).toEqual([...APP_ONLY_METHODS].sort())
    expect(all.filter((entry) => entry.restriction === "domain-wide-delegation").map((entry) => entry.id).sort()).toEqual([...DELEGATION_METHODS].sort())
    expect(all.filter((entry) => entry.restriction === "domain-wide-delegation").every((entry) => entry.appOnly === undefined)).toBe(true)
    expect(entries.some((entry) => entry.appOnly)).toBe(true)
  })
})

describe("an account that enables Keep", () => {
  const keep = (scopes?: string[]) =>
    loadConfig({ accounts: { notes: { enabledServices: ["gmail", "keep"], access: "write", ...(scopes ? { scopes } : {}) } } }).accounts.notes!

  it("requests no Keep scope at either level, so Google never refuses the consent with invalid_scope", () => {
    for (const access of ["read", "write"] as const) {
      const scopes = signInScopes(keep(), access)
      for (const scope of DELEGATION_SCOPES) expect(scopes, `${access}: ${scope}`).not.toContain(scope)
    }
  })

  it("names Keep as needing domain-wide delegation until the account's scopes add a Keep scope", () => {
    expect(delegationRequired(keep().enabledServices, keep().scopes)).toEqual(["keep"])
    const delegated = keep(["keep.readonly"])
    expect(delegationRequired(delegated.enabledServices, delegated.scopes)).toEqual([])
    expect(signInScopes(delegated, "read")).toContain(`${SCOPE_PREFIX}keep.readonly`)
  })

  it("skips the doctor's Keep probe with the reason, unless the scopes add Keep", () => {
    const skipped = doctorTarget("notes", "keep", true)
    expect(skipped).toEqual({ account: "notes", service: "keep", needsDelegation: true })
    expect(skipDetail(skipped)).toMatch(/^keep needs domain-wide delegation, which a Workspace admin sets up; with it, add keep or keep\.readonly to accounts\.notes\.scopes/)
    expect(doctorTarget("notes", "keep")).toEqual({ account: "notes", service: "keep", operation: "keep.notes.list" })
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
    expect(acceptedScopes("modelarmor.sanitize-prompt")).toEqual([])
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
