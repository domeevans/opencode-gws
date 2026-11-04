import { afterEach, describe, expect, it } from "vitest"
import type { RequestInput } from "../src/domain/contract.js"
import type { Runtime } from "../src/runtime/index.js"
import { account, testRuntime } from "./support/config.js"

/**
 * The recipient rules, end to end through gws_plan with the fake gws: every
 * shape that used to slip past them, the reads that find recipients a
 * request does not carry, and the fail-closed refusals.
 */

const ctx = { sessionId: "ses_recipients", agentId: "build" }
const SERVICES = ["gmail", "drive", "calendar", "chat"]
const DOMAIN_RULE = { id: "example-only", effect: "deny", categories: ["send", "share"], allowedRecipientDomains: ["example.com"] }
const INTERNAL_RULE = { id: "internal-only", effect: "deny", categories: ["send", "share"], allowExternalRecipients: false }

const runtimes: Runtime[] = []
afterEach(async () => {
  delete process.env["FAKE_GWS_RESPONSES"]
  for (const runtime of runtimes.splice(0)) await runtime.close()
})

async function runtime(rules: unknown[], profile: Record<string, unknown> = {}): Promise<Runtime> {
  const created = await testRuntime({ accounts: { personal: { ...account({ services: SERVICES, access: "write" }), ...profile } }, policy: { rules } })
  runtimes.push(created)
  return created
}

/** Answers for the reads the plugin makes, by method id; null fails that read. */
function responses(value: Record<string, unknown>): void {
  process.env["FAKE_GWS_RESPONSES"] = JSON.stringify(value)
}

const send = (input: Record<string, unknown>): RequestInput => ({ operation: "gmail.send", input: { subject: "s", body: "b", ...input } })
const raw = (headers: string): string => Buffer.from(`${headers}\r\n\r\nHello\r\n`).toString("base64url")
const message = (headers: Record<string, string>) => ({ payload: { headers: Object.entries(headers).map(([name, value]) => ({ name, value })) } })

describe("recipient rules read every address", () => {
  it.each([
    ["a comma-separated string", "ok@example.com, evil@evil.com"],
    ["a list with no spaces", "ok@example.com,evil@evil.com"],
    ["a semicolon list", "ok@example.com; evil@evil.com"],
    ["a display-name address", "Evil <evil@evil.com>"],
    ["a quoted display name with a comma", '"Doe, Jane" <ok@example.com>, "Evil" <evil@evil.com>'],
    ["a group", "Friends: ok@example.com, evil@evil.com;"],
    ["an address in an array", ["ok@example.com", "Evil <evil@evil.com>"]],
  ])("refuses %s outside the allowed domains", async (_shape, to) => {
    const gws = await runtime([DOMAIN_RULE])
    await expect(gws.plan(send({ to }), ctx)).rejects.toThrow(/^POLICY_DENIED: .*evil@evil\.com/)
  })

  it("checks cc and bcc as well as to", async () => {
    const gws = await runtime([DOMAIN_RULE])
    await expect(gws.plan(send({ to: "ok@example.com", bcc: "Evil <evil@evil.com>" }), ctx)).rejects.toThrow(/^POLICY_DENIED:/)
    await expect(gws.plan(send({ to: "ok@example.com", cc: "ok2@example.com" }), ctx)).resolves.toMatchObject({ category: "send" })
  })

  it("fails closed on an address it cannot read", async () => {
    const gws = await runtime([DOMAIN_RULE])
    await expect(gws.plan(send({ to: '"evil x"@evil.com' }), ctx)).rejects.toThrow(/^RECIPIENTS_UNKNOWN:/)
  })

  it("checks a forward's recipients", async () => {
    const gws = await runtime([DOMAIN_RULE])
    await expect(gws.plan({ operation: "gmail.forward", input: { messageId: "m1", to: "ok@example.com, evil@evil.com" } }, ctx)).rejects.toThrow(/^POLICY_DENIED:/)
  })
})

describe("raw messages", () => {
  const sendRaw = (value: string): RequestInput => ({ operation: "gmail.users.messages.send", params: { userId: "me" }, body: { raw: value } })

  it("reads To, Cc and Bcc from the raw headers, folded or not", async () => {
    const gws = await runtime([DOMAIN_RULE])
    await expect(gws.plan(sendRaw(raw("To: ok@example.com\r\nSubject: s")), ctx)).resolves.toMatchObject({ category: "send" })
    await expect(gws.plan(sendRaw(raw("To: evil@evil.com\r\nSubject: s")), ctx)).rejects.toThrow(/^POLICY_DENIED: .*evil@evil\.com/)
    await expect(gws.plan(sendRaw(raw("To: ok@example.com\r\nBcc: Evil <evil@evil.com>")), ctx)).rejects.toThrow(/^POLICY_DENIED:/)
    await expect(gws.plan(sendRaw(raw("To: ok@example.com,\r\n  evil@evil.com")), ctx)).rejects.toThrow(/^POLICY_DENIED:/)
    await expect(gws.plan(sendRaw(raw("To: ok@example.com\r\nCC : evil@evil.com")), ctx)).rejects.toThrow(/^POLICY_DENIED:/)
  })

  it("refuses a raw message whose recipients it cannot read", async () => {
    const gws = await runtime([DOMAIN_RULE])
    await expect(gws.plan(sendRaw(raw("Subject: no recipients")), ctx)).rejects.toThrow(/^RECIPIENTS_UNKNOWN:/)
    await expect(gws.plan(sendRaw("not base64 at all!"), ctx)).rejects.toThrow(/^RECIPIENTS_UNKNOWN:/)
    await expect(gws.plan({ operation: "gmail.users.messages.send", params: { userId: "me" }, body: { threadId: "t1" } }, ctx)).rejects.toThrow(/^RECIPIENTS_UNKNOWN:/)
  })

  it("plans a raw message with no recipient rule", async () => {
    const gws = await runtime([])
    await expect(gws.plan(sendRaw(raw("Subject: no recipients")), ctx)).resolves.toMatchObject({ category: "send" })
  })
})

describe("recipients the request does not carry", () => {
  it("reads the sender of the message a reply answers", async () => {
    const gws = await runtime([DOMAIN_RULE])
    responses({ "gmail.users.messages.get": message({ From: "Evil <evil@evil.com>", To: "me@example.com" }) })
    await expect(gws.plan({ operation: "gmail.reply", input: { messageId: "m1", body: "hi" } }, ctx)).rejects.toThrow(/^POLICY_DENIED: .*evil@evil\.com/)
    responses({ "gmail.users.messages.get": message({ From: "Ok <ok@example.com>", "Reply-To": "evil@evil.com" }) })
    await expect(gws.plan({ operation: "gmail.reply", input: { messageId: "m1", body: "hi" } }, ctx)).rejects.toThrow(/^POLICY_DENIED: .*evil@evil\.com/)
    responses({ "gmail.users.messages.get": message({ From: "Ok <ok@example.com>", Cc: "evil@evil.com" }) })
    await expect(gws.plan({ operation: "gmail.reply", input: { messageId: "m1", body: "hi" } }, ctx)).resolves.toMatchObject({ category: "send" })
  })

  it("reads everyone a reply-all reaches", async () => {
    const gws = await runtime([DOMAIN_RULE])
    responses({ "gmail.users.messages.get": message({ From: "ok@example.com", To: "me@example.com", Cc: "Evil <evil@evil.com>" }) })
    await expect(gws.plan({ operation: "gmail.reply-all", input: { messageId: "m1", body: "hi" } }, ctx)).rejects.toThrow(/^POLICY_DENIED: .*evil@evil\.com/)
  })

  it("refuses a reply when the original message cannot be read", async () => {
    const gws = await runtime([DOMAIN_RULE])
    responses({ "gmail.users.messages.get": null })
    await expect(gws.plan({ operation: "gmail.reply", input: { messageId: "m1", body: "hi" } }, ctx)).rejects.toThrow(/^RECIPIENTS_UNKNOWN: .*message being replied to/)
  })

  it("reads a draft's stored recipients before sending it", async () => {
    const gws = await runtime([DOMAIN_RULE])
    const draft = { operation: "gmail.users.drafts.send", params: { userId: "me" }, body: { id: "d1" } }
    responses({ "gmail.users.drafts.get": { message: message({ To: "ok@example.com", Bcc: "evil@evil.com" }) } })
    await expect(gws.plan(draft, ctx)).rejects.toThrow(/^POLICY_DENIED: .*evil@evil\.com/)
    responses({ "gmail.users.drafts.get": null })
    await expect(gws.plan(draft, ctx)).rejects.toThrow(/^RECIPIENTS_UNKNOWN: .*draft/)
    responses({ "gmail.users.drafts.get": { message: message({ To: "ok@example.com" }) } })
    await expect(gws.plan(draft, ctx)).resolves.toMatchObject({ category: "send" })
  })

  it("reads a draft again at commit and refuses when its recipients changed", async () => {
    const gws = await runtime([DOMAIN_RULE])
    const draft = { operation: "gmail.users.drafts.send", params: { userId: "me" }, body: { id: "d1" } }
    responses({ "gmail.users.drafts.get": { message: message({ To: "ok@example.com" }) } })
    const plan = await gws.plan(draft, ctx)
    responses({ "gmail.users.drafts.get": { message: message({ To: "ok@example.com, evil@evil.com" }) } })
    await expect(gws.commit("send", { planId: plan.planId }, ctx)).rejects.toThrow(/^POLICY_DENIED: .*evil@evil\.com/)
    await expect(gws.commit("send", { planId: plan.planId }, ctx)).rejects.toThrow(/^PLAN_EXPIRED:/)
  })

  it("reads an event's guests before a notifying change", async () => {
    const gws = await runtime([DOMAIN_RULE])
    responses({ "calendar.events.get": { attendees: [{ email: "ok@example.com" }, { email: "evil@evil.com" }] } })
    const change = { operation: "calendar.events.patch", params: { calendarId: "primary", eventId: "e1", sendUpdates: "all" }, body: { summary: "Moved" } }
    await expect(gws.plan(change, ctx)).rejects.toThrow(/^POLICY_DENIED: .*evil@evil\.com/)
  })
})

describe("notifying Calendar writes", () => {
  it("checks the guests of an event created with the deprecated sendNotifications", async () => {
    const gws = await runtime([DOMAIN_RULE])
    const insert = { operation: "calendar.events.insert", params: { calendarId: "primary", sendNotifications: true }, body: { summary: "Sync", attendees: [{ email: "evil@evil.com" }] } }
    await expect(gws.plan(insert, ctx)).rejects.toThrow(/^POLICY_DENIED: .*evil@evil\.com/)
    const quiet = { ...insert, params: { calendarId: "primary", sendNotifications: false } }
    await expect(gws.plan(quiet, ctx)).resolves.toMatchObject({ category: "write" })
  })
})

describe("shares", () => {
  it("reads Calendar ACL scopes, by address, domain and rule id", async () => {
    const gws = await runtime([DOMAIN_RULE])
    const acl = (body: unknown, params: Record<string, unknown> = {}) => ({ operation: "calendar.acl.insert", params: { calendarId: "primary", ...params }, body })
    await expect(gws.plan(acl({ role: "reader", scope: { type: "user", value: "evil@evil.com" } }), ctx)).rejects.toThrow(/^POLICY_DENIED:/)
    await expect(gws.plan(acl({ role: "reader", scope: { type: "domain", value: "evil.com" } }), ctx)).rejects.toThrow(/^POLICY_DENIED: .*\*@evil\.com/)
    await expect(gws.plan({ operation: "calendar.acl.patch", params: { calendarId: "primary", ruleId: "user:evil@evil.com" }, body: { role: "writer" } }, ctx)).rejects.toThrow(/^POLICY_DENIED:/)
    await expect(gws.plan(acl({ role: "reader", scope: { type: "user", value: "ok@example.com" } }), ctx)).resolves.toMatchObject({ category: "share" })
  })

  it("treats a Calendar ACL for everyone as public sharing", async () => {
    const gws = await runtime([{ id: "no-public", effect: "deny", categories: ["share"], allowPublicSharing: false }])
    await expect(gws.plan({ operation: "calendar.acl.insert", params: { calendarId: "primary" }, body: { role: "reader", scope: { type: "default" } } }, ctx)).rejects.toThrow(/Public sharing is disabled/)
  })

  it("reads Gmail delegate, forwarding and Drive domain shares", async () => {
    const gws = await runtime([DOMAIN_RULE])
    await expect(gws.plan({ operation: "gmail.users.settings.delegates.create", params: { userId: "me" }, body: { delegateEmail: "evil@evil.com" } }, ctx)).rejects.toThrow(/^POLICY_DENIED:/)
    await expect(gws.plan({ operation: "gmail.users.settings.forwardingAddresses.create", params: { userId: "me" }, body: { forwardingEmail: "evil@evil.com" } }, ctx)).rejects.toThrow(/^POLICY_DENIED:/)
    await expect(gws.plan({ operation: "drive.permissions.create", params: { fileId: "f1" }, body: { role: "reader", type: "domain", domain: "evil.com" } }, ctx)).rejects.toThrow(/^POLICY_DENIED:/)
  })

  it("refuses a send or share whose recipients the plugin does not know", async () => {
    const gws = await runtime([DOMAIN_RULE])
    await expect(gws.plan({ operation: "chat.spaces.messages.create", params: { parent: "spaces/s1" }, body: { text: "hi" } }, ctx)).rejects.toThrow(/^RECIPIENTS_UNKNOWN:/)
  })

  it("lets a share that only removes access through", async () => {
    const gws = await runtime([DOMAIN_RULE])
    await expect(gws.plan({ operation: "drive.permissions.delete", params: { fileId: "f1", permissionId: "p1" } }, ctx)).resolves.toMatchObject({ category: "share" })
  })
})

describe("allowExternalRecipients: false", () => {
  it("measures external against the account's own domain, not the first recipient", async () => {
    const gws = await runtime([INTERNAL_RULE])
    responses({ "gmail.users.getProfile": { emailAddress: "me@example.com" } })
    await expect(gws.plan(send({ to: "evil@evil.com" }), ctx)).rejects.toThrow(/^POLICY_DENIED: External recipients are disabled: evil@evil\.com/)
    await expect(gws.plan(send({ to: ["a@evil.com", "b@evil.com"] }), ctx)).rejects.toThrow(/^POLICY_DENIED:/)
    await expect(gws.plan(send({ to: "colleague@example.com" }), ctx)).resolves.toMatchObject({ category: "send" })
  })

  it("uses accounts.<alias>.domains when set", async () => {
    const gws = await runtime([INTERNAL_RULE], { domains: ["example.com", "example.org"] })
    responses({ "gmail.users.getProfile": null })
    await expect(gws.plan(send({ to: "colleague@example.org" }), ctx)).resolves.toMatchObject({ category: "send" })
    await expect(gws.plan(send({ to: "evil@evil.com" }), ctx)).rejects.toThrow(/^POLICY_DENIED:/)
  })

  it("fails closed when the account's own domain is unknown", async () => {
    const gws = await runtime([INTERNAL_RULE])
    responses({ "gmail.users.getProfile": null, "drive.about.get": null, "calendar.calendars.get": null })
    await expect(gws.plan(send({ to: "colleague@example.com" }), ctx)).rejects.toThrow(/^ACCOUNT_DOMAIN_UNKNOWN: .*Next step: .*accounts\.personal\.domains/)
  })
})

describe("previews name who a send or share reaches", () => {
  it("lists a reply's real recipients, without the account itself", async () => {
    const gws = await runtime([])
    responses({
      "gmail.users.getProfile": { emailAddress: "me@example.com" },
      "gmail.users.messages.get": message({ From: "Alice <alice@example.com>", To: "me@example.com, bob@example.com", Cc: "carol@example.org" }),
    })
    const reply = await gws.plan({ operation: "gmail.reply", input: { messageId: "m1", body: "hi", cc: "dave@example.com" } }, ctx)
    expect(reply.preview.recipients?.sort()).toEqual(["alice@example.com", "dave@example.com"])
    const all = await gws.plan({ operation: "gmail.reply-all", input: { messageId: "m1", body: "hi" } }, ctx)
    expect(all.preview.recipients?.sort()).toEqual(["alice@example.com", "bob@example.com", "carol@example.org"])
  })

  it("lists a raw message's recipients and a domain share", async () => {
    const gws = await runtime([])
    const sent = await gws.plan({ operation: "gmail.users.messages.send", params: { userId: "me" }, body: { raw: raw("To: Bob <bob@example.com>\r\nCc: carol@example.org") } }, ctx)
    expect(sent.preview.recipients).toEqual(["bob@example.com", "carol@example.org"])
    const shared = await gws.plan({ operation: "drive.permissions.create", params: { fileId: "f1" }, body: { role: "reader", type: "domain", domain: "example.org" } }, ctx)
    expect(shared.preview.recipients).toEqual(["*@example.org"])
  })

  it("says when it could not tell who a send reaches", async () => {
    const gws = await runtime([])
    const posted = await gws.plan({ operation: "chat.spaces.messages.create", params: { parent: "spaces/s1" }, body: { text: "hi" } }, ctx)
    expect(posted.preview.recipientsUnknown).toMatch(/cannot tell/)
    responses({ "gmail.users.messages.get": null })
    const reply = await gws.plan({ operation: "gmail.reply", input: { messageId: "m1", body: "hi" } }, ctx)
    expect(reply.preview.recipientsUnknown).toMatch(/message being replied to/)
  })
})

