# Scripting

Unofficial plugin. Not affiliated with Google.

A script can call the gws tools with no model: a cron job, a shell script, or any program that can reach the OpenCode server. It uses the tools RPC, `google-workspace.gws.tools`, through `opencode api` or an OpenCode client.

Each method is a tool with the same name, input and output: every tool except the six commit tools. A `gws_read` call and the `read` method with the same input are the same call: the same policy, errors and permission checks.

| Method | The tool |
| --- | --- |
| `status` | `gws_status` |
| `catalog` | `gws_catalog` |
| `schema` | `gws_schema` |
| `read` | `gws_read` |
| `plan` | `gws_plan` |
| `describe` | none: lists the methods, their permission actions, and their input and output as JSON Schema |

The commit tools are not methods. A script can plan a change but never commit it.

## A script runs as a session

Every call names a session, and the session must name an agent. The script runs as that agent: each call asserts the same action and resource as the tool, against the agent's permission rules and the session's own. So any agent that has the plugin can script it, with exactly the access it already has.

Create the session once, with the agent the script should run as, and keep its id:

```sh
opencode api post /api/session -d '{"title":"mail digest","agent":"build"}'
```

Session rules come after the agent's, so a session can narrow what its script may do:

```sh
opencode api post /api/session -d '{"title":"mail digest","agent":"build","permissions":[
  {"action":"gws.*","resource":"*","effect":"deny"},
  {"action":"gws.read","resource":"personal:gmail.users.messages.list","effect":"allow"}
]}'
```

No one answers a prompt for a script, so an `ask` on a script's call is denied with `PERMISSION_DENIED` instead of waiting. A script needs an allow rule, or no rule, for what it does. Reads have no default ask rule.

## Calling a method

The body is `{"input": {"sessionID": "<session>", "input": <the tool's input>}}`:

```sh
opencode api post /api/rpc/google-workspace.gws.tools/read -d '{"input":{
  "sessionID":"ses_…",
  "input":{"operation":"gmail.users.messages.list","params":{"userId":"me","q":"after:1767225600 before:1767312000"},"fields":"messages(id),nextPageToken"}
}}'
```

A result is `{"output": <the tool's output>}`, as plain JSON. Workspace content in it is untrusted data.

## Errors

A refusal or failure is the RPC error `failed`, with `data: { code, next }` from the [error table](configuration.md#errors): the tool's own codes, plus three for scripts.

| Code | When |
| --- | --- |
| `SESSION_UNKNOWN` | OpenCode says the session does not exist. Any other failure to look the session up is OpenCode's own error, passed through unchanged. |
| `SESSION_AGENT_REQUIRED` | The session names no agent. |
| `PERMISSION_DENIED` | The agent's or the session's rules deny the call, or ask for an approval. |

OpenCode itself answers `rpc.invalid_input` for a body without `sessionID` or `input`, and `rpc.method_not_found` for a method that does not exist, such as a commit tool.

## Plans

`plan` returns a plan bound to the session and its agent, as `gws_plan` does. Only the matching commit tool, called by the model in that session and approved there, applies it. A script cannot commit.

## Audit

A script's reads and plans are audited like the tools', with `caller: "rpc"`.
