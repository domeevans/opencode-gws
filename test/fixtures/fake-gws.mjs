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
 * - FAKE_GWS_RESPONSES, a JSON object keyed by method id (for example
 *   "gmail.users.messages.get"), answers that method with its value. A
 *   value of null fails the call with a 404 API error. A value
 *   {"$saved": {"name", "content", "mimeType"}} answers as gws does for a
 *   body that is not JSON: it writes the body to that file in its working
 *   directory and prints where.
 * - FAKE_GWS_MAILBOX, a JSON file holding a synthetic mailbox
 *   ({ emailAddress, historyId, historyStart?, messages, history }),
 *   answers getProfile, messages.list (newest first, after:<seconds> and
 *   the noise terms events_list sends), history.list (records after
 *   startHistoryId; one below historyStart is a 404) and messages.get (an
 *   unknown id is a 404) as Gmail does, with maxResults and pageToken. It
 *   is read on every call, so a test can deliver mail between calls.
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs"
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

// FAKE_GWS_MAILBOX: Gmail reads answered from a synthetic mailbox file, the way Gmail answers them.
if (process.env.FAKE_GWS_MAILBOX && !argv.includes("--dry-run") && argv[0] === "gmail" && argv[1] === "users") {
  const [answer, code] = mailbox(JSON.parse(readFileSync(process.env.FAKE_GWS_MAILBOX, "utf8")))
  // Exit only once stdout is written: a pipe on macOS is asynchronous.
  process.stdout.write(JSON.stringify(answer), () => process.exit(code))
  await new Promise(() => {})
}

/** One Gmail read against `box`: the answer and the exit code. */
function mailbox(box) {
  const at = argv.indexOf("--params")
  const params = at === -1 ? {} : JSON.parse(argv[at + 1])
  const notFound = [{ error: FAILURES.api[1] }, 1]
  const page = (items, key) => {
    const start = Number(params.pageToken ?? 0)
    const size = Number(params.maxResults ?? 100)
    const slice = items.slice(start, start + size)
    return { ...(slice.length > 0 ? { [key]: slice } : {}), ...(start + size < items.length ? { nextPageToken: String(start + size) } : {}) }
  }
  const call = argv.slice(2, argv.findIndex((arg) => arg.startsWith("--"))).join(".")
  if (call === "getProfile") return [{ emailAddress: box.emailAddress, historyId: box.historyId, messagesTotal: box.messages.length, threadsTotal: 0 }, 0]
  if (call === "messages.list") {
    // Gmail's search: after:<epoch seconds>, the noise terms events_list sends, spam and trash left out; newest first.
    const q = String(params.q ?? "")
    const after = /after:(\d+)/.exec(q)
    const hidden = new Set(["SPAM", "TRASH"])
    if (q.includes("-in:drafts")) hidden.add("DRAFT")
    if (q.includes("-category:promotions")) hidden.add("CATEGORY_PROMOTIONS")
    if (q.includes("-category:social")) hidden.add("CATEGORY_SOCIAL")
    const found = box.messages
      .filter((message) => !after || Number(message.internalDate) > Number(after[1]) * 1000)
      .filter((message) => !(message.labelIds ?? []).some((label) => hidden.has(label)))
      .sort((a, b) => Number(b.internalDate) - Number(a.internalDate))
      .map((message) => ({ id: message.id, threadId: message.threadId }))
    return [{ ...page(found, "messages"), resultSizeEstimate: found.length }, 0]
  }
  if (call === "history.list") {
    // Records after startHistoryId, oldest first; an id older than the mailbox keeps is a 404.
    const start = BigInt(params.startHistoryId)
    if (start < BigInt(box.historyStart ?? 0)) return notFound
    return [{ ...page(box.history.filter((record) => BigInt(record.id) > start), "history"), historyId: box.historyId }, 0]
  }
  if (call === "messages.get") {
    const message = box.messages.find((candidate) => candidate.id === params.id)
    return message ? [message, 0] : notFound
  }
  return [{ error: { code: 400, message: `the fake mailbox has no answer for gmail users ${call}` } }, 3]
}

const flags = argv.findIndex((arg) => arg.startsWith("--"))
const method = (flags < 0 ? argv : argv.slice(0, flags)).at(-1)

// A download writes its file where --output names it, inside gws's working directory.
const output = argv.indexOf("--output")
if (output !== -1 && !argv.includes("--dry-run")) writeFileSync(argv[output + 1], "fake export\n")

const responses = process.env.FAKE_GWS_RESPONSES ? JSON.parse(process.env.FAKE_GWS_RESPONSES) : {}
const id = (flags < 0 ? argv : argv.slice(0, flags)).join(".")

if (!argv.includes("--dry-run") && Object.hasOwn(responses, id)) {
  if (responses[id] === null) {
    out({ error: FAILURES.api[1] })
    process.exit(1)
  }
  const saved = responses[id]?.$saved
  if (saved) {
    writeFileSync(saved.name, saved.content)
    out({ bytes: Buffer.byteLength(saved.content), mimeType: saved.mimeType, saved_file: saved.name, status: "success" })
  } else out(responses[id])
} else if (argv.includes("--dry-run")) {
  out({ dryRun: true, method: "POST", url: `https://gmail.googleapis.com/fake/${method}`, body: { raw: "fake" } })
} else if (method === "send") {
  out({ id: "sent-fake-1", threadId: "thread-fake-1", labelIds: ["SENT"] })
} else if (method === "list") {
  out({ messages: [{ id: "m-fake-1" }, { id: "m-fake-2" }], resultSizeEstimate: 2 })
} else {
  out({ ok: true, method })
}
