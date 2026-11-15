import { readFileSync } from "node:fs"

/**
 * Jelly's copy of a person's plugin sign-in for an agent (D210), built by Jelly's rules as `fixtures/jelly-agent-copy.json`
 * records them: an OAuth grant's access token, the sentinel for its refresh token, a claimed day, and every metadata
 * key whose name (case, `_` and `-` ignored) is not a refused one and has no refused part.
 */

interface AgentCopyRules {
  readonly sentinel: string
  readonly ttlMs: number
  readonly refusedExact: readonly string[]
  readonly refusedPart: string
  readonly kept: readonly string[]
  readonly refused: readonly string[]
}

export const JELLY: AgentCopyRules = JSON.parse(readFileSync(new URL("../fixtures/jelly-agent-copy.json", import.meta.url), "utf8")) as AgentCopyRules

const refusedPart = new RegExp(JELLY.refusedPart, "u")

/** Whether one metadata key goes into an agent's copy (Jelly's `keepsMetadataKey`). */
export function keepsMetadataKey(key: string): boolean {
  const name = key.toLowerCase().replace(/[-_]/gu, "")
  return !JELLY.refusedExact.includes(name) && !refusedPart.test(name)
}

interface OAuthValue {
  readonly type: "oauth"
  readonly methodID: string
  readonly access: string
  readonly refresh: string
  readonly expires: number
  readonly metadata?: Readonly<Record<string, unknown>>
}

/** The agent's copy of a renewable OAuth sign-in (Jelly's `agentCopy`). */
export function agentCopy<T extends OAuthValue>(value: T, now = Date.now()): T & { metadata: Record<string, unknown> } {
  const metadata = Object.fromEntries(Object.entries(value.metadata ?? {}).filter(([key]) => keepsMetadataKey(key)))
  return { ...value, refresh: JELLY.sentinel, expires: now + JELLY.ttlMs, metadata }
}
