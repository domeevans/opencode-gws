# Scripting

Unofficial plugin. Not affiliated with Google.

A script can call the gws tools with no model: a cron job, a shell script, or any program that can reach the OpenCode
server. It uses the tools RPC, `google-workspace.gws.tools`, through `opencode api` or an OpenCode client.

Every tool is a method, with the same name, input and output. A `gws_read` call and the `read` method with the same
input are the same call: the same policy, errors and permission checks. The commit tools are methods too, so a script
can plan and commit in one run.

| Method | The tool | Class |
| --- | --- | --- |
| `status` | `gws_status` | read |
| `catalog` | `gws_catalog` | read |
| `schema` | `gws_schema` | read |
| `read` | `gws_read` | read |
| `plan` | `gws_plan` | read |
| `write` | `gws_write` | write |
| `send` | `gws_send` | send |
| `share` | `gws_share` | send: it changes who can reach the file or document |
| `delete` | `gws_delete` | destructive |
| `export` | `gws_export` | export: it writes a local file |
| `admin` | `gws_admin` | destructive: it can remove data or access |
| `describe` | none: lists the methods with their classes, schemas, and permissions | – |

The class says the worst thing a method can do. It never decides whether a call runs: the rules do.

## A script runs as a session

Every call names a session, and the session must name an agent. The script runs as that agent: each call asserts the
same action and resource as the tool, against the agent's permission rules and the session's own.

**A write needs a prior explicit allow.** Before anything runs, the RPC resolves the method's action against the
agent's rules and then the session's, with the host's order (the last matching rule wins). Only an `allow` runs. An
`ask` is refused, because no one is there to answer the prompt, and a `deny` is refused. A refusal costs nothing: no
gws call, no credential, no prompt left waiting. So a script that writes, sends, shares, deletes, exports or runs an
admin operation needs a rule in config, or a Jobs run session that carries one.

A saved **Always allow** does not authorise an ad-hoc script. It is not part of the agent's or the session's rules, so
the resolve never sees it. That is deliberate: a script's permission must be reviewable in config. The supported way to
get an approval-bound grant is a Jobs one-off script (`jobs_run_script`), whose approval names the exact methods.

Create the session once, with the agent the script should run as, and keep its id:

```sh
opencode api post /api/session -d '{"title":"mail digest","agent":"build"}'
```

Session rules come after the agent's, so a session can narrow what its script may do, or opt one method in:

```sh
opencode api post /api/session -d '{"title":"label sorter","agent":"build","permissions":[
  {"action":"gws.*","resource":"*","effect":"deny"},
  {"action":"gws.read","resource":"*","effect":"allow"},
  {"action":"gws.plan","resource":"*","effect":"allow"},
  {"action":"gws.write","resource":"*","effect":"allow"}
]}'
```

Reads have no default ask rule, so most agents allow them already. The six commit actions ask by default in every
agent; a script needs the allow above, or the commit is refused.

Ask `describe` with the session to see what it may run:

```sh
opencode api post /api/rpc/google-workspace.gws.tools/describe \
  -H "x-opencode-directory:$PWD" -d '{"input":{"sessionID":"ses_…"}}'
```

Each method then carries `permission`: `allow`, `ask` or `deny`, resolved exactly as a call would be. Without a
session, the field is absent.

## The location

Run the command in the project whose agent you mean, and send the call to that location explicitly:

```sh
opencode api post /api/rpc/google-workspace.gws.tools/read \
  -H "x-opencode-directory:$PWD" -d '{"input":{"sessionID":"ses_…","input":{"operation":"users.get","params":{"userId":"me"}}}}'
```

Without it the call goes to the service's default location and fails `rpc.unavailable` if the plugin is not loaded
there. The HTTP equivalents are the `location[directory]` query parameter and the same header. `describe` reports the
`location` that answered and a `locationHint`.

A location unloads after OpenCode's idle timeout. If a scheduled script gets `rpc.unavailable` from a location that was
loaded before, send the call again once: the request loads the location. Jobs keeps its own location loaded.

## Calling a method

The body is `{"input": {"sessionID": "<session>", "input": <the tool's input>}}`:

```sh
opencode api post /api/rpc/google-workspace.gws.tools/read \
  -H "x-opencode-directory:$PWD" -d '{"input":{
  "sessionID":"ses_…",
  "input":{"operation":"gmail.users.messages.list","params":{"userId":"me","q":"after:1767225600 before:1767312000"},"fields":"messages(id),nextPageToken"}
}}'
```

A result is the tool's own output, as plain JSON. A read's `data` is the parsed JSON response, or a string when the call
returns text: a helper run with `format` `table`, `yaml` or `csv`, `gmail.triage` (a table unless `format` is `json`),
or `gmail.read` (text unless `format` is `json`). Workspace content in it is untrusted data.

## Plans and commits

`plan` returns a plan bound to the account, the session and its agent, as `gws_plan` does. A commit takes only
`{"planId": "…"}`, and is refused unless the session's agent allows that commit's action (`gws.write`, `gws.send`,
`gws.share`, `gws.delete`, `gws.export` or `gws.admin`). Plan and commit in the same run session: another session
cannot commit the plan (`PLAN_CALLER_MISMATCH`), and a plan is single-use.

## Errors

A refusal or failure is the RPC error `failed`, with `data: { code, next }` from the
[error table](configuration.md#errors): the tool's own codes, plus a few for scripts.

| Code | When |
| --- | --- |
| `SESSION_UNKNOWN` | OpenCode says the session does not exist in this location. Any other failure to look the session up is OpenCode's own error, passed through unchanged. |
| `SESSION_AGENT_REQUIRED` | The session names no agent, or the agent does not exist. |
| `PERMISSION_DENIED` | The agent's or the session's rules ask or deny the call. The message says which, and names an inner action when one is refused, such as a plan's read of an event's guests. |
| `CANCELLED` | The call was aborted. |

OpenCode itself answers `rpc.method_not_found` for a method that does not exist, and `rpc.invalid_input` for a bad
envelope, with one message per problem, in the wording every plugin's tools RPC uses:

| Case | Message |
| --- | --- |
| The envelope (the body's `input`) is not an object | `the envelope must be an object, such as {"sessionID":"<session>","input":<the tool's input>}` |
| An unknown key, such as `extra` | `"extra" is not allowed` |
| `sessionID` missing, not a string, or empty | `"sessionID" must be a non-empty string` |
| `input` missing | `"input" is missing` |
| `describe` given anything but nothing, `{}`, or `{"sessionID": "…"}` | `describe takes nothing, or {"sessionID":"<session>"}` |

The tool's own input is checked by the tool, as `GWS_VALIDATION_ERROR`.

`opencode api` exits with status 1 on any RPC error, and prints the error body, so a shell script can test `$?` and
read `data.code`.

## Audit

A script's reads and plans are audited like the tools', with `caller: "rpc"`. A commit is audited as the commit tool
audits it.
