import { describe, expect, it } from "vitest"
import { OPERATION_ID } from "../src/domain/contract.js"
import { helperAdapter } from "../src/domain/helpers.js"
import { catalog, commandIndex, HELPER_ALTERNATIVES, helperInput, loadManifest, resolveOperation } from "../src/domain/manifest.js"

const ids = (query: string, extra: Parameters<typeof catalog>[0] = {}) => catalog({ query, limit: 200, ...extra }).entries.map((entry) => entry.id)
const entry = (id: string) => catalog({ query: id, limit: 200 }).entries.find((item) => item.id === id)

describe("operation ids", () => {
  it("never give a helper the id of a method", () => {
    const { methods, helpers } = commandIndex()
    expect([...helpers.keys()].filter((id) => methods.has(id))).toEqual([])
  })

  it("all match the id format the tools accept", () => {
    const { methods, helpers } = commandIndex()
    expect([...methods.keys(), ...helpers.keys()].filter((id) => !OPERATION_ID.test(id))).toEqual([])
  })

  it("resolve to a method or a helper", () => {
    expect(resolveOperation("gmail.users.messages.send")).toMatchObject({ method: { id: "gmail.users.messages.send", category: "send" } })
    expect(resolveOperation("gmail.triage")).toMatchObject({ helper: { id: "gmail.triage", category: "read" } })
    expect(resolveOperation("gmail.users.messages")).toBeUndefined()
  })
})

describe("catalog search", () => {
  it("matches every query word in the id or the description", () => {
    expect(ids("send email")).toEqual(expect.arrayContaining(["gmail.users.messages.send", "gmail.send"]))
    expect(ids("drive files list")).toContain("drive.files.list")
    expect(ids("create event")).toContain("calendar.events.insert")
    expect(ids("messages.list")).toEqual(["chat.spaces.messages.list", "gmail.users.messages.list"])
    expect(ids("files list")[0]).toBe("drive.files.list")
  })

  it("is case-insensitive and needs every word", () => {
    expect(ids("SEND Email")).toEqual(ids("send email"))
    expect(ids("send zzzz-nothing")).toEqual([])
  })

  it("lists entries the plugin can run first, then the best matches", () => {
    const entries = catalog({ query: "send email", limit: 200 }).entries
    const runnable = entries.map((item) => item.executable)
    expect(runnable).toEqual([...runnable].sort((a, b) => Number(b) - Number(a)))
    expect(entries.slice(0, 3).map((item) => item.id)).toEqual(expect.arrayContaining(["gmail.users.messages.send", "gmail.send"]))
  })

  it("filters by service, category, and kind, and caps the result", () => {
    expect(catalog({ service: "gmail", category: "send", include: ["methods"], limit: 200 }).entries.every((item) => item.service === "gmail" && item.category === "send" && item.kind === "method")).toBe(true)
    const capped = catalog({ service: "gmail", limit: 3 })
    expect(capped.entries).toHaveLength(3)
    expect(capped.total).toBeGreaterThan(3)
    expect(catalog({ query: "gmail", include: ["services"] }).entries).toEqual([
      expect.objectContaining({ kind: "service", id: "gmail", executable: true }),
    ])
  })

  it("hides services the model may not use", () => {
    expect(catalog({ query: "files list", limit: 200 }, new Set(["gmail"])).entries.every((item) => item.service === "gmail")).toBe(true)
  })
})

describe("catalog entries", () => {
  it("describe methods with the first sentence from Discovery, or the HTTP call when Discovery has none", () => {
    const methods = [...commandIndex().methods.values()]
    const described = methods.filter((method) => method.description)
    expect(described.length / methods.length).toBeGreaterThan(0.99)
    for (const method of described) expect(method.description!.length, method.id).toBeLessThanOrEqual(160)
    expect(entry("drive.files.list")?.description).toBe("Lists the user's files.")
    for (const method of methods.filter((item) => !item.description)) {
      expect(entry(method.id)?.description, method.id).toBe(`${method.httpMethod} ${method.pathTemplate}`)
    }
  })

  it("mark what can run and name its commit tool", () => {
    expect(entry("gmail.users.messages.send")).toMatchObject({ executable: true, commitTool: "gws_send", category: "send" })
    expect(entry("gmail.users.messages.list")).toMatchObject({ executable: true, category: "read" })
    expect(entry("gmail.users.messages.list")?.commitTool).toBeUndefined()
    expect(entry("drive.files.export")).toMatchObject({ executable: true, commitTool: "gws_export" })
    expect(entry("gmail.triage")).toMatchObject({ kind: "helper", executable: true })
  })

  it("mark denied, deploy, and watch entries as not runnable, with no commit tool", () => {
    for (const id of ["drive.teamdrives.list", "script.projects.deployments.create", "gmail.users.watch", "gmail.watch", "script.push"]) {
      expect(entry(id), id).toMatchObject({ executable: false })
      expect(entry(id)?.commitTool, id).toBeUndefined()
    }
  })

  it("name a runnable method for every helper that cannot run and has one", () => {
    const helpers = loadManifest().services.flatMap((service) => service.helpers)
    for (const helper of helpers) {
      const found = entry(helper.id)!
      if (found.executable) expect(found.alternative, helper.id).toBeUndefined()
      const alternative = HELPER_ALTERNATIVES[helper.id]
      if (alternative === undefined) continue
      expect(found.executable, helper.id).toBe(false)
      expect(found.alternative, helper.id).toBe(alternative)
      expect(entry(alternative), alternative).toMatchObject({ kind: "method", executable: true })
    }
    expect(entry("chat.send")).toMatchObject({ executable: false, alternative: "chat.spaces.messages.create" })
    expect(entry("drive.upload")).toMatchObject({ executable: false, alternative: "drive.files.create" })
  })

  it("list an alternative only for helpers that exist", () => {
    for (const id of Object.keys(HELPER_ALTERNATIVES)) expect(commandIndex().helpers.has(id), id).toBe(true)
  })
})

describe("helper input flags", () => {
  it("are a JSON Schema for every runnable helper and absent otherwise", () => {
    for (const helper of commandIndex().helpers.values()) {
      const input = helperInput(helper.id) as { type?: string } | undefined
      if (helperAdapter(helper.id) && entry(helper.id)?.executable) expect(input?.type, helper.id).toBe("object")
      else expect(input, helper.id).toBeUndefined()
    }
  })
})
