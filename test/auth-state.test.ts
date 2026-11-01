import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { AuthStateTracker, type AuthState } from "../src/domain/auth-state.js"
import { authProblem, errorFromProcess, parseResult } from "../src/domain/result.js"
import type { ProcessResult } from "../src/domain/types.js"
import { integrationAuthReporter } from "../src/host/integrations.js"
import type { Runtime } from "../src/runtime/index.js"
import { ALL_SCOPES, testConfig, testRuntime } from "./support/config.js"
import { request } from "./support/requests.js"

function processResult(stdout: string, exitCode = 1, stderr = ""): ProcessResult {
  return { exitCode, signal: null, stdout: Buffer.from(stdout), stderr: Buffer.from(stderr), durationMs: 1, timedOut: false, outputCapped: false }
}

// Payloads as gws 0.22.5 prints them (captured from real calls with no,
// bogus, and revoked credentials), plus Google's 403 scope shape.
const SAMPLES = {
  noCredentials: processResult(
    '{"error":{"code":401,"message":"Access denied. No credentials provided. Run `gws auth login` or set GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE to an OAuth credentials JSON file.","reason":"authError"}}',
    2,
    "error[auth]: Access denied. No credentials provided.",
  ),
  invalidToken: processResult(
    '{"error":{"code":401,"message":"Request had invalid authentication credentials. Expected OAuth 2 access token, login cookie or other valid authentication credential.","reason":"authError"}}',
  ),
  invalidGrant: processResult(
    '{"error":{"code":401,"message":"Authentication failed: Failed to get token: Server error: invalid_grant: reauth related error (invalid_rapt)","reason":"authError"}}',
    2,
  ),
  unauthenticated: processResult('{"error":{"code":401,"status":"UNAUTHENTICATED","message":"Request is missing required authentication credential."}}'),
  scope: processResult(
    '{"error":{"code":403,"message":"Request had insufficient authentication scopes.","status":"PERMISSION_DENIED",' +
      '"errors":[{"reason":"insufficientPermissions"}],"details":[{"@type":"type.googleapis.com/google.rpc.ErrorInfo","reason":"ACCESS_TOKEN_SCOPE_INSUFFICIENT"}]}}',
  ),
  scopeReasonOnly: processResult('{"error":{"code":403,"message":"Forbidden","reason":"insufficientPermissions"}}'),
  fileForbidden: processResult('{"error":{"code":403,"message":"The user does not have sufficient permissions for file x.","reason":"insufficientFilePermissions"}}'),
  notFound: processResult('{"error":{"code":404,"message":"Requested entity was not found."}}'),
  disabled: processResult('{"error":{"code":403,"message":"Gmail API has not been used in project 1 before or it is disabled."}}'),
  stderrOnly: processResult("", 2, "error[auth]: invalid_grant: Token has been expired or revoked."),
}

describe("auth error classification", () => {
  it("classifies sign-in and consent problems and nothing else", () => {
    expect(authProblem(SAMPLES.noCredentials)).toBe("AUTH_REQUIRED")
    expect(authProblem(SAMPLES.invalidToken)).toBe("AUTH_REQUIRED")
    expect(authProblem(SAMPLES.invalidGrant)).toBe("AUTH_REQUIRED")
    expect(authProblem(SAMPLES.unauthenticated)).toBe("AUTH_REQUIRED")
    expect(authProblem(SAMPLES.stderrOnly)).toBe("AUTH_REQUIRED")
    expect(authProblem(SAMPLES.scope)).toBe("AUTH_SCOPE_MISSING")
    expect(authProblem(SAMPLES.scopeReasonOnly)).toBe("AUTH_SCOPE_MISSING")
    expect(authProblem(SAMPLES.fileForbidden)).toBeUndefined()
    expect(authProblem(SAMPLES.notFound)).toBeUndefined()
    expect(authProblem(SAMPLES.disabled)).toBeUndefined()
    expect(authProblem(processResult('{"id":"1"}', 0))).toBeUndefined()
    expect(authProblem({ ...SAMPLES.invalidToken, timedOut: true })).toBeUndefined()
  })

  it("turns them into stable codes with remediation", () => {
    const message = (result: ProcessResult) =>
      errorFromProcess(result, parseResult(result, { maxInlineBytes: 1024 }), { signIn: "sign in again: LOGIN", consent: "grant: CONSENT" })
    expect(message(SAMPLES.invalidGrant)).toMatch(/^AUTH_REQUIRED: The Google Workspace sign-in is missing or no longer valid; sign in again: LOGIN \(gws: .*invalid_grant/)
    expect(message(SAMPLES.scope)).toMatch(/^AUTH_SCOPE_MISSING: The credential lacks a scope for this operation; grant: CONSENT/)
    expect(message(SAMPLES.disabled)).toMatch(/^API_DISABLED:/)
    expect(message(SAMPLES.fileForbidden)).toMatch(/^GWS_API_ERROR:/)
  })
})

describe("AuthStateTracker", () => {
  const failing: AuthState = { status: "needs_auth", code: "AUTH_REQUIRED", message: "Sign in again" }

  it("reports transitions only", () => {
    const tracker = new AuthStateTracker()
    expect(tracker.update("a", { status: "ok" })).toBe(true)
    expect(tracker.update("a", { status: "ok" })).toBe(false)
    expect(tracker.update("a", failing)).toBe(true)
    expect(tracker.update("a", failing)).toBe(false)
    expect(tracker.update("a", { ...failing, code: "AUTH_SCOPE_MISSING", message: "Grant" })).toBe(true)
    expect(tracker.update("b", failing)).toBe(true)
    expect(tracker.update("a", { status: "ok" })).toBe(true)
    tracker.forget("a")
    expect(tracker.update("a", { status: "ok" })).toBe(true)
  })
})

// ── Runtime + host reporter with a fake gws and a fake integration ctx ──

let dir: string
let binary: string
let mode: string

beforeAll(() => {
  dir = mkdtempSync(join(process.cwd(), ".auth-state-test-"))
  binary = join(dir, "gws")
  mode = join(dir, "mode")
  writeFileSync(
    binary,
    `#!/bin/sh
if [ "$1" = "--version" ]; then echo "gws 0.22.5"; exit 0; fi
for arg in "$@"; do [ "$arg" = "--dry-run" ] && { printf '{"dry_run":true}'; exit 0; }; done
case "$(cat '${mode}')" in
  401) printf '{"error":{"code":401,"message":"Request had invalid authentication credentials.","reason":"authError"}}'; exit 1;;
  403) printf '{"error":{"code":403,"message":"Request had insufficient authentication scopes.","reason":"insufficientPermissions"}}'; exit 1;;
  404) printf '{"error":{"code":404,"message":"Requested entity was not found."}}'; exit 1;;
  *) printf '{"emailAddress":"me@example.com"}';;
esac
`,
  )
  chmodSync(binary, 0o755)
})

afterAll(() => rmSync(dir, { recursive: true, force: true }))

interface StatusCall {
  integrationID: string
  connection: { id: string }
  status: { status: string; message: string } | undefined
}

let runtime: Runtime | undefined
let statusCalls: StatusCall[]
let tokenFails: boolean
let hasConnection: boolean
let statusFails: boolean

beforeEach(() => {
  writeFileSync(mode, "ok")
  statusCalls = []
  tokenFails = false
  hasConnection = true
  statusFails = false
})

afterEach(() => {
  runtime?.close()
  runtime = undefined
})

async function setup(): Promise<{ runtime: Runtime; reporter: ReturnType<typeof integrationAuthReporter> }> {
  const ids = new Map([["personal", "gws-personal"]])
  const ctx = {
    integration: {
      connection: {
        active: async () => (hasConnection ? { id: "conn_1" } : undefined),
        resolve: async () => ({ type: "oauth", access: "token" }),
        status: async (input: StatusCall) => {
          if (statusFails) throw new Error("host unavailable")
          statusCalls.push(input)
        },
      },
    },
  }
  let reporter: ReturnType<typeof integrationAuthReporter>
  const pending: Promise<void>[] = []
  runtime = await testRuntime(
    {
      binary: { path: binary },
      policy: { rules: [] },
    },
    {
      tokenProvider: async () => {
        if (tokenFails) throw new Error("refresh failed")
        return { access: "token", grantedScopes: ALL_SCOPES }
      },
      onAuthState: (account, state) => {
        const promise = reporter!(account, state)
        pending.push(promise)
        return promise
      },
    },
  )
  reporter = integrationAuthReporter(ctx as never, runtime.config, ids)
  const settled = runtime as Runtime & { settle: () => Promise<void> }
  settled.settle = async () => {
    await Promise.all(pending)
  }
  return { runtime, reporter }
}

const profile = request("gmail.users.getProfile", { params: { userId: "me" } })
const ctx = { sessionId: "ses_1", agentId: "build" }

async function read(rt: Runtime): Promise<unknown> {
  try {
    return await rt.read(profile, ctx)
  } catch (error) {
    return error
  } finally {
    await (rt as Runtime & { settle: () => Promise<void> }).settle()
  }
}

describe("needs_auth reporting", () => {
  it("reports a refresh failure once, with the login command, and clears it after the next success", async () => {
    const { runtime: rt } = await setup()
    tokenFails = true
    const first = await read(rt)
    expect(String(first)).toMatch(/^Error: AUTH_REQUIRED: .*could not be refreshed\. Next step: To sign in again, run \/connect and choose Google Workspace, or run opencode auth login gws-personal\.$/)
    await read(rt)
    await read(rt)
    expect(statusCalls).toEqual([
      {
        integrationID: "gws-personal",
        connection: { id: "conn_1" },
        status: { status: "needs_auth", message: "To sign in again, run /connect and choose Google Workspace, or run opencode auth login gws-personal" },
      },
    ])
    tokenFails = false
    await read(rt)
    await read(rt)
    expect(statusCalls).toHaveLength(2)
    expect(statusCalls[1]).toMatchObject({ integrationID: "gws-personal", status: undefined })
  })

  it("reports a 401 from Google as needs_auth and a 403 scope error with the scopes to grant", async () => {
    const { runtime: rt } = await setup()
    writeFileSync(mode, "401")
    expect(String(await read(rt))).toMatch(/^Error: AUTH_REQUIRED: The Google Workspace sign-in is missing or no longer valid; to sign in again, run \/connect and choose Google Workspace, or run opencode auth login gws-personal/)
    writeFileSync(mode, "403")
    const scope = String(await read(rt))
    expect(scope).toMatch(/^Error: AUTH_SCOPE_MISSING: .*to grant the scope, run \/connect and choose Google Workspace, or run opencode auth login gws-personal, sign in again, and approve every scope, choosing Read and write for a change, or add one of .*gmail.* to accounts\.personal\.scopes/)
    await read(rt)
    expect(statusCalls.map((call) => call.status?.message.split(",")[0])).toEqual(["To sign in again", "To grant the scope"])
  })

  it("does not touch the status for unrelated API errors or dry runs, and clears once on the first success", async () => {
    const { runtime: rt } = await setup()
    writeFileSync(mode, "404")
    expect(String(await read(rt))).toMatch(/GWS_API_ERROR/)
    expect(statusCalls).toEqual([])
    writeFileSync(mode, "ok")
    const plan = await rt.plan(request("gmail.users.labels.create", { params: { userId: "me" }, body: { name: "x" } }), ctx)
    expect(plan.planId).toMatch(/^plan_/)
    await (rt as Runtime & { settle: () => Promise<void> }).settle()
    expect(statusCalls).toEqual([])
    await read(rt)
    await read(rt)
    expect(statusCalls).toEqual([{ integrationID: "gws-personal", connection: { id: "conn_1" }, status: undefined }])
  })

  it("retries a report the host failed to record, and never fails the call for it", async () => {
    const { runtime: rt } = await setup()
    writeFileSync(mode, "401")
    statusFails = true
    expect(String(await read(rt))).toMatch(/AUTH_REQUIRED/)
    statusFails = false
    await read(rt)
    expect(statusCalls).toHaveLength(1)
    expect(statusCalls[0]!.status?.status).toBe("needs_auth")
  })

  it("ignores headless accounts, which have no connection to mark", async () => {
    const config = testConfig({ accounts: { ci: { mode: "credentials_file", enabledServices: ["drive"], credentialsFileEnv: "GWS_CREDENTIALS" } } })
    const reporter = integrationAuthReporter({} as never, config, new Map([["ci", "gws-ci"]]))
    await reporter("ci", { status: "needs_auth", code: "AUTH_REQUIRED", message: "x" })
    expect(statusCalls).toEqual([])
  })
})
