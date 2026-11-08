import { addressesIn } from "./recipients.js"

/**
 * Gmail messages as events_list lists them: which messages are noise, and
 * what one message says (its subject, people, labels and text) once quoted
 * replies, signatures and markup are gone. Pure: the host's events_list
 * (`src/host/gmail-events.ts`) reads the messages and turns these facts
 * into events.
 */

/** Messages that are not events: spam, trash, unsent drafts, and Gmail's Promotions and Social tabs. */
export const NOISE_LABELS: ReadonlySet<string> = new Set(["SPAM", "TRASH", "DRAFT", "CATEGORY_PROMOTIONS", "CATEGORY_SOCIAL"])

/** The same filter as Gmail search terms, for messages.list; spam and trash are left out unless includeSpamTrash is set. */
export const NOISE_QUERY = "-in:drafts -category:promotions -category:social"

/** The parts of a message events_list reads: ids, labels, time, snippet, headers and the text bodies, three parts deep. */
export const MESSAGE_FIELDS =
  "id,threadId,labelIds,snippet,internalDate,payload(mimeType,headers(name,value),body/data,parts(mimeType,body/data,parts(mimeType,body/data,parts(mimeType,body/data))))"

/** Gmail's system labels an event keeps, by their event names. Other labels, user labels included, are left out. */
const LABELS: Readonly<Record<string, string>> = {
  INBOX: "inbox",
  SENT: "sent",
  IMPORTANT: "important",
  STARRED: "starred",
  UNREAD: "unread",
  CATEGORY_PERSONAL: "personal",
  CATEGORY_UPDATES: "updates",
  CATEGORY_FORUMS: "forums",
}

/** The headers whose addresses become an event's people, with their roles. */
const PEOPLE = [
  ["from", "from"],
  ["to", "to"],
  ["cc", "cc"],
  ["bcc", "bcc"],
] as const

export interface MessagePart {
  mimeType?: string
  headers?: Array<{ name?: string; value?: string }>
  body?: { data?: string }
  parts?: MessagePart[]
}

/** A message as messages.get answers with MESSAGE_FIELDS. */
export interface GmailMessage {
  id?: string
  threadId?: string
  labelIds?: string[]
  snippet?: string
  internalDate?: string
  payload?: MessagePart
}

/** One person on a message: the header's role, the address in lower case, and the display name when there is one. */
export interface MessagePerson {
  role: string
  address: string
  name?: string
}

/** What events_list takes from one message. */
export interface MessageFacts {
  id: string
  threadId?: string
  /** Epoch milliseconds Gmail received the message. */
  time: number
  subject: string
  people: MessagePerson[]
  labels: string[]
  text: string
}

export function isNoise(labelIds: readonly string[] | undefined): boolean {
  return (labelIds ?? []).some((label) => NOISE_LABELS.has(label))
}

/** The facts of a message, or undefined when it has no id or no receive time. */
export function messageFacts(message: GmailMessage): MessageFacts | undefined {
  const time = Number(message.internalDate)
  if (typeof message.id !== "string" || message.id === "" || !Number.isSafeInteger(time) || time <= 0) return undefined
  const headers = message.payload?.headers ?? []
  const header = (name: string) => headers.find((entry) => entry.name?.toLowerCase() === name)?.value ?? ""
  const people = PEOPLE.flatMap(([name, role]) => addressList(header(name)).map((person) => ({ role, ...person })))
  return {
    id: message.id,
    ...(message.threadId ? { threadId: message.threadId } : {}),
    time,
    subject: header("subject"),
    people,
    labels: [...new Set((message.labelIds ?? []).flatMap((label) => LABELS[label] ?? []))],
    text: messageText(message),
  }
}

/** The message's own words: its plain text part, or its HTML part as text, without quoted replies or signature; else its snippet. */
export function messageText(message: GmailMessage): string {
  const plain = findPart(message.payload, "text/plain")
  const html = plain === undefined ? findPart(message.payload, "text/html") : undefined
  const body = plain !== undefined ? decodeBody(plain) : html !== undefined ? htmlText(decodeBody(html)) : ""
  const text = stripQuoted(body)
  return text || decodeEntities(message.snippet ?? "").trim()
}

/** The first part of `mimeType` with a body, depth first. */
function findPart(part: MessagePart | undefined, mimeType: string): string | undefined {
  if (!part) return undefined
  if (part.mimeType?.toLowerCase() === mimeType && typeof part.body?.data === "string" && part.body.data !== "") return part.body.data
  for (const child of part.parts ?? []) {
    const found = findPart(child, mimeType)
    if (found !== undefined) return found
  }
  return undefined
}

function decodeBody(data: string): string {
  return Buffer.from(data.replace(/\+/g, "-").replace(/\//g, "_"), "base64url").toString("utf8")
}

/** HTML as plain text: no head, style, script or quoted reply, a line break per block, no tags, entities decoded. */
export function htmlText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(head|style|script)\b[\s\S]*?<\/\1\s*>/gi, "")
      // Gmail's quoted reply runs to the end of the message.
      .replace(/<div[^>]*\bclass=["']?[^"'>]*\bgmail_quote\b[\s\S]*$/i, "")
      .replace(/<blockquote\b[\s\S]*?<\/blockquote\s*>/gi, "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(?:p|div|li|tr|h[1-6])\s*>/gi, "\n")
      .replace(/<[^>]*>/g, ""),
  )
}

/** HTML character references, `&amp;` last so nothing is decoded twice. */
export function decodeEntities(text: string): string {
  const NAMED: Readonly<Record<string, string>> = { nbsp: " ", lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'" }
  return text
    .replace(/&(nbsp|lt|gt|quot|apos|#39);/gi, (_match, name: string) => NAMED[name.toLowerCase()] ?? "")
    .replace(/&#(\d{1,7});/g, (match, code: string) => codePoint(Number(code)) ?? match)
    .replace(/&#x([0-9a-f]{1,6});/gi, (match, code: string) => codePoint(Number.parseInt(code, 16)) ?? match)
    .replace(/&amp;/gi, "&")
}

function codePoint(code: number): string | undefined {
  return code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff) ? String.fromCodePoint(code) : undefined
}

/**
 * Text without what the sender did not write now: quoted lines (`>`), a
 * quoted reply's header ("On … wrote:", Outlook's "From: … Sent: …" or
 * "Original Message") and everything after it, and the signature after a
 * `-- ` line or a "Sent from my …" line. A forwarded message stays.
 */
export function stripQuoted(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n")
  const kept: string[] = []
  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim()
    const next = (lines[index + 1] ?? "").trim()
    if (line === "-- " || line === "--") break
    if (/^(?:Sent from my |Get Outlook for )/i.test(trimmed)) break
    if (/^On\b/.test(trimmed) && (/\bwrote:$/i.test(trimmed) || /\bwrote:$/i.test(`${trimmed} ${next}`))) break
    if (/^-{2,}\s*Original Message\s*-{2,}$/i.test(trimmed)) break
    if (/^_{8,}$/.test(trimmed) && /^From:\s/i.test(next)) break
    if (/^From:\s/i.test(trimmed) && /^(?:Sent|Date):\s/i.test(next)) break
    if (trimmed.startsWith(">")) continue
    kept.push(line.trimEnd())
  }
  return kept.join("\n").replace(/\n{3,}/g, "\n\n").trim()
}

/** Each address in a header, with its display name when it has one. Addresses are found as gws's recipient rules find them. */
export function addressList(value: string): Array<{ address: string; name?: string }> {
  const people: Array<{ address: string; name?: string }> = []
  for (const item of splitAddresses(value)) {
    // An address that is also the display name, as in "a@example.com" <a@example.com>, counts once.
    const addresses = [...new Set(addressesIn(item).addresses)]
    const angle = item.indexOf("<")
    const name =
      addresses.length === 1 && angle > 0
        ? item
            .slice(0, angle)
            .trim()
            .replace(/^"([\s\S]*)"$/, "$1")
            .replace(/\\(.)/g, "$1")
            .trim()
        : ""
    for (const address of addresses) people.push(name && name.toLowerCase() !== address ? { address, name } : { address })
  }
  return people
}

/** A header's list items, split at commas and semicolons outside quotes and angle brackets. */
function splitAddresses(value: string): string[] {
  const items: string[] = []
  let current = ""
  let quoted = false
  let angle = 0
  for (const char of value) {
    if (char === '"') quoted = !quoted
    else if (!quoted && char === "<") angle++
    else if (!quoted && char === ">") angle = Math.max(0, angle - 1)
    if (!quoted && angle === 0 && (char === "," || char === ";")) {
      items.push(current)
      current = ""
      continue
    }
    current += char
  }
  items.push(current)
  return items.map((item) => item.trim()).filter((item) => item !== "")
}
