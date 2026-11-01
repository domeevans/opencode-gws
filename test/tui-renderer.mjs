// npm run test:tui, after npm run build: renders the compiled TUI part (dist/tui.js) with
// OpenTUI's test renderer. Bun's browser condition loads Solid's reactive build, as OpenCode's
// TUI does. The context is a fake that answers the status RPC with fixtures; there is no
// OpenCode host and no network.
import assert from "node:assert/strict"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const DIST = new URL("../dist/tui.js", import.meta.url)
if (!existsSync(fileURLToPath(DIST))) throw new Error("dist/tui.js is missing. Run npm run build first.")

const root = mkdtempSync(join(tmpdir(), "gws-tui-renderer-"))
for (const key of Object.keys(process.env)) {
  if (key.startsWith("OPENCODE") || key.startsWith("GOOGLE") || key.startsWith("GWS") || key.startsWith("XDG_")) delete process.env[key]
}
for (const key of ["HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"]) process.env[key] = root

const { createComponent, createRoot, createSignal, getOwner, onCleanup, Show } = await import("solid-js")
const { createElement, insert, setProp, testRender } = await import("@opentui/solid")
const { default: plugin } = await import(DIST.href)

const G = (scope) => `https://www.googleapis.com/auth/${scope}`
const SERVICES = ["gmail", "drive", "calendar", "docs", "sheets"]
const base = { alias: "default", mode: "interactive", services: SERVICES, integrationID: "gws-default" }
const status = (account, extra = {}) => ({
  pluginVersion: "1.2.3",
  hostVersion: "2.2.3",
  gws: { path: "/fixture/gws", version: "gws 0.22.5" },
  services: SERVICES,
  accounts: [account],
  auditDegraded: false,
  unguardedAgents: [],
  ...extra,
})
const NEXT = "Sign in: run /connect and choose Google Workspace."
const SIGNED_OUT = status({ ...base, connected: false, access: "read", nextStep: NEXT }, { nextStep: NEXT })
const SIGNED_IN = status({
  ...base,
  connected: true,
  access: "read",
  clientSource: "pasted",
  grantedScopes: [G("gmail.readonly"), G("drive.readonly"), "openid"],
  missingScopes: [],
})

const requests = []
const handlers = new Map()
const layers = new Set()
const [dialog, setDialog] = createSignal()
let dialogSize
const closeDialog = () => {
  const current = dialog()
  setDialog(undefined)
  current?.onClose?.()
}
const theme = {
  text: {
    base: "#ffffff",
    muted: "#888888",
    faint: "#666666",
    feedback: Object.fromEntries(["success", "warning", "error", "info"].map((kind) => [kind, { base: "#ffff00", muted: "#888800" }])),
  },
  surface: () => theme,
}
const context = {
  location: { directory: root },
  theme,
  client: {
    rpc: (definition) => ({
      status: (input, options = {}) =>
        new Promise((resolve, reject) => {
          assert.equal(definition.id, "google-workspace.gws")
          assert.deepEqual(input, {})
          options.signal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")))
          requests.push({ resolve, reject, signal: options.signal })
        }),
    }),
  },
  data: {
    on: (type, handler) => {
      handlers.set(type, handler)
      return () => handlers.delete(type)
    },
    location: { default: () => ({ directory: root }) },
  },
  keymap: {
    layer: (factory) => {
      const layer = factory()
      layers.add(layer)
      // OpenCode removes a layer when the component that created it is disposed.
      if (getOwner()) onCleanup(() => layers.delete(layer))
    },
  },
  ui: {
    dialog: {
      show: (render, onClose) => {
        closeDialog()
        setDialog({ render, onClose })
      },
      set: (options) => {
        dialogSize = options.size
      },
      clear: closeDialog,
    },
  },
}

const command = (key) => [...layers].flatMap((layer) => layer.commands ?? []).find((entry) => entry.id === key || entry.bind === key)
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
let disposeRoot
let cleanup
let screen
try {
  createRoot((dispose) => {
    disposeRoot = dispose
    cleanup = plugin.setup(context)
  })
  screen = await testRender(
    () => {
      const box = createElement("box")
      setProp(box, "flexDirection", "column")
      insert(
        box,
        createComponent(Show, {
          get when() {
            return dialog()
          },
          children: (open) => open().render(),
        }),
      )
      return box
    },
    { width: 110, height: 40 },
  )
  const frame = async () => {
    await settle()
    await screen.renderOnce()
    return screen.captureCharFrame()
  }

  // Nothing renders or loads until the palette command runs; there is no footer.
  assert.equal(requests.length, 0)
  assert.doesNotMatch(await frame(), /GWS|Google Workspace/)

  // The dialog: loading, then the account, the host check and the next step.
  command("google-workspace.gws.status").run()
  assert.equal(dialogSize, "large")
  let text = await frame()
  assert.match(text, /Google Workspace: Status/)
  assert.match(text, /Loading…/)
  requests[0].resolve(SIGNED_OUT)
  text = await frame()
  assert.match(text, /Connection\s+sign-in required/)
  assert.match(text, /Account\s+default \(OpenCode sign-in\)/)
  assert.match(text, /Access\s+read-only/)
  assert.match(text, /Client\s+none yet/)
  assert.match(text, /Tools\s+gws tools for gmail/)
  assert.match(text, /OpenCode\s+2\.2\.3 \(tested\)/)
  assert.match(text, /Next step\s+Sign in: run \/connect and choose Google Workspace\./)
  assert.match(text, /r refresh · esc close/)
  assert.equal(handlers.size, 5)

  // A sign-in elsewhere updates the open dialog; the last status stays while it loads.
  handlers.get("credential.updated")({ type: "credential.updated", data: {} })
  assert.match(await frame(), /refreshing…/)
  requests[1].resolve(SIGNED_IN)
  text = await frame()
  assert.doesNotMatch(text, /refreshing…/)
  assert.match(text, /Connection\s+connected/)
  assert.match(text, /Client\s+entered at sign-in/)
  assert.match(text, /Granted scopes\s+gmail\.readonly, drive\.readonly, openid/)
  assert.match(text, /Next step\s+Nothing to do\./)

  // r refreshes; a failure shows the fixed message and no detail.
  command("r").run()
  requests[2].reject(new Error("PROXY-SECRET-DETAIL at /internal/path"))
  text = await frame()
  assert.match(text, /STATUS_UNAVAILABLE: Google Workspace status could not be read\./)
  assert.doesNotMatch(text, /PROXY-SECRET-DETAIL|Connection/)

  // Only the newest request counts: a late answer to an older one changes nothing.
  handlers.get("server.connected")({ type: "server.connected", data: {} })
  handlers.get("agent.updated")({ type: "agent.updated", data: {} })
  assert.equal(requests[3].signal.aborted, true)
  const block = '{ "agents": { "notes": { "permissions": [] } } }'
  requests[4].resolve(status(SIGNED_IN.accounts[0], { hostVersion: "2.3.0", hostWarning: "outside the tested range", unguardedAgents: ["notes"], permissionsBlock: block }))
  requests[3].resolve(SIGNED_OUT)
  text = await frame()
  assert.match(text, /OpenCode\s+2\.3\.0 \(host untested: outside the tested range\)/)
  assert.match(text, /Agents without default rules\s+notes/)
  assert.ok(text.includes(block))
  assert.doesNotMatch(text, /sign-in required/)

  // Esc closes the dialog, removes its keys, and later events load nothing.
  command("escape").run()
  text = await frame()
  assert.doesNotMatch(text, /Google Workspace/)
  assert.equal(command("r"), undefined)
  assert.equal(handlers.size, 0)
  assert.equal(requests.length, 5)

  // Cleanup: no listeners, no dialog, the pending call cancelled.
  command("google-workspace.gws.status").run()
  cleanup()
  text = await frame()
  assert.equal(handlers.size, 0)
  assert.equal(requests[5].signal.aborted, true)
  assert.doesNotMatch(text, /Google Workspace/)
  disposeRoot()
  assert.equal(layers.size, 0)
  console.log("PASS dist/tui.js on OpenTUI: status rows, unguarded agents, live refresh while open, newest-only answers, Esc, cleanup")
} finally {
  cleanup?.()
  disposeRoot?.()
  screen?.renderer.destroy()
  rmSync(root, { recursive: true, force: true })
}
