import { describe, expect, it } from "vitest"
import { addressesIn, mimeRecipients, recipientPlan } from "../src/domain/recipients.js"
import { request } from "./support/requests.js"

describe("addressesIn", () => {
  it.each([
    ["alice@example.com", ["alice@example.com"]],
    ["Alice <Alice@Example.COM>", ["alice@example.com"]],
    ["a@example.com, b@example.com;c@example.com", ["a@example.com", "b@example.com", "c@example.com"]],
    ['"Doe, Jane" <jane@example.com>', ["jane@example.com"]],
    ["Team: a@example.com, b@example.com;", ["a@example.com", "b@example.com"]],
    ["a@example.com (cc evil@evil.com)", ["a@example.com", "evil@evil.com"]],
    ["undisclosed-recipients:;", []],
  ])("reads %s", (text, expected) => {
    expect(addressesIn(text)).toEqual({ addresses: expected, unreadable: [] })
  })

  it.each(['"evil x"@evil.com', "evil@[192.0.2.1]", "evil@localhost", "evil@"])("reports %s as unreadable", (text) => {
    expect(addressesIn(text).unreadable).toHaveLength(1)
  })
})

describe("mimeRecipients", () => {
  const encode = (text: string, encoding: BufferEncoding = "base64url") => Buffer.from(text).toString(encoding)

  it("reads To, Cc and Bcc from base64url and base64, unfolding headers", () => {
    const message = "From: me@example.com\r\nTo: a@example.com,\r\n b@example.com\r\nCc: c@example.com\r\nBcc: d@example.com\r\n\r\nTo: not-a-header@evil.com"
    expect(mimeRecipients(encode(message))).toEqual([" a@example.com, b@example.com", " c@example.com", " d@example.com"])
    expect(mimeRecipients(encode(message, "base64"))).toEqual(mimeRecipients(encode(message)))
  })

  it("is undefined for anything without a header block", () => {
    expect(mimeRecipients(encode("just text, no headers"))).toBeUndefined()
    expect(mimeRecipients("%%%")).toBeUndefined()
    expect(mimeRecipients(42)).toBeUndefined()
  })
})

describe("recipientPlan", () => {
  it("knows nothing about a send without an entry", () => {
    expect(recipientPlan("chat.spaces.messages.create", "send", request("chat.spaces.messages.create")).known.unknown).toMatch(/cannot tell/)
  })

  it("reads an event change's stored guests only when it notifies", () => {
    const req = request("calendar.events.patch", { params: { calendarId: "primary", eventId: "e1" } })
    expect(recipientPlan("calendar.events.patch", "send", req).lookups.map((lookup) => lookup.operation)).toEqual(["calendar.events.get"])
    expect(recipientPlan("calendar.events.patch", "write", req).lookups).toEqual([])
  })

  it("reads a Chat member's email, and fails closed on a member named by id", () => {
    const member = (name: unknown) => recipientPlan("chat.spaces.members.create", "share", request("chat.spaces.members.create", { params: { parent: "spaces/s" }, body: { member: { name } } })).known
    expect(member("users/ann@example.com")).toMatchObject({ addresses: ["ann@example.com"] })
    expect(member("users/ann@example.com").unknown).toBeUndefined()
    for (const name of ["users/123456789", undefined, 42]) expect(member(name).unknown, String(name)).toBe("the member is not named by email (users/<email>)")
  })

  it("reads every Keep share's email, and fails closed on a share without one or a body it cannot read", () => {
    const share = (body: unknown) => recipientPlan("keep.notes.permissions.batchCreate", "share", request("keep.notes.permissions.batchCreate", { params: { parent: "notes/n" }, body })).known
    const both = share({ requests: [{ permission: { email: "ann@example.com" } }, { permission: { email: "Bob <bob@other.com>" } }] })
    expect(both.addresses).toEqual(["ann@example.com", "bob@other.com"])
    expect(both.unknown).toBeUndefined()
    expect(share({ requests: [{ permission: { email: "ann@example.com" } }, { permission: { role: "WRITER" } }] }).unknown).toBe("a permission names no email")
    for (const body of [{}, { requests: [] }, { requests: "x" }]) expect(share(body).unknown, JSON.stringify(body)).toBe("the permission requests could not be read")
  })

  it("scans recipient keys of a read without failing closed", () => {
    expect(recipientPlan("gmail.users.messages.list", "read", request("gmail.users.messages.list", { params: { q: "x" } })).known).toEqual({ addresses: [], domains: [] })
  })
})
