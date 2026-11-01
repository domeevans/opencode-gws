#!/usr/bin/env node
/**
 * Fake `gws` 0.22.5 for tests. It never touches the network.
 *
 * - `--version` and `schema <id>` answer locally (the plugin runs them with
 *   an account-free environment).
 * - Every invocation is appended as one JSON argv line to the file named by
 *   FAKE_GWS_LOG, when set, so a test can prove exactly which argv ran.
 *   Each account-scoped invocation is also appended to
 *   $GOOGLE_WORKSPACE_CLI_CONFIG_DIR/invocations.jsonl when that directory,
 *   the account's own, exists, so a test with several accounts can tell
 *   them apart.
 * - `--dry-run` answers with a request preview; anything else with a canned
 *   API response chosen by method name.
 * - FAKE_GWS_FAIL=<kind> makes every account-scoped call fail the way gws
 *   does: an API error object on stdout and gws's exit code for the class.
 *   Kinds: api, auth, scope, disabled, validation.
 */
import { appendFileSync, existsSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const argv = process.argv.slice(2)
const out = (value) => process.stdout.write(JSON.stringify(value))

if (process.env.FAKE_GWS_LOG) appendFileSync(process.env.FAKE_GWS_LOG, `${JSON.stringify(argv)}\n`)

if (argv[0] === "--version") {
  process.stdout.write("gws 0.22.5\nThis is not an officially supported Google product.\n")
  process.exit(0)
}

if (argv[0] === "schema") {
  out({
    httpMethod: "GET",
    path: "gmail/v1/users/{userId}/profile",
    scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
    parameterOrder: ["userId"],
    parameters: { userId: { type: "string", location: "path", required: true } },
  })
  process.exit(0)
}

const accountDir = process.env.GOOGLE_WORKSPACE_CLI_CONFIG_DIR
if (accountDir && existsSync(accountDir)) appendFileSync(join(accountDir, "invocations.jsonl"), `${JSON.stringify(argv)}\n`)

const ENABLE_URL = "https://console.developers.google.com/apis/api/gmail.googleapis.com/overview?project=000000000000"
const FAILURES = {
  api: [1, { code: 404, message: "Requested entity was not found.", status: "NOT_FOUND", errors: [{ reason: "notFound" }] }],
  auth: [2, { code: 401, message: "Request had invalid authentication credentials.", status: "UNAUTHENTICATED", errors: [{ reason: "authError" }] }],
  scope: [1, { code: 403, message: "Request had insufficient authentication scopes.", status: "PERMISSION_DENIED", details: [{ reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT" }] }],
  disabled: [
    1,
    {
      code: 403,
      message: `Gmail API has not been used in project 000000000000 before or it is disabled. Enable it by visiting ${ENABLE_URL} then retry.`,
      status: "PERMISSION_DENIED",
      reason: "accessNotConfigured",
      enable_url: ENABLE_URL,
    },
  ],
  validation: [3, { code: 400, message: "Invalid value for parameter.", status: "INVALID_ARGUMENT", errors: [{ reason: "invalid" }] }],
}

const failure = process.env.FAKE_GWS_FAIL
if (failure) {
  const entry = FAILURES[failure]
  if (!entry) {
    process.stderr.write(`fake gws: unknown FAKE_GWS_FAIL kind ${failure}\n`)
    process.exit(5)
  }
  out({ error: entry[1] })
  process.exit(entry[0])
}

const flags = argv.findIndex((arg) => arg.startsWith("--"))
const method = (flags < 0 ? argv : argv.slice(0, flags)).at(-1)

// A download writes its file where --output names it, inside gws's working directory.
const output = argv.indexOf("--output")
if (output !== -1 && !argv.includes("--dry-run")) writeFileSync(argv[output + 1], "fake export\n")

if (argv.includes("--dry-run")) {
  out({ dryRun: true, method: "POST", url: `https://gmail.googleapis.com/fake/${method}`, body: { raw: "fake" } })
} else if (method === "send") {
  out({ id: "sent-fake-1", threadId: "thread-fake-1", labelIds: ["SENT"] })
} else if (method === "list") {
  out({ messages: [{ id: "m-fake-1" }, { id: "m-fake-2" }], resultSizeEstimate: 2 })
} else {
  out({ ok: true, method })
}
