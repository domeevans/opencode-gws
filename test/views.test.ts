import { existsSync, readdirSync, readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { ASK_RULES } from "../src/host/agents.js"

/**
 * What Jelly reads from package.json, and the Gmail thread page it shows behind
 * gws_read. A page runs sealed with no network: it carries Jelly's bridge helper
 * (views/jelly-view.js, the text of @jelly/contracts VIEW_HELPER) inline, loads
 * nothing by URL, and draws only the data Jelly hands it.
 */

const root = new URL("../", import.meta.url)
const manifest = JSON.parse(readFileSync(new URL("package.json", root), "utf8")) as {
  files: string[]
  jelly: {
    tools: { name: string; permission: string; effect: string; readOnly: boolean }[]
    summary: string
    icon: string
    skills: string[]
    views: { place: string; tools?: string[]; page?: string; grants: string[] }[]
  }
}
const page = readFileSync(new URL("views/gmail-thread.html", root), "utf8")
const helper = readFileSync(new URL("views/jelly-view.js", root), "utf8").trimEnd()

type Thread = { subject: string; messages: { from: string; at: string; body: string }[]; truncated: boolean } | null
/** The page's own threadOf, run as the page runs it. */
const threadOf = new Function(`${/function threadOf[\s\S]*?\n}\n/.exec(page)![0]}; return threadOf`)() as (output: unknown) => Thread

const b64url = (text: string) => Buffer.from(text, "utf8").toString("base64url")
const message = (from: string, internalDate: string, extra: Record<string, unknown>) => ({
  internalDate,
  payload: { headers: [{ name: "Subject", value: "Launch plan" }, { name: "From", value: from }], ...extra },
})

describe("the Gmail thread view", () => {
  it("is declared behind gws_read, with only the data grant, in a file the package ships", () => {
    expect(manifest.jelly.views).toEqual([
      { v: 1, id: "gmail-thread", place: "tool-result", tools: ["gws_read"], title: "Gmail thread", page: "views/gmail-thread.html", grants: ["data"] },
    ])
    expect(manifest.files).toContain("views/gmail-thread.html")
    expect(existsSync(new URL("views/gmail-thread.html", root))).toBe(true)
  })

  it("carries Jelly's helper inline and loads nothing by URL", () => {
    expect(page).toContain(helper)
    expect(page).not.toMatch(/<script[^>]+src=|<link\b|\bfetch\(|\bimport\(|url\(|XMLHttpRequest|WebSocket|localStorage/)
    expect(page).not.toMatch(/innerHTML|insertAdjacentHTML|document\.write/)
  })

  it("draws a thread from threads.get: subject, sender, time, and the text part", () => {
    const thread = threadOf({
      ok: true,
      operation: "gmail.users.threads.get",
      data: {
        messages: [
          message("Ana <ana@example.com>", "1793606400000", { mimeType: "multipart/alternative", parts: [{ mimeType: "text/plain", body: { data: b64url("Ship Friday — ✓") } }, { mimeType: "text/html", body: { data: b64url("<b>x</b>") } }] }),
          { ...message("Ben <ben@example.com>", "1793610000000", {}), snippet: "Agreed." },
        ],
      },
    })
    expect(thread).toEqual({
      subject: "Launch plan",
      messages: [
        { from: "Ana <ana@example.com>", at: "2026-11-02T08:00:00.000Z", body: "Ship Friday — ✓" },
        { from: "Ben <ben@example.com>", at: "2026-11-02T09:00:00.000Z", body: "Agreed." },
      ],
      truncated: false,
    })
  })

  it("declines any other read, so the call keeps its ordinary look", () => {
    expect(threadOf({ ok: true, operation: "gmail.users.messages.list", data: { messages: [] } })).toBeNull()
    expect(threadOf({ ok: true, operation: "gmail.users.threads.get", data: {} })).toBeNull()
    expect(threadOf(null)).toBeNull()
  })
})

describe("the jelly declaration", () => {
  it("asks for every commit the plugin asks for, admin included, and lets the reads run", () => {
    const effect = new Map(manifest.jelly.tools.map((tool) => [tool.permission, tool.effect]))
    for (const rule of ASK_RULES) expect(effect.get(rule.action), rule.action).toBe("ask")
    for (const read of ["gws.status", "gws.catalog", "gws.schema", "gws.read", "gws.plan"]) expect(effect.get(read)).toBe("allow")
    expect(manifest.jelly.tools.filter((tool) => tool.readOnly).map((tool) => tool.permission).sort()).toEqual(
      ["gws.catalog", "gws.plan", "gws.read", "gws.schema", "gws.status"],
    )
  })

  it("names every skill the package ships", () => {
    expect([...manifest.jelly.skills].sort()).toEqual(readdirSync(new URL("skills", root)).sort())
  })

  it("has a one-line summary of at most 120 characters", () => {
    expect(manifest.jelly.summary.trim()).toBe(manifest.jelly.summary)
    expect(manifest.jelly.summary.length).toBeGreaterThan(0)
    expect(manifest.jelly.summary.length).toBeLessThanOrEqual(120)
    expect(manifest.jelly.summary).not.toMatch(/\n/)
  })

  it("ships a small icon of drawing elements only, with no title (Jelly's cleaner drops an icon with one)", () => {
    expect(manifest.jelly.icon).toBe("assets/icon.svg")
    expect(manifest.files).toContain(manifest.jelly.icon)
    const icon = readFileSync(new URL(manifest.jelly.icon, root), "utf8")
    expect(Buffer.byteLength(icon)).toBeLessThan(2048)
    expect(icon.trim()).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 (24 24|32 32)"[^>]*>[\s\S]*<\/svg>$/)
    const elements = [...icon.matchAll(/<([A-Za-z][A-Za-z0-9]*)/g)].map((match) => match[1])
    expect(elements.filter((name) => !["svg", "g", "path", "circle", "ellipse", "rect", "line", "polyline", "polygon"].includes(name!))).toEqual([])
    expect(icon).not.toMatch(/<title|<style|<script|href=|<!|&/i)
  })
})
