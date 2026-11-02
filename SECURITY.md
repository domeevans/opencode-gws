# Security policy

## Supported versions

Only the latest release is supported. Older versions are not patched, and this repository does not carry compatibility branches.

## Reporting a vulnerability

Use GitHub private vulnerability reporting on this repository (the Security tab). Do not open a public issue. Include:

- the package version and the OpenCode version;
- the smallest request or configuration that reproduces it;
- whether a scope, a policy boundary, or the binary check is involved.

Never include live tokens, refresh tokens, client secrets, or mailbox content. Fixes go into the newest release.

In scope: binary trust bypass; credential or environment isolation failure; a policy bypass (account, service, recipient, sharing, path); plan replay or category confusion; body or token leakage into audit, previews, or errors. Out of scope: vulnerabilities in `gws`, Google APIs, or OpenCode (report those upstream), and the behaviour of a rule the user deliberately set to allow.

## Data handling

| Boundary | Control |
| --- | --- |
| Packaged binary | Resolved from the platform package, not from `PATH`. Regular file, owner read and execute, no permission bits outside `0755`, SHA-256 from [native/provenance.json](https://github.com/joe-broadhead/opencode-gws/blob/HEAD/native/provenance.json), exact `gws 0.22.5`. |
| `binary.path` | Absolute path, `realpath`, regular executable, not group- or world-writable, outside the project, no world-writable ancestor, no ancestor writable by a foreign group. Exact version. No hash option. |
| Child environment | Google credential variables are cleared, then the plugin sets only the token or credentials file for this call. `HOME` and XDG paths are a private directory. Ambient gcloud application-default credentials are not a fallback. |
| Sign-in | Loopback redirect to `127.0.0.1`, PKCE S256, random state. Tokens and the client used at sign-in stay in OpenCode's credential store. The plugin writes no credential file. |
| OAuth client secret | A Google installed-app (Desktop) secret is non-confidential in Google's terms, so it may ship. Security rests on PKCE, the loopback redirect, and the user's consent, not on hiding that secret. |
| Local files | Uploads and attachments must be absolute regular files inside every applicable read root, capped at `maxUploadBytes`. Downloads must land inside every applicable write root, capped at `maxDownloadBytes`. A symlink is checked after resolution. |
| Process | `gws` is spawned with an argv array and `shell: false`. The model does not supply argv. Timeout and cancellation kill the process group. |
| Output | Separate stdout and stderr caps. Workspace content is untrusted data. |
| Audit | Operation, account, category, duration, outcome, and `caller: "rpc"` for a script's call. Never bodies, tokens, credentials, or file contents. |

Sign-in uses a Google installed-app (Desktop) client: your own, or one your organisation sets through `oauthClient`. No client ships with the plugin. The platform packages carry the unmodified Apache-2.0 `gws` binary; there is no `PATH` lookup and no download at runtime.

A cancellation after `gws` has started a mutation does not prove Google applied nothing. Read the current state before planning again.

## Permissions

OpenCode permissions are the outer gate. Plugin policy is the inner gate, and it can only deny.

Plugin tools are not prompted by the host per call. The plugin inserts default ask rules, then calls `ctx.permission.assert` itself. A `deny` on the tool's action hides the tool. An `ask` takes effect only when the tool asserts.

| Action | Asserted | Resource | Always, if a prompt is shown |
| --- | --- | --- | --- |
| `gws.status`, `gws.catalog` | every call | `*` | that resource |
| `gws.schema`, `gws.read`, `gws.plan` | after the operation resolves | `<account>:<operation>` | that resource |
| `gws.write`, `gws.export` | before the commit | `<account>:<operation>` | that exact resource |
| `gws.send`, `gws.share`, `gws.delete`, `gws.admin` | before the commit | `<account>:<operation>` | not offered |

Reads have no inserted ask rule, so a read does not prompt unless the user added one. The six commit actions have an inserted ask, so they prompt unless a later rule allows them. A later rule wins.

Saved Always applies to that exact resource across agents in the project, Plan included. A directory with no git commit belongs to the shared `global` project, so an Always saved there is not limited to one folder.

Do not put the plugin's ask block in the top-level `permissions`. Top-level rules apply after every agent's base rules and would loosen Explore. Put the block in the affected agent's own `permissions`. Every rule includes `resource`. A rule without it is skipped.

An agent defined only in the user's config does not receive the inserted rules. `/gws-status` and the status dialog name it; `gws_status` counts it.

A plugin deny is absolute. Rules match accounts, services, operations, and categories, and constrain recipients, public sharing, read and write roots, and page and item caps. They do not ask and cannot allow.

Deploy and watch are never committable. Admin needs `admin.enabled`, an allowed service, and a reason when required. The host ask is the human prompt for admin; policy does not add a second one.

## Scripts

The tools RPC (`google-workspace.gws.tools`, see [docs/scripting.md](https://github.com/joe-broadhead/opencode-gws/blob/HEAD/docs/scripting.md)) runs the plugin's non-commit tools for a script, with no model. It adds no authority:

- A script names a session that names an agent, and runs as them. Every call asserts the same action and resource as the tool, against that agent's rules and the session's own.
- An ask on a script's call is denied, not prompted: no one is there to answer it. A script needs an allow rule, or no rule, for what it does.
- Only `status`, `catalog`, `schema`, `read` and `plan` are methods. The six commit tools are never methods, whatever their exposure, so a script can plan but never commit; a plan binds to the session and agent, and only an approved commit tool in that session applies it.
- The RPC is reachable only by callers of the OpenCode server API, who already hold the server's full authority. The session is not a login: it scopes a script to what its agent may do.
- Audit records of a script's reads and plans carry `caller: "rpc"`.
