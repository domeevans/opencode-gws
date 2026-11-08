import { describe, expect, it } from "vitest"
import { addressList, decodeEntities, htmlText, isNoise, messageFacts, messageText, stripQuoted } from "../src/domain/gmail.js"

/**
 * What events_list takes from a Gmail message (src/domain/gmail.ts): the
 * noise filter, the people on it, and its own words without quoted
 * replies, signatures or markup. Every address is invented.
 */

const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64url")

describe("noise", () => {
  it("leaves out spam, trash, drafts, Promotions and Social, and nothing else", () => {
    for (const label of ["SPAM", "TRASH", "DRAFT", "CATEGORY_PROMOTIONS", "CATEGORY_SOCIAL"]) expect(isNoise(["INBOX", label]), label).toBe(true)
    expect(isNoise(["INBOX", "IMPORTANT", "CATEGORY_UPDATES", "SENT", "Label_12"])).toBe(false)
    expect(isNoise(undefined)).toBe(false)
  })
})

describe("people", () => {
  it("reads display names, quoted names with commas, bare addresses and groups", () => {
    expect(addressList('"Lee, Jordan" <Jordan.Lee@Example.org>, ama.mensah@example.com; Sam Rivera <sam.rivera@example.com>')).toEqual([
      { address: "jordan.lee@example.org", name: "Lee, Jordan" },
      { address: "ama.mensah@example.com" },
      { address: "sam.rivera@example.com", name: "Sam Rivera" },
    ])
    expect(addressList("Team: a@example.com, b@example.com;")).toEqual([{ address: "a@example.com" }, { address: "b@example.com" }])
    expect(addressList('"a@example.com" <a@example.com>')).toEqual([{ address: "a@example.com" }])
    expect(addressList("")).toEqual([])
  })
})

describe("text", () => {
  it("drops quoted lines, the quoted reply's header and what follows, and the signature", () => {
    expect(stripQuoted("Yes.\r\n\r\nOn Mon, Nov 2, 2026 at 9:00 AM Ama <ama@example.com> wrote:\r\n> Can you?\r\n")).toBe("Yes.")
    expect(stripQuoted("Yes.\n\nOn Mon, Nov 2, 2026 at 9:00 AM Ama Mensah\n<ama@example.com> wrote:\n> Can you?")).toBe("Yes.")
    expect(stripQuoted("Thanks,\nAma\n-- \nAma Mensah | Finance")).toBe("Thanks,\nAma")
    expect(stripQuoted("Done.\n\nSent from my phone")).toBe("Done.")
    expect(stripQuoted("Agreed.\n\n-----Original Message-----\nFrom: x")).toBe("Agreed.")
    expect(stripQuoted("Agreed.\n\nFrom: Ama Mensah\nSent: Monday\nTo: Sam")).toBe("Agreed.")
    expect(stripQuoted("Agreed.\n________________\nFrom: Ama Mensah")).toBe("Agreed.")
    expect(stripQuoted("See below.\n> quoted\nMy answer.\n\n\n\nEnd")).toBe("See below.\nMy answer.\n\nEnd")
    // A forward is the message's point, so it stays.
    expect(stripQuoted("FYI\n\n---------- Forwarded message ---------\nFrom: x")).toContain("Forwarded message")
  })

  it("turns HTML into text without head, style, Gmail's quote or tags", () => {
    expect(htmlText('<html><head><style>p{}</style></head><body><p>Build <b>passed</b> &amp; shipped.</p><div>4&nbsp;min</div><div class="gmail_quote">On Sat x wrote:</div></body></html>')).toBe(
      "Build passed & shipped.\n4 min\n",
    )
    expect(htmlText("a<br>b<blockquote>old</blockquote>c")).toBe("a\nbc")
    expect(decodeEntities("&lt;tag&gt; &#39;q&#39; &#x263A; &amp;amp; &#0;")).toBe("<tag> 'q' ☺ &amp; &#0;")
  })

  it("prefers the plain part, then the HTML part, then the snippet", () => {
    const plain = { mimeType: "text/plain", body: { data: b64("Plain words") } }
    const html = { mimeType: "text/html", body: { data: b64("<p>HTML words</p>") } }
    expect(messageText({ payload: { mimeType: "multipart/alternative", parts: [html, plain] } })).toBe("Plain words")
    expect(messageText({ payload: { mimeType: "multipart/mixed", parts: [{ mimeType: "multipart/alternative", parts: [html] }] } })).toBe("HTML words")
    expect(messageText({ snippet: "Free on Thursday? I&#39;ll book.", payload: { mimeType: "multipart/mixed", parts: [] } })).toBe("Free on Thursday? I'll book.")
  })
})

describe("facts", () => {
  it("takes a message's id, thread, time, subject, people, system labels and text", () => {
    const facts = messageFacts({
      id: "m1",
      threadId: "t1",
      internalDate: "1793523600000",
      labelIds: ["INBOX", "IMPORTANT", "Label_7", "CATEGORY_UPDATES"],
      payload: {
        mimeType: "text/plain",
        headers: [
          { name: "FROM", value: "Ama <ama@example.com>" },
          { name: "To", value: "sam@example.com" },
          { name: "Cc", value: "" },
          { name: "Subject", value: "Q4" },
        ],
        body: { data: b64("Numbers by Friday?") },
      },
    })
    expect(facts).toEqual({
      id: "m1",
      threadId: "t1",
      time: 1793523600000,
      subject: "Q4",
      people: [
        { role: "from", address: "ama@example.com", name: "Ama" },
        { role: "to", address: "sam@example.com" },
      ],
      labels: ["inbox", "important", "updates"],
      text: "Numbers by Friday?",
    })
    expect(messageFacts({ internalDate: "1" })).toBeUndefined()
    expect(messageFacts({ id: "m1", internalDate: "soon" })).toBeUndefined()
  })
})
