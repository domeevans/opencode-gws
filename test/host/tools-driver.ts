import { expect } from "vitest"
import { ALL_SCOPES, storedSignIn } from "../support/config.js"
import { ACCOUNT, startHost, type Harness } from "./harness.js"

/**
 * Driver shared by the host tool files.
 *
 * The embedded SDK binds global paths once per process. Each describe that
 * starts a host lives in its own file, so vitest (isolate on, one file at a
 * time) runs that host in its own worker. Merging them back into one file
 * makes the second host see the first host's paths.tmp, and assertIsolated
 * fails. Do not weaken that assertion to paper over a shared process.
 */

export const COMMITS = ["write", "send", "share", "delete", "export", "admin"] as const
export type Commit = (typeof COMMITS)[number]

/** A session and the helpers that drive it through the scripted model. */
export interface Driver {
  host: Harness
  sessionID: string
}

interface Turned {
  /** The text the model received from the tool call. */
  result: string
  /** Model requests the turn made: 1 when the step ended at the tool call. */
  requests: number
  /** Permission prompts the turn raised, in order. */
  asked: Array<{ action: string; id: string }>
}

export async function driver(options: Parameters<typeof startHost>[0] = {}): Promise<Driver> {
  const host = await startHost({
    // Commits ask, as the default rules make them do for every agent.
    permissions: COMMITS.map((category) => ({ action: `gws.${category}`, resource: "*", effect: "ask" as const })),
    ...options,
  })
  await host.opencode.credential.create({ integrationID: `gws-${ACCOUNT}`, value: storedSignIn("write", ALL_SCOPES) as never, activate: true })
  const sessionID = (await host.opencode.sessions.create({ location: host.location })).id
  return { host, sessionID }
}

/**
 * One scripted model turn. Every permission prompt it raises is answered
 * with `decide` (default: approve once) until the session is idle again.
 */
export async function turn(d: Driver, step: { code: string } | { tool: string; input: unknown }, decide: (action: string) => "once" | "reject" = () => "once"): Promise<Turned> {
  const { host, sessionID } = d
  const seen = new Set(host.events.filter((event) => event.type === "permission.asked").map((event) => event.data?.id))
  const requests = host.model.requests.length
  host.model.script(step)
  await host.opencode.sessions.prompt({ sessionID, text: "go" })
  const asked: Turned["asked"] = []
  let settled = false
  const idle = host.opencode.sessions.wait({ sessionID }).then(() => {
    settled = true
  })
  while (!settled) {
    const ask = host
      .waitForEvent((event) => event.type === "permission.asked" && event.data?.sessionID === sessionID && !seen.has(event.data?.id), 60_000)
      .catch(() => undefined)
    const next = await Promise.race([idle.then(() => undefined), ask])
    if (!next) break
    const id = next.data!.id as string
    const action = next.data!.action as string
    seen.add(id)
    asked.push({ action, id })
    await host.opencode.permission.reply({ sessionID, requestID: id, decision: decide(action) })
  }
  await idle
  return { result: host.model.lastToolResult() ?? "", requests: host.model.requests.length - requests, asked }
}

/** Code Mode snippet: await one gws call and return `{ value }`, or `{ error }` with what the program caught. */
export const call = (name: string, input: unknown) =>
  `try { return { value: await tools.gws.${name}(${JSON.stringify(input)}) } } catch (e) { return { error: { message: String(e?.message ?? e), name: e?.name, metadata: e?.metadata } } }`

export async function codeMode(d: Driver, code: string): Promise<Record<string, unknown>> {
  return JSON.parse((await turn(d, { code })).result) as Record<string, unknown>
}

export async function plan(d: Driver, input: unknown): Promise<Record<string, unknown>> {
  const planned = await codeMode(d, call("plan", input))
  expect(planned["error"], JSON.stringify(planned["error"])).toBeUndefined()
  return planned["value"] as Record<string, unknown>
}

export const commits = (host: Harness) => host.invocations().filter((argv) => !argv.includes("--dry-run"))
