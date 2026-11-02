import { describe, expect, it } from "vitest"
import { commandIndex, loadManifest } from "../src/domain/manifest.js"
import {
  ACCESS_SCOPES,
  EXTRA_SCOPE_METHODS,
  IDENTITY_SCOPES,
  SCOPE_PREFIX,
  WRITE_ACCESS_READS,
  acceptedScopes,
  grantedScopes,
  grants,
  requestedScopes,
  scopeUrl,
} from "../src/domain/scopes.js"

const CHANGES = new Set(["write", "send", "share", "delete", "export"])
const methods = () => [...commandIndex().methods.values()]
const covers = (set: readonly string[], scopes: readonly string[]) => scopes.some((scope) => set.includes(scope))

describe("scope table against the manifest", () => {
  it("has an entry for every manifest service and no other", () => {
    expect(Object.keys(ACCESS_SCOPES).sort()).toEqual(loadManifest().services.map((service) => service.alias).sort())
  })

  it("covers every read with the read set, except reads that need write access or an extra scope", () => {
    const uncovered = methods()
      .filter((method) => method.category === "read" && !covers(ACCESS_SCOPES[method.service]!.read, method.scopes))
      .map((method) => method.id)
    expect(uncovered.sort()).toEqual([...WRITE_ACCESS_READS, ...[...EXTRA_SCOPE_METHODS].filter((id) => commandIndex().methods.get(id)?.category === "read")].sort())
  })

  it("covers every read and every change with the write set, except the extra-scope methods", () => {
    const uncovered = methods()
      .filter((method) => (method.category === "read" || CHANGES.has(method.category)) && !covers(ACCESS_SCOPES[method.service]!.write, method.scopes))
      .map((method) => method.id)
    expect(uncovered.sort()).toEqual([...EXTRA_SCOPE_METHODS].sort())
  })

  it("lists each exception once, as a real manifest method", () => {
    for (const id of [...WRITE_ACCESS_READS, ...EXTRA_SCOPE_METHODS]) expect(commandIndex().methods.has(id), id).toBe(true)
    for (const id of WRITE_ACCESS_READS) {
      expect(EXTRA_SCOPE_METHODS.has(id), id).toBe(false)
      expect(commandIndex().methods.get(id)?.category).toBe("read")
    }
  })

  it("keeps the read sets read-only for Gmail, Drive, Calendar, Docs, Sheets, and Slides", () => {
    for (const service of ["gmail", "drive", "calendar", "docs", "sheets", "slides"]) {
      for (const scope of ACCESS_SCOPES[service]!.read) expect(scope, service).toMatch(/\.readonly$/)
    }
    expect(ACCESS_SCOPES.gmail!.read).toEqual([`${SCOPE_PREFIX}gmail.readonly`])
    expect(ACCESS_SCOPES.drive!.read).toEqual([`${SCOPE_PREFIX}drive.readonly`])
  })

  it("never requests deployments, cloud-platform, or Gmail's full-mailbox scope", () => {
    const all = Object.values(ACCESS_SCOPES).flatMap((sets) => [...sets.read, ...sets.write])
    for (const forbidden of ["script.deployments", "cloud-platform", "https://mail.google.com/", "gmail.settings", "drive.scripts"]) {
      expect(all.join(" ")).not.toContain(forbidden)
    }
    expect(ACCESS_SCOPES.modelarmor).toEqual({ read: [], write: [] })
  })

  it("lets People's read sign-in search and list the directory and other contacts", () => {
    const read = requestedScopes(["people"], "read")
    for (const id of ["people.people.searchDirectoryPeople", "people.people.listDirectoryPeople", "people.otherContacts.list", "people.otherContacts.search"]) {
      expect(commandIndex().methods.get(id)?.category, id).toBe("read")
      expect(grants(acceptedScopes(id), read), id).toBe(true)
      expect(grants(acceptedScopes(id), requestedScopes(["people"], "write")), id).toBe(true)
    }
    for (const scope of ACCESS_SCOPES.people!.read) expect(scope).toMatch(/\.readonly$/)
  })

  it("gives composite services the union of their parts", () => {
    expect(ACCESS_SCOPES.workflow!.read).toEqual(expect.arrayContaining([...ACCESS_SCOPES.gmail!.read, ...ACCESS_SCOPES.calendar!.read, ...ACCESS_SCOPES.tasks!.read]))
    expect(ACCESS_SCOPES.events!.write).toEqual(expect.arrayContaining([...ACCESS_SCOPES.chat!.write]))
  })
})

describe("requested scopes", () => {
  it("are the read sets plus identity for a read sign-in, and never a write scope", () => {
    const scopes = requestedScopes(["gmail", "drive", "calendar", "docs", "sheets"], "read")
    expect(scopes).toEqual([
      `${SCOPE_PREFIX}gmail.readonly`,
      `${SCOPE_PREFIX}drive.readonly`,
      `${SCOPE_PREFIX}calendar.readonly`,
      `${SCOPE_PREFIX}documents.readonly`,
      `${SCOPE_PREFIX}spreadsheets.readonly`,
      ...IDENTITY_SCOPES,
    ])
  })

  it("apply per-service access and extra scopes without duplicates", () => {
    const scopes = requestedScopes(["gmail", "drive"], { drive: "write" }, [`${SCOPE_PREFIX}drive`, `${SCOPE_PREFIX}directory.readonly`])
    expect(scopes).toEqual([`${SCOPE_PREFIX}gmail.readonly`, `${SCOPE_PREFIX}drive`, `${SCOPE_PREFIX}directory.readonly`, ...IDENTITY_SCOPES])
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
    expect(acceptedScopes("gmail.triage")).toEqual([`${SCOPE_PREFIX}gmail.readonly`, `${SCOPE_PREFIX}gmail.modify`])
    expect(acceptedScopes("gmail.send")).toEqual([`${SCOPE_PREFIX}gmail.modify`])
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
