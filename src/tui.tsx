import type { Plugin } from "@opencode/plugin/tui"
import { type RGBA, TextAttributes } from "@opentui/core"
import { For, Show, createSignal } from "solid-js"
import { BLOCK_PLACEMENT, Gws, NOTHING_TO_DO, connectionLabel, isStatus, openCodeLabel, type GwsAccount, type GwsStatus } from "./rpc.js"

/**
 * The TUI part: one palette command, "Google Workspace: Status" (slash
 * alias /gws), that opens one dialog rendering the plugin's status model:
 * each account's sign-in and access, the model-facing services, agents
 * that missed the ask rules with the block to add, the host check, and
 * one next step. It reads the plugin's one RPC method, `status`; nothing
 * here can approve or commit a plan. scripts/bundle.mjs compiles this
 * file and bundles it, with the contract, into dist/tui.js, so no .tsx runs
 * from node_modules.
 *
 * Nothing is fetched until the dialog opens. While it is open, the status
 * is fetched again on `r`, on server reconnect, and on every integration,
 * credential or agent event. Only the newest request may update it.
 */

type Tone = "success" | "warning" | "error"

type View = { readonly state: "loading" } | { readonly state: "ready"; readonly status: GwsStatus } | { readonly state: "failed" }

/** The colours the dialog uses, from the surface it renders on. */
type Colors = {
  readonly text: {
    readonly base: RGBA
    readonly muted: RGBA
    readonly feedback: Readonly<Record<Tone, { readonly base: RGBA }>>
  }
}

const TITLE = "Google Workspace: Status"

/** Shown for every failure. Error details stay out of the dialog; /gws-status reports them in a session. */
const UNAVAILABLE = "STATUS_UNAVAILABLE: Google Workspace status could not be read. Next step: Run /gws-status in a session for the details."

const SCOPE_PREFIX = "https://www.googleapis.com/auth/"

const REFRESH_EVENTS = ["server.connected", "integration.updated", "credential.updated", "credential.switched", "agent.updated"] as const

function connectionTone(account: GwsAccount): Tone {
  return account.connected ? "success" : "warning"
}

function accountLabel(account: GwsAccount): string {
  const credential = account.mode === "credentials_file" ? "credentials file" : account.mode === "access_token" ? "access token" : "OpenCode sign-in"
  return `${account.alias} (${credential})`
}

function accessLabel(access: GwsAccount["access"]): string | undefined {
  if (access === "read") return "read-only"
  if (access === "write") return "read and write"
  return undefined
}

function clientLabel(account: GwsAccount): string | undefined {
  if (account.mode !== "interactive") return undefined
  switch (account.clientSource) {
    case "account":
      return `from accounts.${account.alias}.oauthClient`
    case "plugin":
      return "from the plugin's oauthClient option"
    case "pasted":
      return "entered at sign-in"
    default:
      return "none yet"
  }
}

function scopeList(scopes: readonly string[]): string {
  return scopes.map((scope) => (scope.startsWith(SCOPE_PREFIX) ? scope.slice(SCOPE_PREFIX.length) : scope)).join(", ")
}

function Row(props: { readonly label: string; readonly value: string; readonly fg: RGBA; readonly muted: RGBA }) {
  return (
    <box flexDirection="row" gap={1}>
      <text fg={props.muted} width={29} flexShrink={0}>
        {props.label}
      </text>
      <text fg={props.fg} flexGrow={1} wrapMode="word">
        {props.value}
      </text>
    </box>
  )
}

function AccountStatus(props: { readonly account: GwsAccount; readonly colors: Colors }) {
  const base = () => props.colors.text.base
  const muted = () => props.colors.text.muted
  const tone = (value: Tone) => props.colors.text.feedback[value].base
  return (
    <box flexDirection="column">
      <Row label="Connection" value={connectionLabel(props.account)} fg={tone(connectionTone(props.account))} muted={muted()} />
      <Row label="Account" value={accountLabel(props.account)} fg={base()} muted={muted()} />
      <Show when={props.account.mode === "interactive" ? accessLabel(props.account.access) : undefined}>{(access) => <Row label="Access" value={access()} fg={base()} muted={muted()} />}</Show>
      <Show when={clientLabel(props.account)}>{(client) => <Row label="Client" value={client()} fg={base()} muted={muted()} />}</Show>
      <Row label="Services" value={props.account.services.join(", ") || "none"} fg={base()} muted={muted()} />
      <Show when={props.account.grantedScopes?.length ? props.account.grantedScopes : undefined}>
        {(scopes) => <Row label="Granted scopes" value={scopeList(scopes())} fg={base()} muted={muted()} />}
      </Show>
      <Show when={props.account.missingScopes?.length ? props.account.missingScopes : undefined}>
        {(scopes) => <Row label="Scopes not granted" value={scopeList(scopes())} fg={tone("warning")} muted={muted()} />}
      </Show>
    </box>
  )
}

function StatusBody(props: { readonly status: GwsStatus; readonly colors: Colors }) {
  const base = () => props.colors.text.base
  const muted = () => props.colors.text.muted
  const tone = (value: Tone) => props.colors.text.feedback[value].base
  return (
    <box flexDirection="column" gap={1}>
      <Show
        when={props.status.accounts.length > 0}
        fallback={<Row label="Connection" value="not configured" fg={tone("warning")} muted={muted()} />}
      >
        <For each={props.status.accounts}>{(account) => <AccountStatus account={account} colors={props.colors} />}</For>
      </Show>
      <box flexDirection="column">
        <Row label="Tools" value={`gws tools for ${props.status.services.join(", ") || "no services"} (${props.status.gws.version})`} fg={base()} muted={muted()} />
        <Show
          when={props.status.unguardedAgents.length > 0 ? props.status.unguardedAgents : undefined}
          fallback={<Row label="Agents without default rules" value="none" fg={base()} muted={muted()} />}
        >
          {(agents) => (
            <box flexDirection="column">
              <Row label="Agents without default rules" value={agents().join(", ")} fg={tone("warning")} muted={muted()} />
              <text fg={base()}>{props.status.permissionsBlock ?? ""}</text>
              <text fg={muted()} wrapMode="word">
                {BLOCK_PLACEMENT}
              </text>
            </box>
          )}
        </Show>
        <Show when={props.status.auditDegraded}>
          <Row label="Audit" value="some records could not be saved, so the audit log may be incomplete" fg={tone("warning")} muted={muted()} />
        </Show>
        <Row label="OpenCode" value={openCodeLabel(props.status)} fg={tone(props.status.hostWarning ? "warning" : "success")} muted={muted()} />
        <Row label="Next step" value={props.status.nextStep ?? NOTHING_TO_DO} fg={base()} muted={muted()} />
      </box>
    </box>
  )
}

function Dialog(props: { readonly context: Plugin.Context; readonly view: View; readonly refreshing: boolean; readonly refresh: () => void }) {
  // Created inside the dialog, so OpenCode removes these keys when the dialog closes.
  props.context.keymap.layer(() => ({
    mode: "modal",
    commands: [
      { title: "Refresh Google Workspace status", group: "Google Workspace", bind: "r", run: () => props.refresh() },
      { title: "Close Google Workspace status", group: "Google Workspace", bind: "escape", run: () => props.context.ui.dialog.clear() },
    ],
  }))
  const colors = (): Colors => props.context.theme.surface("dialog")
  return (
    <box flexDirection="column" gap={1} paddingLeft={2} paddingRight={2} paddingBottom={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={colors().text.base} attributes={TextAttributes.BOLD}>
          {TITLE}
        </text>
        <Show when={props.refreshing && props.view.state !== "loading"}>
          <text fg={colors().text.muted}>refreshing…</text>
        </Show>
      </box>
      <Show when={props.view.state === "loading"}>
        <text fg={colors().text.muted}>Loading…</text>
      </Show>
      <Show when={props.view.state === "failed"}>
        <text fg={colors().text.feedback.error.base} wrapMode="word">
          {UNAVAILABLE}
        </text>
      </Show>
      <Show when={props.view.state === "ready" ? props.view.status : undefined}>{(status) => <StatusBody status={status()} colors={colors()} />}</Show>
      <text fg={colors().text.muted}>{"r refresh · esc close"}</text>
    </box>
  )
}

export default {
  id: "google-workspace.gws.tui",
  setup(context) {
    const [view, setView] = createSignal<View>({ state: "loading" })
    const [refreshing, setRefreshing] = createSignal(false)
    let generation = 0
    let controller: AbortController | undefined
    // Identifies the open dialog; showing another dialog closes this one.
    let open: object | undefined
    let disposed = false
    let unsubscribe: (() => void) | undefined

    const cancel = () => {
      generation++
      controller?.abort()
      controller = undefined
    }

    const refresh = () => {
      if (disposed || !open) return
      cancel()
      const request = generation
      const current = new AbortController()
      controller = current
      setRefreshing(true)
      void context.client
        .rpc(Gws)
        .status({}, { location: context.location ?? context.data.location.default(), signal: current.signal })
        .then(
          (status): View => (isStatus(status) ? { state: "ready", status } : { state: "failed" }),
          (): View => ({ state: "failed" }),
        )
        .then((next) => {
          if (request !== generation) return
          controller = undefined
          setView(next)
          setRefreshing(false)
        })
    }

    const show = () => {
      if (disposed) return
      const token = {}
      // Listen only while this dialog is open; the close callback stops it.
      const stops = REFRESH_EVENTS.map((type) => context.data.on(type, refresh))
      context.ui.dialog.show(
        () => <Dialog context={context} view={view()} refreshing={refreshing()} refresh={refresh} />,
        () => {
          for (const stop of stops.splice(0)) stop()
          if (open !== token) return
          open = undefined
          cancel()
        },
      )
      context.ui.dialog.set({ size: "large" })
      open = token
      unsubscribe = () => {
        for (const stop of stops.splice(0)) stop()
      }
      setView({ state: "loading" })
      refresh()
    }

    // Registered from setup, outside any root of the plugin's own, where OpenCode's keymap is
    // available. Global, so the palette, which runs in its own input mode, lists the command.
    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "google-workspace.gws.status",
          title: TITLE,
          description: "Sign-in, access, services, unguarded agents and the next step for each Google Workspace account",
          group: "Google Workspace",
          palette: true,
          slash: { name: "gws" },
          run: show,
        },
      ],
    }))

    return () => {
      if (disposed) return
      disposed = true
      cancel()
      unsubscribe?.()
      if (open) {
        open = undefined
        context.ui.dialog.clear()
      }
    }
  },
} satisfies Plugin.Definition
