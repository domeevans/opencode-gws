# Scripting

Unofficial plugin. Not affiliated with Google.

A script can call the gws tools with no model: a cron job, a shell script, or any program that can reach the OpenCode
server. It uses the tools RPC, `google-workspace.gws.tools`, through `opencode api` or an OpenCode client.

Each read tool is a method, with the same name, input and output. A `gws_read` call and the `read` method with the same
input are the same call: the same policy, errors and permission checks. The six commit tools are not methods, unless
the host turns on [`rpcCommits`](configuration.md#plugin-options) because it confirms changes itself. Without it, a script
can plan a change, but only the model's approved commit tool runs the plan, so a script never commits on its own.

| Method | The tool |
| --- | --- |
| `status` | `gws_status` |
| `catalog` | `gws_catalog` |
| `schema` | `gws_schema` |
| `read` | `gws_read` |
| `plan` | `gws_plan` |
| `events_list` | Code Mode only: the Gmail messages since a cursor, as Memory's events ([configuration.md](configuration.md#events-list)) |
| `write`, `send`, `share`, `delete`, `export`, `admin` | Only with `rpcCommits`: `gws_write`, `gws_send`, `gws_share`, `gws_delete`, `gws_export` and `gws_admin`, each taking only `{ planId }` ([Plans and commits](#plans-and-commits)) |
| `describe` | none: lists the methods with their class and their input and output as JSON Schema; with `sessionID`, each method also reports its resolved `permission` |

## A script runs as a session

Every call names a session, and the session must name an agent. The script runs as that agent: each call asserts the
same action and resource as the tool, against the agent's permission rules and the session's own.

**A rule decides, before anything runs.** The RPC resolves the method's action against the agent's rules and then the
session's, with the host's order (the last matching rule wins). Only an `allow` runs. An `ask` is refused, because no
one is there to answer the prompt, and a `deny` is refused. A refusal costs nothing: no gws call, no credential, no
prompt left waiting.

A script gets the same default as the model: every method is allowed, because the agent's block allows the reads. A rule
on the agent or the session can still deny a method, and a denied method is refused before anything runs. Without
`rpcCommits` a script never commits a plan, so the plugin's `access` option restricts the model's commits, not the
script's calls. With it, `access` decides the script's commits too: allowed at `"all"`, refused at `"ask-changes"`
(the ask has no one to answer it) and at `"read-only"`.

A saved **Always allow** does not authorise an ad-hoc script. It is not part of the agent's or the session's rules, so
the resolve never sees it. That is deliberate: a script's permission must be reviewable in config. The supported way to
get an approval-bound grant is a Jobs one-off script (`jobs_run_script`), whose approval names the exact methods.

Create the session once, with the agent the script should run as, and keep its id. Give the project as the session's `location`: a session made without one belongs to the service's default location, where the project's agents may not exist, and each call then fails `Agent not found`:

```sh
opencode api post /api/session -d '{"title":"mail digest","agent":"build","location":{"directory":"/path/to/project"}}'
```

Session rules come after the agent's, so a session can narrow what its script may do, or opt one method in:

```sh
opencode api post /api/session -d '{"title":"label sorter","agent":"build","location":{"directory":"/path/to/project"},"permissions":[
  {"action":"gws.*","resource":"*","effect":"deny"},
  {"action":"gws.read","resource":"*","effect":"allow"},
  {"action":"gws.plan","resource":"*","effect":"allow"}
]}'
```

The reads and `plan` are always allowed by the plugin's block, whatever `access` is. The six commit actions follow
`access` for the model's commits: allowed by default, asking at `ask-changes`, denied at `read-only`. The session above
denies the namespace and opts the reads and `plan` back in, so the script can look and plan, and nothing else.

Ask `describe` for the methods, with their classes and schemas, and with the session each method's permission:

```sh
opencode api post /api/rpc/google-workspace.gws.tools/describe \
  -H "x-opencode-directory:$PWD" -d '{"input":{"sessionID":"ses_…"}}'
```

`describe` takes nothing, or `{"sessionID": "…"}`. Each call is resolved against its session's agent when it runs, so a refusal names the rule.

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

`plan` returns a plan bound to the account, the session and its agent, as `gws_plan` does. By default a script cannot
commit it: the six commit tools are not methods, and calling one answers `rpc.method_not_found`. The model commits the
plan with its approved commit tool (`gws_write`, `gws_send`, `gws_share`, `gws_delete`, `gws_export` or `gws_admin`),
which asserts that commit's action, and at `access: "ask-changes"` OpenCode asks the person first. An export whose
destination is outside the project also asserts OpenCode's own `external_directory`, so a session that asks for that
folder refuses the export (`DOWNLOAD_NOT_PERMITTED`) before gws runs. A plan is single-use and bound to its session:
another session cannot commit it (`PLAN_CALLER_MISMATCH`).

### Committing from a script: `rpcCommits`

A host that shows its own confirmation for each change, before it calls the RPC, can set the plugin option
`"rpcCommits": true`. The six commit tools are then methods too, named by category, with the classes `describe` reports:
`write` (write), `send` and `share` (send), `delete` and `admin` (destructive), and `export` (export). Each takes only
`{ planId }` and runs the commit tool's own spec, so nothing about a plan changes:

- the plan must come from `plan` in the same session, with the same agent and account (`PLAN_CALLER_MISMATCH`);
- it commits once (`PLAN_ALREADY_USED`), and only through its own category's method (`CATEGORY_MISMATCH`, which leaves
  the plan ready for the right one);
- the method's action (`gws.send`, …) is resolved like any other, so at `access: "ask-changes"` a commit is refused with
  `PERMISSION_DENIED` and no gws call, and at `"read-only"` it is denied;
- a reply, a draft or an event's guests are read again at the commit, as on the model path.

The plugin asks no one before such a commit: the host's confirmation is the only one. Leave the option off unless the
host gives one.

```sh
opencode api post /api/rpc/google-workspace.gws.tools/plan \
  -H "x-opencode-directory:$PWD" -d '{"input":{"sessionID":"ses_…","input":{"operation":"gmail.reply","input":{"messageId":"…","body":"Thanks."}}}}'
opencode api post /api/rpc/google-workspace.gws.tools/send \
  -H "x-opencode-directory:$PWD" -d '{"input":{"sessionID":"ses_…","input":{"planId":"<the planId plan returned>"}}}'
```

## Errors

A refusal or failure is the RPC error `failed`, with `data: { code, next }` from the
[error table](configuration.md#errors): the tool's own codes, plus a few for scripts.

| Code | When |
| --- | --- |
| `SESSION_UNKNOWN` | OpenCode says the session does not exist in this location. Any other failure to look the session up is OpenCode's own error, passed through unchanged. |
| `SESSION_AGENT_REQUIRED` | The session names no agent, or the agent does not exist. |
| `PERMISSION_DENIED` | The agent's or the session's rules ask or deny the call. The message says which, and names an inner action when one is refused, such as a plan's read of an event's guests. |
| `CANCELLED` | The call was aborted. |

A commit method, with `rpcCommits`, adds the plan's own codes: `PLAN_NOT_FOUND`, `PLAN_EXPIRED`, `PLAN_ALREADY_USED`,
`PLAN_CALLER_MISMATCH` and `CATEGORY_MISMATCH`.

OpenCode itself answers `rpc.method_not_found` for a method that does not exist (a commit method too, without
`rpcCommits`), and `rpc.invalid_input` for a bad
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

A script's reads, plans and commits are audited like the tools', with `caller: "rpc"`.
