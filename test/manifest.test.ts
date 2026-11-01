import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { compactManifest, expandManifest, manifestText } from "../scripts/manifest-format.mjs"
import { catalog, loadManifest, resolveOperation } from "../src/domain/manifest.js"

const category = (id: string) => {
  const found = resolveOperation(id)
  return found && ("method" in found ? found.method.category : found.helper.category)
}

describe("stored manifest", () => {
  const text = readFileSync(new URL("../manifest/generated.json", import.meta.url), "utf8")

  it("is read the same way by the plugin and by the generator, drift and docs scripts", () => {
    expect(loadManifest()).toEqual(expandManifest(JSON.parse(text)))
  })

  it("is exactly what the generator writes for its expanded form, minified with a shared scope table", () => {
    expect(manifestText(loadManifest())).toBe(text)
    const stored = compactManifest(loadManifest())
    expect(stored.scopes).toEqual([...new Set(stored.scopes)].sort())
    expect(text.split("\n")).toHaveLength(2)
  })

  it("derives each method's service, path and method from its id", () => {
    const method = loadManifest().services.flatMap((service) => service.methods).find((entry) => entry.id === "gmail.users.messages.list")
    expect(method).toMatchObject({ service: "gmail", path: ["users", "messages"], method: "list", httpMethod: "GET" })
    expect(method?.scopes).toContain("https://www.googleapis.com/auth/gmail.readonly")
  })
})

describe("manifest coverage contract", () => {
  it("covers every invocable service", () => {
    const manifest = loadManifest()
    expect(manifest.services).toHaveLength(18)
    expect(manifest.services.flatMap((service) => service.methods)).toHaveLength(471)
    expect(manifest.services.flatMap((service) => service.helpers)).toHaveLength(25)
  })

  it("has the full Gmail surface", () => {
    const gmail = loadManifest().services.find((service) => service.alias === "gmail")
    expect(gmail?.methods).toHaveLength(79)
    expect(gmail?.helpers).toHaveLength(7)
  })

  it("classifies high-risk Gmail operations correctly", () => {
    expect(category("gmail.users.drafts.create")).toBe("write")
    expect(category("gmail.users.messages.delete")).toBe("delete")
    expect(category("gmail.users.settings.delegates.create")).toBe("share")
    expect(category("gmail.users.watch")).toBe("watch")
  })

  it("classifies cross-service edge cases correctly", () => {
    expect(category("drive.files.export")).toBe("export")
    expect(category("sheets.spreadsheets.values.clear")).toBe("delete")
    expect(category("sheets.spreadsheets.getByDataFilter")).toBe("read")
    expect(category("script.projects.deployments.create")).toBe("deploy")
    expect(category("drive.teamdrives.list")).toBe("deny")
    expect(category("drive.permissions.delete")).toBe("share")
    expect(category("drive.permissions.list")).toBe("read")
    expect(category("calendar.acl.delete")).toBe("share")
    expect(category("calendar.acl.list")).toBe("read")
    expect(category("drive.files.generateCseToken")).toBe("admin")
    expect(category("forms.forms.watches.create")).toBe("watch")
    expect(category("classroom.registrations.create")).toBe("watch")
    expect(category("script.scripts.run")).toBe("deploy")
  })

  it("indexes helpers by id and exposes them in the catalog", () => {
    expect(category("gmail.send")).toBe("send")
    expect(category("gmail.read")).toBe("read")
    const { entries } = catalog({ query: "gmail.read", include: ["helpers"] })
    expect(entries.map((entry) => entry.id)).toContain("gmail.read")
  })

  it("has no method without a category", () => {
    const services = loadManifest().services
    expect(services.flatMap((service) => service.methods).filter((method) => !method.category)).toHaveLength(0)
    expect(services.flatMap((service) => service.helpers).filter((helper) => !helper.category)).toHaveLength(0)
  })
})
