import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { COMMANDS, formatStatus, planSummary, registerCommands, summarizeStatus } from "../src/host/commands.js"
import { integrationConnection } from "../src/host/integrations.js"
import { statusSource } from "../src/host/rpc.js"
import { enableApisUrl } from "../src/auth/setup.js"
import { loadManifest } from "../src/domain/manifest.js"
import { requestedScopes } from "../src/domain/scopes.js"
import type { GwsStatus } from "../src/rpc.js"
import type { RuntimeOptions } from "../src/runtime/accounts.js"
import type { Runtime } from "../src/runtime/index.js"
import { ALL_SCOPES, STORED_TOKEN, TEST_CLIENT, account, fakeTokens, storedSignIn, testRuntime } from "./support/config.js"
import { request } from "./support/requests.js"

// A scripted gws under the repo (binary trust rejects /tmp ancestors). It
// logs each account call and answers per service: Gmail and Calendar work,
// Drive's API is disabled, Docs answers "not found" for the probe id, and
// the Reports API refuses a non-admin as gws 0.22.5 prints it: Google's 401
// as pretty JSON on stdout, exit 1, and the error[api] line on stderr.
let dir: string
let binary: string
let log: string

beforeAll(() => {
  dir = mkdtempSync(join(process.cwd(), ".commands-test-"))
  binary = join(dir, "gws")
  log = join(dir, "calls")
  writeFileSync(
    binary,
    `#!/bin/sh
if [ "$1" = "--version" ]; then echo "gws 0.22.5"; exit 0; fi
echo "$*" >> '${log}'
case "$1" in
  drive) printf '{"error":{"code":403,"message":"Google Drive API has not been used in project 123 before or it is disabled. Enable it by visiting https://console.developers.google.com/apis/api/drive.googleapis.com/overview?project=123 then retry.","status":"PERMISSION_DENIED","details":[{"reason":"SERVICE_DISABLED"}]}}'; exit 1;;
  docs) printf '{"error":{"code":404,"message":"Requested entity was not found.","status":"NOT_FOUND"}}'; exit 1;;
  admin-reports)
    printf '{\n  "error": {\n    "code": 401,\n    "message": "Access denied. You are not authorized to read activity records.",\n    "reason": "authError"\n  }\n}\n'
    printf 'Using keyring backend: file\nerror[api]: Access denied. You are not authorized to read activity records.\n' >&2
    exit 1;;
  *) printf '{"ok":true}';;
esac
`,
  )
  chmodSync(binary, 0o755)
})

afterAll(() => rmSync(dir, { recursive: true, force: true }))

const calls = () => {
  try {
    return readFileSync(log, "utf8").trim().split("\n").filter(Boolean)
  } catch {
    return []
  }
}

interface Harness {
  runtime: Runtime
  commands: Map<string, { description?: string; execute: (input: unknown) => Promise<void> }>
  synthetic: Array<Record<string, unknown>>
  asserts: Array<{ sessionID: string; action: string; resources: string[] }>
  stop: () => Promise<void>
}

let harness: Harness | undefined

afterEach(async () => {
  await harness?.stop()
  await harness?.runtime.close()
  harness = undefined
  rmSync(log, { force: true })
})

async function setup(
  overrides: Record<string, unknown> = {},
  options: Partial<RuntimeOptions> & { credentials?: Record<string, unknown>; refuse?: boolean } = {},
): Promise<Harness> {
  const synthetic: Harness["synthetic"] = []
  const asserts: Harness["asserts"] = []
  const commands: Harness["commands"] = new Map()
  const ctx = {
    location: { directory: process.cwd() },
    agent: { list: async () => ({ data: [] }) },
    integration: {
      connection: {
        active: async (id: string) => (options.credentials?.[id] ? { type: "credential", id, label: id, method: "oauth" } : undefined),
        resolve: async (connection: { id: string }) => options.credentials?.[connection.id],
      },
    },
    permission: {
      assert: async (input: Harness["asserts"][number]) => {
        asserts.push(input)
        if (options.refuse) throw new Error("rejected")
      },
    },
    command: { transform: async (callback: (editor: unknown) => void) => callback({ add: (definition: { name: string }) => commands.set(definition.name, definition as never) }) },
    session: { synthetic: async (input: Record<string, unknown>) => { synthetic.push(input) } },
  }
  const ids = new Map([["personal", "gws-personal"], ["work", "gws-work"]])
  const runtime = await testRuntime(
    { binary: { path: binary }, ...overrides },
    { connection: integrationConnection(ctx as never, ids), ...options },
  )
  const stop = await registerCommands(
    ctx as never,
    {
      status: statusSource(runtime, async () => []),
      plans: (sessionID) => runtime.plans.list({ sessionId: sessionID }).map(planSummary),
      doctor: runtime,
      install: async (settled) => ({ path: await runtime.binaryFor({ signal: settled, mayDownload: async () => undefined }), version: runtime.version }),
    },
    runtime.signal,
  )
  harness = { runtime, commands, synthetic, asserts, stop }
  return harness
}

const run = (h: Harness, name: string, delivery = "steer") => h.commands.get(name)!.execute({ sessionID: "ses_1", prompt: { text: "" }, delivery })

/** A tested host, as status reports it. */
const TESTED = { version: "2.2.3", range: ">=2.2.3 <2.3.0", tested: true }

describe("commands", () => {
  it("registers only /gws-status, /gws-doctor and /gws-install", async () => {
    const h = await setup()
    expect([...h.commands.keys()]).toEqual(["gws-status", "gws-doctor", "gws-install"])
    for (const command of h.commands.values()) expect(command.description).toMatch(/^Google Workspace: /)
  })

  it("post synthetic messages without starting a model turn", async () => {
    const h = await setup()
    for (const name of ["gws-status", "gws-doctor"]) await run(h, name, "queue")
    expect(h.synthetic).toHaveLength(2)
    for (const [index, message] of h.synthetic.entries()) {
      expect(message).toMatchObject({ sessionID: "ses_1", delivery: "queue", resume: false, metadata: { source: "opencode-gws", command: Object.values(COMMANDS)[index]!.name } })
    }
  })
})

describe("/gws-status", () => {
  it("names a config-only agent and gives the per-agent block, first in its own permissions", () => {
    const status: GwsStatus = { version: "1", host: TESTED, state: "connected" as const, access: "all", nextStep: "Nothing to do.", gws: { path: "/bin/gws", version: "gws 0.22.5" }, services: [], accounts: [], unguardedAgents: ["notes"], permissionsBlock: '{"agents":{"notes":{"permissions":[{"action":"gws.write","resource":"*","effect":"ask"}]}}}' }
    const text = formatStatus(status)
    // The row lists names only, then the block; the one fixed sentence is the Next step.
    expect(text).toContain('Agents without default rules: notes\n{"agents":{"notes":{"permissions":[{"action":"gws.write","resource":"*","effect":"ask"}]}}}\nOpenCode:')
  })

  it("renders the rows in the shared order, as plain text, with exactly one Next step", async () => {
    const granted = requestedScopes(["gmail", "drive"], "read").filter((scope) => !scope.endsWith("drive.readonly"))
    const h = await setup(
      { accounts: { personal: account({ services: ["gmail", "drive"] }), work: account({ oauthClient: TEST_CLIENT }) } },
      { credentials: { "gws-personal": storedSignIn("read", granted) }, host: TESTED },
    )
    await run(h, "gws-status")
    expect(h.synthetic[0]).toMatchObject({ description: "Google Workspace: sign-in required for work" })
    const text = String(h.synthetic[0]!["text"])
    expect(text).toContain(
      [
        "Connection: connected",
        "Account: personal (OpenCode sign-in)",
        "Access: read-only",
        "Client: entered at sign-in",
        "Services: gmail, drive",
        "Granted scopes: gmail.readonly, drive.apps.readonly, openid, userinfo.email, userinfo.profile",
        "Scopes not granted: drive.readonly",
      ].join("\n"),
    )
    expect(text).toContain(["Connection: sign-in required", "Account: work (OpenCode sign-in)", "Access: read-only", "Client: from accounts.work.oauthClient"].join("\n"))
    const rows = ["Connection:", "Tools:", "Agents without default rules:", "OpenCode:", "Next step:"].map((row) => text.indexOf(row))
    expect(rows).toEqual([...rows].sort((a, b) => a - b))
    expect(text.match(/Next step:/g)).toHaveLength(1)
    expect(text).toMatch(/OpenCode: 2\.2\.3 \(tested\)\nNext step: personal: To sign in again, run \/connect and choose Google Workspace \(personal\), or run opencode auth login gws-personal, and approve every scope Google lists\.$/)
    expect(text).not.toMatch(/\*\*|`/)
    for (const secret of [STORED_TOKEN, TEST_CLIENT.clientSecret]) expect(JSON.stringify(h.synthetic)).not.toContain(secret)
  })

  it("names a skill that hides the plugin's own, before Tools", () => {
    const status: GwsStatus = { version: "1", host: TESTED, state: "connected" as const, access: "all", nextStep: "Move it.", gws: { path: "/bin/gws", version: "gws 0.22.5" }, services: [], accounts: [], shadowedSkills: [{ id: "opencode-gws", path: "/u/skills/opencode-gws/SKILL.md" }], unguardedAgents: [] }
    expect(formatStatus(status)).toMatch(/\nHidden skills: opencode-gws \(hidden by \/u\/skills\/opencode-gws\/SKILL\.md\)\nTools: /)
  })

  it("names the skills that run gws in a shell, before Tools", () => {
    const status: GwsStatus = { version: "1", host: TESTED, state: "connected" as const, access: "all", nextStep: "Remove it.", gws: { path: "/bin/gws", version: "gws 0.22.5" }, services: [], accounts: [], shellSkills: [{ id: "gws-gmail", path: "/u/skills/gws-gmail/SKILL.md" }, { id: "gws-drive", path: "/u/skills/gws-drive/SKILL.md" }], unguardedAgents: [] }
    expect(formatStatus(status)).toMatch(/\nShell gws skills: gws-gmail \(\/u\/skills\/gws-gmail\/SKILL\.md\), gws-drive \(\/u\/skills\/gws-drive\/SKILL\.md\)\nTools: /)
  })

  it("says Nothing to do. and marks an untested host", () => {
    const status: GwsStatus = { version: "1", host: { version: "2.3.0", range: ">=2.2.3 <2.3.0", tested: false }, state: "connected", access: "all", nextStep: "Nothing to do.", gws: { path: "/bin/gws", version: "gws 0.22.5" }, services: [], accounts: [], unguardedAgents: [] }
    const text = formatStatus(status)
    expect(text).toContain("OpenCode: 2.3.0 (host untested; supported range >=2.2.3 <2.3.0)")
    expect(text).toMatch(/Next step: Nothing to do\.$/)
  })

  it("summarises status in one transcript line", () => {
    const base = { version: "1", host: TESTED, state: "connected" as const, access: "all" as const, nextStep: "Nothing to do.", gws: { path: "/bin/gws", version: "gws 0.22.5" }, services: [], unguardedAgents: [] }
    const ready = { alias: "a", mode: "interactive" as const, services: [], integrationID: "gws-a", connected: true, missingScopes: [] }
    expect(summarizeStatus({ ...base, accounts: [] })).toBe("Google Workspace: no accounts configured")
    expect(summarizeStatus({ ...base, accounts: [ready] })).toBe("Google Workspace: 1 account connected")
    expect(summarizeStatus({ ...base, accounts: [ready, { ...ready, alias: "b", connected: false, needsAuth: true }] })).toBe("Google Workspace: sign-in required for b")
    expect(summarizeStatus({ ...base, accounts: [{ ...ready, missingScopes: ["x"] }] })).toBe("Google Workspace: a did not grant every scope")
    expect(summarizeStatus({ ...base, accounts: [ready, { alias: "ci", mode: "credentials_file", services: [], connected: false }] })).toBe("Google Workspace: not configured: ci")
  })

  it("shows the services that need domain-wide delegation, and how to add their scopes", () => {
    const notes = { alias: "notes", mode: "interactive" as const, services: ["keep"], integrationID: "gws-notes", connected: true, missingScopes: [], delegationRequired: ["keep"] }
    const status: GwsStatus = { version: "1", host: TESTED, state: "connected" as const, access: "all", nextStep: "Nothing to do.", gws: { path: "/bin/gws", version: "gws 0.22.5" }, services: [], accounts: [notes], unguardedAgents: [] }
    expect(formatStatus(status)).toContain("Services: keep\nNeeds domain-wide delegation: keep (a Workspace admin sets it up; then add the scopes to accounts.notes.scopes)")
  })

  it("shows a headless account as connected or not configured, never as signed in", () => {
    const headless = { alias: "ci", mode: "credentials_file" as const, services: ["drive"], connected: false }
    const status: GwsStatus = { version: "1", host: TESTED, state: "connected" as const, access: "all", nextStep: "Nothing to do.", gws: { path: "/bin/gws", version: "gws 0.22.5" }, services: [], accounts: [headless], unguardedAgents: [] }
    expect(formatStatus(status)).toContain("Connection: not configured\nAccount: ci (credentials file)\nServices: drive")
    expect(formatStatus({ ...status, accounts: [{ ...headless, connected: true }] })).toContain("Connection: connected\nAccount: ci (credentials file)")
  })
})

describe("/gws-status pending plans", () => {
  const BODY = "c2VjcmV0IGJvZHk"
  const sendRequest = request("gmail.users.messages.send", { params: { userId: "me", q: "launch code 0000" }, body: { raw: BODY } })

  it("posts the session's plans, redacted", async () => {
    const h = await setup({})
    const planned = await h.runtime.plan(sendRequest, { sessionId: "ses_1", agentId: "build" })
    const summary = planSummary(h.runtime.inspectPlan("send", { planId: planned.planId }, { sessionId: "ses_1", agentId: "build" }))
    expect(Object.keys(summary).sort()).toEqual(["account", "category", "createdAt", "expiresAt", "operation", "planId", "preview", "sessionID"].sort())
    await run(h, "gws-status")
    expect(h.synthetic[0]).toMatchObject({ description: "Google Workspace: sign-in required for personal · 1 pending plan" })
    expect(h.synthetic[0]!["text"]).toMatch(/Pending plans in this session \(1\)/)
    expect(h.synthetic[0]!["text"]).toContain("- send gmail.users.messages.send as personal")
    expect(h.synthetic[0]!["text"]).toMatch(/A commit runs without a prompt \(access "all"\)/)
    for (const secret of [BODY, "launch code", "--json", "--params", "users/{userId}", "build"]) {
      expect(JSON.stringify(summary)).not.toContain(secret)
      expect(JSON.stringify(h.synthetic)).not.toContain(secret)
    }
  })

  it("formats an empty plan list and every preview field", () => {
    const status: GwsStatus = { version: "1", host: TESTED, state: "connected" as const, access: "all", nextStep: "Nothing to do.", gws: { path: "/bin/gws", version: "gws 0.22.5" }, services: [], accounts: [], unguardedAgents: [] }
    expect(formatStatus(status)).toContain("No pending plans in this session.")
    expect(summarizeStatus(status)).toBe("Google Workspace: no accounts configured")
    const text = formatStatus(
      status,
      [
        {
          planId: "plan_x",
          sessionID: "ses_1",
          category: "share",
          operation: "drive.permissions.create",
          account: "work",
          preview: { method: "POST", recipients: ["a@example.com"], destination: "file 1", bodySummary: "object(role) 20 bytes" },
          createdAt: "2026-10-27T11:59:00Z",
          expiresAt: "2026-10-27T12:04:05Z",
        },
      ],
      Date.parse("2026-10-27T12:00:00Z"),
    )
    expect(text).toContain("- share drive.permissions.create as work: to a@example.com · destination file 1 · body object(role) 20 bytes · expires in 4m 5s (plan_x)")
    expect(text).toContain("Pending plans expire automatically.")
  })

  it("says what access decides for a pending commit, for each value", () => {
    const plan = {
      planId: "plan_x",
      sessionID: "ses_1",
      category: "share" as const,
      operation: "drive.permissions.create",
      account: "work",
      preview: { method: "POST", destination: "file 1", bodySummary: "object(role) 20 bytes" },
      createdAt: "2026-10-27T11:59:00Z",
      expiresAt: "2026-10-27T12:04:05Z",
    }
    const status: GwsStatus = { version: "1", host: TESTED, state: "connected" as const, access: "all", nextStep: "Nothing to do.", gws: { path: "/bin/gws", version: "gws 0.22.5" }, services: [], accounts: [], unguardedAgents: [] }
    const phrase = (access: GwsStatus["access"]) => formatStatus({ ...status, access }, [plan], Date.parse("2026-10-27T12:00:00Z"))
    expect(phrase("all")).toContain('A commit runs without a prompt (access "all").')
    expect(phrase("ask-changes")).toContain('Each commit asks in the OpenCode permission prompt (access "ask-changes").')
    expect(phrase("read-only")).toContain('Commits are denied (access "read-only").')
    for (const access of ["all", "ask-changes", "read-only"] as const) expect(phrase(access), access).not.toContain("Approval happens only")
  })
})

describe("/gws-status setup steps", () => {
  it("knows an API to enable for every manifest service", () => {
    for (const service of loadManifest().services) expect(enableApisUrl([service.alias]), service.alias).toMatch(/apiid=[a-z-]+\.googleapis\.com/)
  })

  it("links the exact APIs per account, the consent screen, and the Desktop client, with the Internal and Testing guidance", async () => {
    const h = await setup({ accounts: { personal: account({ services: ["gmail", "calendar", "workflow"] }), work: account({ services: ["drive", "admin-reports"] }) } })
    await run(h, "gws-status")
    const text = String(h.synthetic[0]!["text"])
    expect(text).toContain("Set up an OAuth client for personal, work: create your own Desktop app client, or ask your administrator for one.")
    expect(text).toContain(
      "- personal (gmail, calendar, workflow): https://console.cloud.google.com/flows/enableapi?apiid=gmail.googleapis.com,calendar-json.googleapis.com,tasks.googleapis.com,drive.googleapis.com",
    )
    expect(text).toContain("- work (drive, admin-reports): https://console.cloud.google.com/flows/enableapi?apiid=drive.googleapis.com,admin.googleapis.com")
    expect(text).toContain("https://console.developers.google.com/auth/branding")
    expect(text).toContain("Internal user type")
    expect(text).toContain("Testing status gets refresh tokens that expire after 7 days")
    expect(text).toContain("https://developers.google.com/identity/protocols/oauth2#expiration")
    expect(text).toContain("type Desktop app at https://console.developers.google.com/auth/clients")
    expect(text).toContain("A Web client works only with a redirectUri registered on it, for OpenCode on another machine.")
    expect(text).toContain("run /connect and choose Google Workspace (personal), or run opencode auth login gws-personal")
  })

  it("gives no setup steps to accounts with a configured client", async () => {
    const h = await setup({ accounts: { personal: account({ oauthClient: TEST_CLIENT }) } })
    await run(h, "gws-status")
    expect(String(h.synthetic[0]!["text"])).not.toContain("Set up an OAuth client")
  })
})

describe("/gws-doctor", () => {
  it("asks for gws.read per probe and reports OK, API_DISABLED with the enable link, and skips services without a probe", async () => {
    const h = await setup({ accounts: { personal: account({ services: ["gmail", "drive", "docs", "events"] }) } })
    await run(h, "gws-doctor")
    expect(h.asserts).toEqual([
      { sessionID: "ses_1", action: "gws.read", resources: ["personal:gmail.users.getProfile"] },
      { sessionID: "ses_1", action: "gws.read", resources: ["personal:drive.about.get"] },
      { sessionID: "ses_1", action: "gws.read", resources: ["personal:docs.documents.get"] },
    ])
    expect(calls()).toEqual([
      'gmail users getProfile --params {"fields":"emailAddress","userId":"me"} --format json',
      'drive about get --params {"fields":"user(emailAddress)"} --format json',
      'docs documents get --params {"documentId":"gws-doctor-probe","fields":"documentId"} --format json',
    ])
    expect(h.synthetic[0]).toMatchObject({ description: "Google Workspace doctor: 2 OK · 1 needs attention" })
    expect(String(h.synthetic[0]!["text"]).split("\n").slice(2)).toEqual([
      "- personal gmail: OK",
      "- personal drive: API_DISABLED · the API is not enabled in the OAuth client's Google Cloud project. Next step: Enable it at https://console.developers.google.com/apis/api/drive.googleapis.com/overview?project=123, wait about a minute, and run /gws-doctor again",
      "- personal docs: OK",
      "- personal events: SKIPPED · no read-only check exists for this service",
    ])
  })

  it("reports a non-admin's Reports refusal as ADMIN_PRIVILEGE_REQUIRED, keeps checking the account, and skips Keep without delegation", async () => {
    const h = await setup({ accounts: { personal: account({ services: ["admin-reports", "gmail", "keep"] }) } }, { tokenProvider: fakeTokens("ya29.valid", ALL_SCOPES) })
    await run(h, "gws-doctor")
    expect(calls()).toEqual([
      'admin-reports activities list --params {"applicationName":"login","fields":"items(id)","maxResults":1,"userKey":"all"} --format json',
      'gmail users getProfile --params {"fields":"emailAddress","userId":"me"} --format json',
    ])
    expect(h.synthetic[0]).toMatchObject({ description: "Google Workspace doctor: 1 OK · 1 needs attention" })
    expect(String(h.synthetic[0]!["text"]).split("\n").slice(2)).toEqual([
      '- personal admin-reports: ADMIN_PRIVILEGE_REQUIRED · Google accepted the sign-in, but the account lacks the Workspace admin privilege this service needs. Next step: Add a separate account alias for a Workspace admin who has the Reports privilege, with enabledServices ["admin-reports"], and sign in to it from /connect, or remove admin-reports from accounts.personal.enabledServices',
      "- personal gmail: OK",
      "- personal keep: SKIPPED · keep needs domain-wide delegation, which a Workspace admin sets up; with it, add keep or keep.readonly to accounts.personal.scopes and sign in again",
    ])
    expect(String(h.synthetic[0]!["text"])).not.toContain("AUTH_REQUIRED")
  })

  it("reports an account that is not signed in once, without running gws", async () => {
    const h = await setup({ accounts: { personal: account({ services: ["gmail", "calendar"] }) } }, { tokenProvider: async () => undefined })
    await run(h, "gws-doctor")
    expect(calls()).toEqual([])
    expect(String(h.synthetic[0]!["text"])).toContain(
      "- personal gmail: AUTH_REQUIRED · 'personal' is not signed in to Google Workspace. Next step: To sign in, run /connect and choose Google Workspace, or run opencode auth login gws-personal.",
    )
    expect(String(h.synthetic[0]!["text"])).not.toContain("calendar")
  })

  it("reports a missing scope without running gws, and checks the next service", async () => {
    const grant = requestedScopes(["gmail"], "read")
    const h = await setup({ accounts: { personal: account({ services: ["people", "gmail"] }) } }, { tokenProvider: fakeTokens("ya29.read", grant) })
    await run(h, "gws-doctor")
    expect(calls()).toEqual(['gmail users getProfile --params {"fields":"emailAddress","userId":"me"} --format json'])
    const text = String(h.synthetic[0]!["text"])
    expect(text).toContain("- personal people: AUTH_SCOPE_MISSING · The sign-in for 'personal' has not granted a scope people.people.connections.list needs")
    expect(text).toContain("- personal gmail: OK")
  })

  it("stops at a refused permission and runs nothing", async () => {
    const h = await setup({ accounts: { personal: account({ services: ["gmail", "calendar"] }) } }, { refuse: true, tokenProvider: fakeTokens("t", ALL_SCOPES) })
    await run(h, "gws-doctor")
    expect(calls()).toEqual([])
    expect(h.asserts).toHaveLength(1)
    expect(String(h.synthetic[0]!["text"])).toContain("- personal gmail: DENIED · a permission rule or reply refused gws.read")
  })
})
