import type { Plugin } from "@opencode/plugin/tui"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { GwsAccount, GwsStatus } from "../src/rpc.js"

/**
 * The TUI part against a narrow fake of its context. The mocked JSX runtime
 * calls components and records host elements, so each render is a plain
 * tree of what the part would draw at that moment, without OpenTUI.
 * test/tui-renderer.mjs renders the compiled part with OpenTUI itself.
 */

interface Node {
  readonly type: string
  readonly props: Record<string, unknown>
}

vi.mock("@opentui/core", () => ({ TextAttributes: { BOLD: 1 } }))
const runtime = vi.hoisted(() => {
  const jsx = (type: unknown, props: Record<string, unknown>) =>
    typeof type === "function" ? (type as (props: unknown) => unknown)(props) : { type, props }
  return { jsx, jsxs: jsx, jsxDEV: jsx, Fragment: (props: { children?: unknown }) => props.children }
})
vi.mock("@opentui/solid/jsx-runtime", () => runtime)
vi.mock("@opentui/solid/jsx-dev-runtime", () => runtime)

const { default: plugin } = await import("../src/tui.js")

type Context = Plugin.Context
type Layer = ReturnType<Parameters<Context["keymap"]["layer"]>[0]>
type Command = NonNullable<Layer["commands"]>[number]
type Location = NonNullable<Context["location"]>

/** The theme colours the part reads; the fake uses names, so a test can tell the tones apart. */
type Theme = {
  readonly text: { readonly base: string; readonly muted: string; readonly feedback: Record<"success" | "warning" | "error", { readonly base: string }> }
  readonly surface: (name: "dialog") => Theme
}

/** Only what the TUI part touches. */
type FakeContext = Pick<Context, "location"> & {
  readonly theme: Theme
  readonly client: Pick<Context["client"], "rpc">
  readonly data: Pick<Context["data"], "on"> & { readonly location: Pick<Context["data"]["location"], "default"> }
  readonly keymap: Pick<Context["keymap"], "layer">
  readonly ui: {
    readonly dialog: Pick<Context["ui"]["dialog"], "show" | "set" | "clear">
  }
}

interface Call {
  readonly rpcID: string
  readonly input: unknown
  readonly options: { readonly location?: unknown; readonly signal?: AbortSignal }
  readonly resolve: (output: GwsStatus) => void
  readonly reject: (error: unknown) => void
}

const LOCATION = { directory: "/work/project" } as Location
const DEFAULT_LOCATION = { directory: "/work/default" } as Location
const SERVICES = ["gmail", "drive", "calendar", "docs", "sheets"]
const G = (scope: string) => `https://www.googleapis.com/auth/${scope}`
const READ = ["gmail.readonly", "drive.readonly", "calendar.readonly", "documents.readonly", "spreadsheets.readonly"].map(G)
const IDENTITY = ["openid", G("userinfo.email"), G("userinfo.profile")]
const CONNECT = "run /connect and choose Google Workspace, or run opencode auth login gws-default"
const UNAVAILABLE = "STATUS_UNAVAILABLE: Google Workspace status could not be read. Next step: Run /gws-status in a session for the details."
const STATUS = "google-workspace.gws.status"
const EVENTS = ["agent.updated", "credential.switched", "credential.updated", "integration.updated", "server.connected"]

const interactive = { alias: "default", mode: "interactive", services: SERVICES, integrationID: "gws-default" } as const
const ACCOUNTS = {
  signedOut: { ...interactive, connected: false, access: "read", clientSource: "plugin", nextStep: `Sign in: ${CONNECT}` },
  noClient: { ...interactive, connected: false, access: "read", nextStep: `Create a Desktop app OAuth client (/gws-status lists the steps), then sign in: ${CONNECT}, and paste its JSON` },
  signedIn: { ...interactive, connected: true, access: "read", clientSource: "pasted", grantedScopes: [...READ, ...IDENTITY], missingScopes: [] },
  missingScope: {
    ...interactive,
    connected: true,
    access: "read",
    clientSource: "pasted",
    grantedScopes: [...READ.filter((scope) => scope !== G("drive.readonly")), ...IDENTITY],
    missingScopes: [G("drive.readonly")],
    nextStep: `Sign in again with ${CONNECT}, and approve every scope Google lists`,
  },
  expired: { ...interactive, connected: false, needsAuth: true, access: "write", clientSource: "account", nextStep: `Sign in again: ${CONNECT}` },
  headless: { alias: "ci", mode: "credentials_file", services: ["drive"], connected: false },
} satisfies Record<string, GwsAccount>

function status(accounts: readonly GwsAccount[], extra: Partial<GwsStatus> = {}): GwsStatus {
  return { version: "1.2.3", host: { version: "2.2.3", range: ">=2.2.3 <2.3.0", tested: true }, state: "connected", nextStep: "Nothing to do.", gws: { path: "/fixture/gws", version: "gws 0.22.5" }, services: SERVICES, accounts: [...accounts], auditDegraded: false, unguardedAgents: [], ...extra }
}

function fake({ location }: { readonly location: Location | undefined } = { location: LOCATION }) {
  const calls: Call[] = []
  const handlers = new Map<string, Set<(event: unknown) => void>>()
  const layers: Layer[] = []
  const dialog = {
    open: undefined as { readonly render: () => unknown; readonly onClose?: () => void } | undefined,
    size: undefined as string | undefined,
    cleared: 0,
  }
  const tone = (name: string) => ({ base: name })
  const theme: Theme = {
    text: { base: "base", muted: "muted", feedback: { success: tone("success"), warning: tone("warning"), error: tone("error") } },
    surface: () => theme,
  }
  // OpenCode calls a dialog's onClose when it is cleared or replaced.
  const close = () => {
    const current = dialog.open
    dialog.open = undefined
    current?.onClose?.()
  }

  const context: FakeContext = {
    location,
    theme,
    // The real client rejects with the fetch AbortError when the signal aborts.
    client: {
      rpc: ((definition: { readonly id: string }) => ({
        status: (input: unknown, options: Call["options"] = {}) =>
          new Promise<GwsStatus>((resolve, reject) => {
            options.signal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")))
            calls.push({ rpcID: definition.id, input, options, resolve, reject })
          }),
      })) as unknown as Context["client"]["rpc"],
    },
    data: {
      on: ((type: string, handler: (event: unknown) => void) => {
        const set = handlers.get(type) ?? new Set()
        handlers.set(type, set)
        set.add(handler)
        return () => void set.delete(handler)
      }) as Context["data"]["on"],
      location: { default: () => DEFAULT_LOCATION },
    },
    keymap: { layer: (factory) => void layers.push(factory()) },
    ui: {
      dialog: {
        show: (render, onClose) => {
          close()
          dialog.open = { render, ...(onClose ? { onClose } : {}) }
        },
        set: (options) => {
          dialog.size = options.size
        },
        clear: () => {
          dialog.cleared++
          close()
        },
      },
    },
  }

  const command = (key: string): Command => {
    const found = layers.flatMap((layer) => layer.commands ?? []).findLast((entry) => entry.id === key || entry.bind === key)
    if (!found) throw new Error(`no command ${key}`)
    return found
  }
  return {
    context,
    calls,
    layers,
    dialog,
    command,
    /** Event types with at least one listener. */
    subscribed: () => [...handlers].filter(([, set]) => set.size > 0).map(([type]) => type),
    emit: (type: string) => {
      for (const handler of handlers.get(type) ?? []) handler({ type, data: {} })
    },
    /** The text of the open dialog, rendered now. */
    view: () => {
      if (!dialog.open) throw new Error("no dialog is open")
      return texts(dialog.open.render()).join("\n")
    },
  }
}

function texts(node: unknown): string[] {
  if (node === null || node === undefined || node === false || node === "") return []
  if (typeof node === "string" || typeof node === "number") return [String(node)]
  if (Array.isArray(node)) return node.flatMap(texts)
  if (typeof node === "function") return texts((node as () => unknown)())
  return texts((node as Node).props["children"])
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

async function start(options?: { readonly location: Location | undefined }) {
  const harness = fake(options)
  const cleanup = (await plugin.setup(harness.context as unknown as Context)) as () => void
  cleanups.push(cleanup)
  return { ...harness, cleanup }
}

/** Answers the newest status call. */
async function answer(harness: Awaited<ReturnType<typeof start>>, outcome: GwsStatus | Error) {
  const call = harness.calls.at(-1)
  if (!call) throw new Error("no status call")
  if (outcome instanceof Error) call.reject(outcome)
  else call.resolve(outcome)
  await settle()
}

/** Opens the dialog through its palette command, answers its status call, and renders it once, as the host does. */
async function open(outcome: GwsStatus | Error) {
  const harness = await start()
  await harness.command(STATUS).run()
  await answer(harness, outcome)
  harness.view()
  return harness
}

describe("TUI part setup", () => {
  it("registers one palette command with the /gws alias, claims no slot, and fetches nothing yet", async () => {
    const h = await start()
    expect(plugin.id).toBe("google-workspace.gws.tui")
    expect(h.layers).toHaveLength(1)
    expect(h.layers[0]?.mode).toBe("global")
    expect(h.layers[0]?.commands?.map(({ id, title, group, palette, slash }) => ({ id, title, group, palette, slash }))).toEqual([
      { id: STATUS, title: "Google Workspace: Status", group: "Google Workspace", palette: true, slash: { name: "gws" } },
    ])
    expect(h.subscribed()).toEqual([])
    expect(h.calls).toHaveLength(0)
  })

  it("asks at the part's location, or the default location when it has none", async () => {
    const h = await start()
    await h.command(STATUS).run()
    expect(h.calls[0]).toMatchObject({ rpcID: "google-workspace.gws", input: {}, options: { location: LOCATION } })
    expect(h.calls[0]?.options.signal).toBeInstanceOf(AbortSignal)
    const other = await start({ location: undefined })
    await other.command(STATUS).run()
    expect(other.calls[0]?.options.location).toEqual(DEFAULT_LOCATION)
  })
})

describe("status dialog", () => {
  it("opens large, shows loading, then the rows in the shared order with one Next step", async () => {
    const h = await start()
    await h.command(STATUS).run()
    expect(h.dialog.size).toBe("large")
    expect(h.view()).toContain("Google Workspace: Status\nLoading…")
    expect(h.view()).toContain("r refresh · esc close")
    await answer(h, status([ACCOUNTS.signedOut], { nextStep: `Sign in: ${CONNECT}` }))
    const view = h.view()
    expect(view).toContain(
      [
        "Connection\nsign-in required",
        "Account\ndefault (OpenCode sign-in)",
        "Access\nread-only",
        "Client\nfrom the plugin's oauthClient option",
        "Services\ngmail, drive, calendar, docs, sheets",
        "Tools\ngws tools for gmail, drive, calendar, docs, sheets (gws 0.22.5)",
        "Agents without default rules\nnone",
        "OpenCode\n2.2.3 (tested)",
        `Next step\nSign in: ${CONNECT}`,
      ].join("\n"),
    )
    expect(view.match(/Next step/g)).toHaveLength(1)
    expect(view).not.toContain("Loading")
    expect(view).not.toContain("Granted")
  })

  it("shows a connected read-only account with its client and granted scopes, and Nothing to do.", async () => {
    const view = (await open(status([ACCOUNTS.signedIn]))).view()
    expect(view).toContain("Connection\nconnected\nAccount\ndefault (OpenCode sign-in)\nAccess\nread-only\nClient\nentered at sign-in")
    expect(view).toContain("Granted scopes\ngmail.readonly, drive.readonly, calendar.readonly, documents.readonly, spreadsheets.readonly, openid, userinfo.email, userinfo.profile")
    expect(view).not.toContain("Scopes not granted")
    expect(view).toContain("Next step\nNothing to do.")
  })

  it("shows the scopes Google did not grant", async () => {
    const view = (await open(status([ACCOUNTS.missingScope]))).view()
    expect(view).toContain("Scopes not granted\ndrive.readonly")
  })

  it("shows the services that need domain-wide delegation", async () => {
    const view = (await open(status([{ ...ACCOUNTS.signedIn, alias: "notes", services: ["keep"], delegationRequired: ["keep"] }]))).view()
    expect(view).toContain("Needs domain-wide delegation\nkeep (a Workspace admin sets it up; then add the scopes to accounts.notes.scopes)")
    expect((await open(status([ACCOUNTS.signedIn]))).view()).not.toContain("delegation")
  })

  it("shows an account without a client, an expired write sign-in, and headless accounts", async () => {
    const view = (await open(status([{ ...ACCOUNTS.noClient, alias: "work" }, { ...ACCOUNTS.expired, alias: "admin" }, ACCOUNTS.headless, { ...ACCOUNTS.headless, alias: "ops", connected: true }]))).view()
    expect(view).toContain("Connection\nsign-in required\nAccount\nwork (OpenCode sign-in)\nAccess\nread-only\nClient\nnone yet")
    expect(view).toContain("Connection\nsign-in required\nAccount\nadmin (OpenCode sign-in)\nAccess\nread and write\nClient\nfrom accounts.admin.oauthClient")
    expect(view).toContain("Connection\nnot configured\nAccount\nci (credentials file)\nServices\ndrive")
    expect(view).toContain("Connection\nconnected\nAccount\nops (credentials file)\nServices\ndrive")
  })

  it("names the agents without default rules and shows the block to add first in their own permissions", async () => {
    const block = '{\n  "agents": {}\n}'
    const view = (await open(status([ACCOUNTS.signedIn], { unguardedAgents: ["notes", "docs"], permissionsBlock: block }))).view()
    expect(view).toContain(`Agents without default rules\nnotes, docs\n${block}\nPut this block first in that agent's own permissions, followed by your top-level rules for gws actions.`)
  })

  it("says when no account is configured", async () => {
    expect((await open(status([]))).view()).toContain("Connection\nnot configured")
  })

  it("shows an untested host in the OpenCode row, and degraded audit", async () => {
    const view = (await open(status([ACCOUNTS.signedIn], { host: { version: "2.3.0", range: ">=2.2.3 <2.3.0", tested: false }, auditDegraded: true }))).view()
    expect(view).toContain("OpenCode\n2.3.0 (host untested; supported range >=2.2.3 <2.3.0)")
    expect(view).toContain("Audit\nsome records could not be saved, so the audit log may be incomplete")
  })

  it("keeps error details out when the status call fails", async () => {
    const h = await open(new Error("PROXY-SECRET-DETAIL at /internal/path"))
    expect(h.view()).toContain(UNAVAILABLE)
    expect(h.view()).not.toContain("PROXY-SECRET-DETAIL")
  })

  it("refreshes on r, keeps the last status while refreshing, and closes on Esc", async () => {
    const h = await open(status([ACCOUNTS.signedOut]))
    await h.command("r").run()
    expect(h.calls).toHaveLength(2)
    expect(h.view()).toContain("refreshing…")
    expect(h.view()).toContain("sign-in required")
    await answer(h, status([ACCOUNTS.signedIn]))
    expect(h.view()).not.toContain("refreshing…")
    expect(h.view()).toContain("Connection\nconnected")
    await h.command("escape").run()
    expect(h.dialog.open).toBeUndefined()
    expect(h.dialog.cleared).toBe(1)
  })
})

describe("refresh", () => {
  it.each(EVENTS)("%s asks for status again while the dialog is open", async (type) => {
    const h = await open(status([ACCOUNTS.signedOut]))
    h.emit(type)
    expect(h.calls).toHaveLength(2)
    expect(h.calls[1]).toMatchObject({ input: {}, options: { location: LOCATION } })
    await answer(h, status([ACCOUNTS.signedIn]))
    expect(h.view()).toContain("Connection\nconnected")
  })

  it("subscribes only while the dialog is open, and cancels the pending call when it closes", async () => {
    const h = await start()
    h.emit("credential.updated")
    expect(h.calls).toHaveLength(0)
    await h.command(STATUS).run()
    expect(h.subscribed().sort()).toEqual(EVENTS)
    h.view()
    await h.command("escape").run()
    expect(h.subscribed()).toEqual([])
    expect(h.calls[0]?.options.signal?.aborted).toBe(true)
    h.emit("credential.updated")
    expect(h.calls).toHaveLength(1)
  })

  it("lets only the newest request update the dialog", async () => {
    const h = await start()
    await h.command(STATUS).run()
    h.emit("credential.updated")
    expect(h.calls.map((call) => call.options.signal?.aborted)).toEqual([true, false])
    await answer(h, status([ACCOUNTS.signedIn]))
    h.calls[0]?.resolve(status([ACCOUNTS.signedOut]))
    await settle()
    expect(h.view()).toContain("Connection\nconnected")
  })
})

describe("cleanup", () => {
  it("stops listening, cancels the pending call, closes the dialog, and ignores late answers", async () => {
    const h = await open(status([ACCOUNTS.signedIn]))
    await h.command("r").run()
    const pending = h.calls.at(-1)
    h.cleanup()
    expect(h.subscribed()).toEqual([])
    expect(pending?.options.signal?.aborted).toBe(true)
    expect(h.dialog.open).toBeUndefined()
    expect(h.dialog.cleared).toBe(1)
    pending?.resolve(status([ACCOUNTS.signedOut]))
    await settle()
    await h.command(STATUS).run()
    expect(h.dialog.open).toBeUndefined()
    expect(h.calls).toHaveLength(2)
    h.cleanup()
    expect(h.dialog.cleared).toBe(1)
  })

  it("does not clear a dialog that was already closed", async () => {
    const h = await open(status([ACCOUNTS.signedIn]))
    await h.command("escape").run()
    h.cleanup()
    expect(h.dialog.cleared).toBe(1)
  })
})
