import type { Category, Request } from "./types.js"

/**
 * Who a send or share reaches, for the recipient rules and the preview.
 *
 * Each send and share method the plugin can tell about has an entry: where
 * its recipients are in the request, and which read finds the ones the
 * request does not carry (the sender of the message a reply answers, a
 * draft's stored headers, an event's guests). A send or share without an
 * entry, or whose recipients cannot all be read, has `unknown` set, and a
 * recipient rule then refuses it: the gate fails closed.
 */

export interface RecipientSet {
  /** Lowercased addresses. */
  addresses: string[]
  /** Domains given access as a whole (a Drive or Calendar domain share), lowercased. */
  domains: string[]
}

export interface Recipients extends RecipientSet {
  /** Why the recipients could not all be determined; absent when they were. */
  unknown?: string
  /** The change makes the item public (a Calendar ACL for everyone). */
  public?: true
}

/** A read that finds recipients the request does not carry. */
export interface RecipientLookup {
  /** A read method id from the manifest. */
  operation: string
  params: Record<string, unknown>
  /** What the read finds, for the refusal: "the message being replied to". */
  what: string
  /** Why recipients that are still none after this read stay unknown: a draft always names someone, so none means the read found nothing. */
  none?: string
  /**
   * The recipients in its response, or undefined when the response has an
   * unexpected shape. `self` is the account's own address, when known.
   */
  extract(data: unknown, self: string | undefined): RecipientSet | undefined
}

export interface RecipientPlan {
  known: Recipients
  lookups: RecipientLookup[]
  /** A lookup's answer depends on the account's own address (replies). */
  needsSelf?: true
}

/** Every address in a recipient field: bare, `Name <addr>`, lists split by `,` or `;`, and groups. */
export function addressesIn(text: string): { addresses: string[]; unreadable: string[] } {
  const addresses: string[] = []
  const unreadable: string[] = []
  // Scan for every "@" instead of parsing the RFC 5322 grammar: a display
  // name, a comment, or a group can then never hide an address.
  for (const match of text.matchAll(/([A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]*)@(\[[^\]]*\]?|[^\s<>()[\]\\,;:"@]*)/g)) {
    const local = match[1]!.replace(/^\.+/, "")
    const domain = match[2]!.toLowerCase().replace(/\.+$/, "")
    if (!local && !domain) continue
    if (!local || !/^[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+$/u.test(domain)) {
      unreadable.push(match[0])
      continue
    }
    addresses.push(`${local.toLowerCase()}@${domain}`)
  }
  return { addresses, unreadable }
}

export function domainOf(address: string): string {
  return address.slice(address.lastIndexOf("@") + 1)
}

/** Builds a recipient set, noting the first value that held an address it could not read. */
class Collector {
  readonly addresses = new Set<string>()
  readonly domains = new Set<string>()
  unknown?: string
  public?: true

  text(value: unknown): void {
    if (typeof value === "string") {
      const found = addressesIn(value)
      for (const address of found.addresses) this.addresses.add(address)
      if (found.unreadable.length > 0) this.fail(`an address could not be read: ${found.unreadable[0]}`)
      return
    }
    if (Array.isArray(value)) for (const item of value) this.text(item)
  }

  domain(value: unknown): void {
    if (typeof value === "string" && /^[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+$/u.test(value.trim())) this.domains.add(value.trim().toLowerCase())
    else this.fail("the domain it shares with could not be read")
  }

  add(set: RecipientSet): void {
    for (const address of set.addresses) this.addresses.add(address)
    for (const domain of set.domains) this.domains.add(domain)
  }

  fail(reason: string): void {
    this.unknown ??= reason
  }

  result(): Recipients {
    return {
      addresses: [...this.addresses],
      domains: [...this.domains],
      ...(this.unknown ? { unknown: this.unknown } : {}),
      ...(this.public ? { public: true as const } : {}),
    }
  }
}

/** Keys whose values are recipients wherever they appear in a request. */
const RECIPIENT_KEYS = new Set(["to", "cc", "bcc", "email", "emailaddress", "address", "recipient", "recipients", "attendees", "delegateemail", "forwardingemail"])

/** Every address under a recipient key anywhere in the request: the reading for methods without an entry. */
export function scanRecipients(request: Pick<Request, "params" | "body" | "input">): Recipients {
  const out = new Collector()
  const visit = (value: unknown, collecting: boolean): void => {
    if (typeof value === "string") {
      if (collecting) out.text(value)
      return
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, collecting)
      return
    }
    if (value && typeof value === "object") {
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) visit(child, collecting || RECIPIENT_KEYS.has(key.toLowerCase()))
    }
  }
  visit(request.params, false)
  visit(request.body, false)
  visit(request.input, false)
  return out.result()
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

/**
 * The To, Cc and Bcc header values of a base64 or base64url RFC 2822
 * message, or undefined when it does not decode to a header block.
 */
export function mimeRecipients(raw: unknown): string[] | undefined {
  if (typeof raw !== "string" || raw.length === 0 || !/^[A-Za-z0-9+/_=\s-]+$/.test(raw)) return undefined
  const message = Buffer.from(raw.replace(/\s+/g, ""), "base64").toString("utf8")
  const end = /\r?\n\r?\n/.exec(message)
  const head = (end ? message.slice(0, end.index) : message).replace(/\r?\n[ \t]+/g, " ")
  const lines = head.split(/\r?\n/)
  if (!lines.every((line) => line === "" || /^[!-9;-~]+[ \t]*:/.test(line))) return undefined
  return lines.filter((line) => /^(?:to|cc|bcc)[ \t]*:/i.test(line)).map((line) => line.slice(line.indexOf(":") + 1))
}

/** Header values by lowercased name from a Gmail message resource (format metadata). */
function headers(message: unknown): Map<string, string[]> | undefined {
  const list = record(record(message)["payload"])["headers"]
  if (!Array.isArray(list)) return undefined
  const out = new Map<string, string[]>()
  for (const header of list) {
    const name = text(record(header)["name"])?.toLowerCase()
    const value = record(header)["value"]
    if (name && typeof value === "string") out.set(name, [...(out.get(name) ?? []), value])
  }
  return out
}

function setOf(values: readonly string[]): RecipientSet | undefined {
  const out = new Collector()
  out.text(values)
  return out.unknown ? undefined : { addresses: [...out.addresses], domains: [] }
}

type Spec = (request: Request, category: Category) => RecipientPlan

/** A plan from a collector and its lookups. */
function plan(out: Collector, lookups: RecipientLookup[] = [], needsSelf = false): RecipientPlan {
  return { known: out.result(), lookups, ...(needsSelf ? { needsSelf: true as const } : {}) }
}

/** The helper's own recipient flags; a send with none fails closed. A draft (a write) reaches no one. */
function helperSend(fields: readonly string[]): Spec {
  return (request, category) => {
    if (category !== "send") return plan(new Collector())
    const input = record(request.input)
    const out = new Collector()
    for (const field of fields) out.text(input[field])
    if (out.addresses.size === 0) out.fail("no recipient address was found")
    return plan(out)
  }
}

/** The message a reply answers: who it was from, and for reply-all who else it went to. */
function replySpec(all: boolean): Spec {
  return (request, category) => {
    if (category !== "send") return plan(new Collector())
    const input = record(request.input)
    const out = new Collector()
    for (const field of ["to", "cc", "bcc"]) out.text(input[field])
    const removed = new Set(addressesIn([input["remove"]].flat().filter((item) => typeof item === "string").join(",")).addresses)
    const messageId = text(input["messageId"])
    if (!messageId) {
      out.fail("the message being replied to is not named")
      return plan(out)
    }
    const lookup: RecipientLookup = {
      operation: "gmail.users.messages.get",
      params: { userId: "me", id: messageId, format: "metadata", fields: "payload/headers" },
      what: "the message being replied to",
      extract(data, self) {
        const found = headers(data)
        if (!found) return undefined
        const sender = found.get("reply-to") ?? found.get("from") ?? []
        const senderSet = setOf(sender)
        if (!senderSet) return undefined
        const values = [...sender]
        // A reply to one's own message goes to its recipients.
        if (all || (self !== undefined && senderSet.addresses.includes(self))) values.push(...(found.get("to") ?? []))
        if (all) values.push(...(found.get("cc") ?? []))
        const set = setOf(values)
        if (!set) return undefined
        // gws leaves the account itself and --remove out of a reply-all.
        const kept = all ? set.addresses.filter((address) => address !== self && !removed.has(address)) : set.addresses
        return { addresses: kept, domains: [] }
      },
    }
    return plan(out, [lookup], true)
  }
}

/** A raw RFC 2822 message's To, Cc and Bcc. */
function rawInto(out: Collector, raw: unknown): void {
  const values = mimeRecipients(raw)
  if (values) out.text(values)
  else out.fail("the raw message has no readable header block")
}

const messagesSend: Spec = (request) => {
  const out = new Collector()
  if (request.upload) out.fail("the message is in an uploaded file")
  else if (record(request.body)["raw"] === undefined) out.fail("the message has no raw field")
  else rawInto(out, record(request.body)["raw"])
  if (!out.unknown && out.addresses.size === 0) out.fail("the raw message has no To, Cc or Bcc header")
  return plan(out)
}

const draftsSend: Spec = (request) => {
  const out = new Collector()
  const body = record(request.body)
  const raw = record(body["message"])["raw"]
  if (raw !== undefined) rawInto(out, raw)
  const id = text(body["id"])
  if (!id) {
    out.fail("the draft is not named (body.id)")
    return plan(out)
  }
  const userId = text(record(request.params)["userId"]) ?? "me"
  const lookup: RecipientLookup = {
    operation: "gmail.users.drafts.get",
    params: { userId, id, format: "metadata", fields: "message/payload/headers" },
    what: "the draft",
    none: "the draft could not be read or names no recipient",
    extract(data) {
      const found = headers(record(data)["message"])
      return found ? setOf([...(found.get("to") ?? []), ...(found.get("cc") ?? []), ...(found.get("bcc") ?? [])]) : undefined
    },
  }
  return plan(out, [lookup])
}

/** Event guests in a request body. */
function attendeesInto(out: Collector, body: unknown): void {
  const attendees = record(body)["attendees"]
  if (attendees === undefined) return
  if (!Array.isArray(attendees)) {
    out.fail("the attendees could not be read")
    return
  }
  for (const attendee of attendees) {
    const email = record(attendee)["email"]
    if (typeof email === "string") out.text(email)
    else out.fail("an attendee has no email")
  }
}

const eventInsert: Spec = (request) => {
  const out = new Collector()
  attendeesInto(out, request.body)
  return plan(out)
}

/** An existing event: its stored guests are notified too, so a notifying change reads them. */
const eventChange: Spec = (request, category) => {
  const out = new Collector()
  attendeesInto(out, request.body)
  if (category !== "send") return plan(out)
  const params = record(request.params)
  const calendarId = text(params["calendarId"])
  const eventId = text(params["eventId"])
  if (!calendarId || !eventId) {
    out.fail("the event is not named (calendarId and eventId)")
    return plan(out)
  }
  const lookup: RecipientLookup = {
    operation: "calendar.events.get",
    params: { calendarId, eventId, fields: "attendees(email)" },
    what: "the event's guests",
    extract(data) {
      const attendees = record(data)["attendees"] ?? []
      if (!Array.isArray(attendees)) return undefined
      const emails = attendees.map((attendee) => record(attendee)["email"])
      return emails.every((email) => typeof email === "string") ? setOf(emails as string[]) : undefined
    },
  }
  return plan(out, [lookup])
}

const quickAdd: Spec = () => {
  const out = new Collector()
  out.fail("Google reads the guests from the text")
  return plan(out)
}

/** A Drive permission: a user or group address, a whole domain, or anyone (the public-sharing check). */
function drivePermissionInto(out: Collector, permission: Record<string, unknown>): void {
  const type = text(permission["type"])
  if (type === "anyone") return
  if (type === "domain") out.domain(permission["domain"])
  else if (typeof permission["emailAddress"] === "string") out.text(permission["emailAddress"])
  else out.fail("the permission names no emailAddress")
}

const drivePermissionCreate: Spec = (request) => {
  const out = new Collector()
  drivePermissionInto(out, record(request.body))
  return plan(out)
}

const drivePermissionUpdate: Spec = (request) => {
  const out = new Collector()
  const params = record(request.params)
  const fileId = text(params["fileId"])
  const permissionId = text(params["permissionId"])
  if (!fileId || !permissionId) {
    out.fail("the permission is not named (fileId and permissionId)")
    return plan(out)
  }
  const lookup: RecipientLookup = {
    operation: "drive.permissions.get",
    // The request's own parameters, so a shared-drive flag it carries applies to the read too.
    params: { ...params, fields: "type,emailAddress,domain" },
    what: "the permission",
    extract(data) {
      const found = new Collector()
      drivePermissionInto(found, record(data))
      return found.unknown ? undefined : found.result()
    },
  }
  return plan(out, [lookup])
}

/** A Calendar ACL scope: a user or group, a domain, or `default` (everyone, which is public). */
function aclScopeInto(out: Collector, type: string | undefined, value: unknown): void {
  if (type === "default") out.public = true
  else if (type === "domain") out.domain(value)
  else if ((type === "user" || type === "group") && typeof value === "string") out.text(value)
  else out.fail("the ACL scope could not be read")
}

const aclChange: Spec = (request) => {
  const out = new Collector()
  const scope = record(record(request.body)["scope"])
  if (Object.keys(scope).length > 0) aclScopeInto(out, text(scope["type"]), scope["value"])
  // A rule id is "<type>:<value>", or "default".
  const ruleId = text(record(request.params)["ruleId"])
  if (ruleId) {
    const colon = ruleId.indexOf(":")
    aclScopeInto(out, colon < 0 ? ruleId : ruleId.slice(0, colon), colon < 0 ? undefined : ruleId.slice(colon + 1))
  }
  if (Object.keys(scope).length === 0 && !ruleId) out.fail("the ACL scope could not be read")
  return plan(out)
}

/** A single address in a body field; anything else fails closed. */
function bodyAddress(field: string, optional?: (body: Record<string, unknown>) => boolean): Spec {
  return (request) => {
    const out = new Collector()
    const body = record(request.body)
    if (optional?.(body)) return plan(out)
    const value = body[field]
    if (typeof value === "string" && value.includes("@")) out.text(value)
    else out.fail(`body.${field} is not an email address`)
    return plan(out)
  }
}

const chatMember: Spec = (request) => {
  const out = new Collector()
  const name = text(record(record(request.body)["member"])["name"])
  if (name?.startsWith("users/") && name.includes("@")) out.text(name.slice("users/".length))
  else out.fail("the member is not named by email (users/<email>)")
  return plan(out)
}

const keepPermissions: Spec = (request) => {
  const out = new Collector()
  const requests = record(request.body)["requests"]
  if (!Array.isArray(requests) || requests.length === 0) out.fail("the permission requests could not be read")
  else {
    for (const item of requests) {
      const email = record(record(item)["permission"])["email"]
      if (typeof email === "string") out.text(email)
      else out.fail("a permission names no email")
    }
  }
  return plan(out)
}

/** A change that only removes someone's access reaches no one new. */
const revoke: Spec = () => plan(new Collector())

const SPECS: Readonly<Record<string, Spec>> = {
  "gmail.send": helperSend(["to", "cc", "bcc"]),
  "gmail.forward": helperSend(["to", "cc", "bcc"]),
  "gmail.reply": replySpec(false),
  "gmail.reply-all": replySpec(true),
  "gmail.users.messages.send": messagesSend,
  "gmail.users.drafts.send": draftsSend,
  "gmail.users.settings.delegates.create": bodyAddress("delegateEmail"),
  "gmail.users.settings.forwardingAddresses.create": bodyAddress("forwardingEmail"),
  "gmail.users.settings.updateAutoForwarding": bodyAddress("emailAddress", (body) => body["enabled"] === false),
  "gmail.users.settings.delegates.delete": revoke,
  "gmail.users.settings.forwardingAddresses.delete": revoke,
  "calendar.events.insert": eventInsert,
  "calendar.events.import": eventInsert,
  "calendar.events.quickAdd": quickAdd,
  "calendar.events.update": eventChange,
  "calendar.events.patch": eventChange,
  "calendar.events.delete": eventChange,
  "calendar.events.move": eventChange,
  "calendar.acl.insert": aclChange,
  "calendar.acl.update": aclChange,
  "calendar.acl.patch": aclChange,
  "calendar.acl.delete": revoke,
  "drive.permissions.create": drivePermissionCreate,
  "drive.permissions.update": drivePermissionUpdate,
  "drive.permissions.delete": revoke,
  "chat.spaces.members.create": chatMember,
  "chat.spaces.members.delete": revoke,
  "classroom.invitations.create": bodyAddress("userId"),
  "classroom.invitations.delete": revoke,
  "classroom.courses.studentGroups.studentGroupMembers.create": bodyAddress("userId"),
  "meet.spaces.members.create": bodyAddress("email"),
  "keep.notes.permissions.batchCreate": keepPermissions,
  "keep.notes.permissions.batchDelete": revoke,
}

/**
 * Where an operation's recipients are: what the request carries, and the
 * reads that find the rest. A send or share without an entry is unknown.
 */
export function recipientPlan(operation: string, category: Category, request: Request): RecipientPlan {
  const spec = SPECS[operation]
  if (spec) return spec(request, category)
  const scanned = scanRecipients(request)
  if (category === "send" || category === "share") {
    return { known: { ...scanned, unknown: scanned.unknown ?? `the plugin cannot tell who ${operation} reaches` }, lookups: [] }
  }
  return { known: scanned, lookups: [] }
}

/** Add a lookup's answer, or its failure, to recipients found so far. */
export function withLookup(recipients: Recipients, found: RecipientSet | undefined, lookup: Pick<RecipientLookup, "what" | "none">): Recipients {
  if (!found) return { ...recipients, unknown: recipients.unknown ?? `${lookup.what} could not be read` }
  const merged: Recipients = {
    ...recipients,
    addresses: [...new Set([...recipients.addresses, ...found.addresses])],
    domains: [...new Set([...recipients.domains, ...found.domains])],
  }
  if (lookup.none && merged.addresses.length === 0 && merged.domains.length === 0) merged.unknown ??= lookup.none
  return merged
}

/** How a preview names recipients: each address, and `*@domain` for a domain share. */
export function recipientLabels(recipients: RecipientSet): string[] {
  return [...recipients.addresses, ...recipients.domains.map((domain) => `*@${domain}`)]
}

/** Reads that give the account's own address, by service. */
export const ACCOUNT_ADDRESS_READS: Readonly<Record<string, { operation: string; params: Record<string, unknown>; extract(data: unknown): string | undefined }>> = {
  gmail: { operation: "gmail.users.getProfile", params: { userId: "me", fields: "emailAddress" }, extract: (data) => ownAddress(record(data)["emailAddress"]) },
  drive: { operation: "drive.about.get", params: { fields: "user(emailAddress)" }, extract: (data) => ownAddress(record(record(data)["user"])["emailAddress"]) },
  calendar: { operation: "calendar.calendars.get", params: { calendarId: "primary", fields: "id" }, extract: (data) => ownAddress(record(data)["id"]) },
}

function ownAddress(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const found = addressesIn(value)
  return found.addresses.length === 1 && found.unreadable.length === 0 ? found.addresses[0] : undefined
}
