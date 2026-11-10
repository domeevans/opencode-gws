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
| Packaged binary | Downloaded from the plugin's GitHub Release on first use and checked against the release manifest and [native/provenance.json](https://github.com/joe-broadhead/opencode-gws/blob/HEAD/native/provenance.json), not taken from `PATH`. Regular file, owner read and execute, no permission bits outside `0755`, SHA-256 from [native/provenance.json](https://github.com/joe-broadhead/opencode-gws/blob/HEAD/native/provenance.json), exact `gws 0.22.5`. |
| `binary.path` | Absolute path, `realpath`, regular executable, not group- or world-writable, outside the project, no world-writable ancestor, no ancestor writable by a foreign group. Exact version. No hash option. |
| Child environment | Google credential variables are cleared, then the plugin sets only the token or credentials file for this call. `HOME` and XDG paths are a private directory. Ambient gcloud application-default credentials are not a fallback. |
| Sign-in | Loopback redirect to `127.0.0.1`, PKCE S256, random state, single use. A host-supplied `redirectUri` changes only where Google sends the browser: the listener still binds `127.0.0.1:<callbackPort>`, accepts only the redirect's path, and checks state and PKCE. A Desktop client with a non-loopback redirect, and a Web client that does not list the redirect, are refused before the browser opens. Tokens and the client used at sign-in stay in OpenCode's credential store. The plugin writes no credential file. |
| Default grant | With no `accounts` option, the `default` account's Read and write consent asks for every scope a Google sign-in can use, including the full mailbox (`https://mail.google.com/`) and Gmail settings and delegation. It never requests `cloud-platform`, and leaves out `admin-reports` and Model Armor. The grant does not stop a change: every change is a plan and a commit. Set `accounts`, `access: "read"`, or choose Read-only to grant less. App-only scopes and the Keep scopes, which Google grants only through domain-wide delegation, are never requested by an access level. |
| OAuth client secret | A Google installed-app (Desktop) secret is non-confidential in Google's terms, so it may ship. Security rests on PKCE, the loopback redirect, and the user's consent, not on hiding that secret. |
| Web client secret | A Web application client's secret is confidential. It lives only in OpenCode's credential store with the sign-in, or in `oauthClient`. It is never in the sign-in form, a status, a tool result, an RPC result, an error, or the audit, and token errors redact it. Agent tools must not be able to read it: give it to the sign-in through the host-filled form field rather than a config file an agent can open. |
| Local files | Uploads and attachments must be absolute regular files inside every applicable read root, capped at `maxUploadBytes`. Downloads must land inside every applicable write root, capped at `maxDownloadBytes`. A symlink is checked after resolution. A download outside the project also asserts OpenCode's own `external_directory` permission on its folder, so the host's rule for files outside the project decides whether it may land there. |
| Process | `gws` is spawned with an argv array and `shell: false`. The model does not supply argv. Timeout and cancellation kill the process group. |
| Output | Separate stdout and stderr caps. Workspace content is untrusted data. |
| Audit | Operation, account, category, duration, outcome, and `caller: "rpc"` for a script's call. Never bodies, tokens, credentials, or file contents. |

Sign-in uses a Google installed-app (Desktop) client, or a Web application client when the host supplies the redirect: your own, or one your organisation sets through `oauthClient`. No client ships with the plugin. The platform packages carry the unmodified Apache-2.0 `gws` binary; there is no `PATH` lookup and no download at runtime.

A cancellation after `gws` has started a mutation does not prove Google applied nothing. Read the current state before planning again.

## Permissions

**Every tool is allowed by default.** That means an agent, and a script, can read your mail and files, send mail from your account, change sharing, trash or delete a file, and run an admin operation, without a prompt. Each change still needs a plan first, and a commit is one call on a plan whose redacted preview you were shown, but no one is asked before that call runs.

The one-line restriction is the `access` option: `"ask-changes"` asks for each of the six commit actions, and `"read-only"` denies them while every read still runs. A per-action rule, such as `{ "action": "gws.delete", "resource": "*", "effect": "deny" }`, restricts one thing. See the README's Permissions section for the three values' blocks.

OpenCode permissions are the outer gate. Plugin policy is the inner gate, and it can only deny.

Plugin tools are not prompted by the host per call. The plugin inserts the default rules, then calls `ctx.permission.assert` itself. A `deny` on the tool's action hides the tool. An `ask` takes effect only when the tool asserts.

| Action | Asserted | Resource | Always, if a prompt is shown |
| --- | --- | --- | --- |
| `gws.status`, `gws.catalog` | every call | `*` | that resource |
| `gws.schema`, `gws.read`, `gws.plan` | after the operation resolves | `<account>:<operation>` | that resource |
| `gws.write`, `gws.export` | before the commit | `<account>:<operation>` | that exact resource |
| `gws.send`, `gws.share`, `gws.delete`, `gws.admin` | before the commit | `<account>:<operation>` | not offered |

Reads are always allowed by the inserted block, at every `access` value. The six commit actions follow the value: allowed at `all`, asking at `ask-changes`, denied at `read-only`. A later rule wins.

Saved Always applies to that exact resource across agents in the project, Plan included. A directory with no git commit belongs to the shared `global` project, so an Always saved there is not limited to one folder.

Do not put the plugin's block in the top-level `permissions`. Top-level rules apply after every agent's base rules and would loosen Explore. Put the block in the affected agent's own `permissions`. Every rule includes `resource`. A rule without it is skipped.

An agent defined only in the user's config does not receive the inserted rules. That matters only when `access` holds something back: `/gws-status` and the status dialog then name it, and `gws_status` counts it.

A plugin deny is absolute. Rules match accounts, services, operations, and categories, and constrain recipients, public sharing, read and write roots, and page and item caps. They do not ask and cannot allow.

Deploy and watch are never committable. Admin needs `admin.enabled`, an allowed service, and a reason when required. The host ask is the human prompt for admin; policy does not add a second one.

## Scripts

The tools RPC (`google-workspace.gws.tools`, see [docs/scripting.md](https://github.com/joe-broadhead/opencode-gws/blob/HEAD/docs/scripting.md)) runs the plugin's tools for a script, with no model. It adds no authority:

- A script names a session that names an agent, and runs as them. Every call resolves the method's action against that agent's rules and the session's own before anything runs, then the tool asserts the same action and resource as on the model path.
- Only a resolved `allow` runs. An `ask` is refused, because no one is there to answer it, and a `deny` is refused; both cost no gws call and no prompt. The default block allows every method, so a script runs each method unless a rule says otherwise.
- A saved **Always allow** does not authorise an ad-hoc script: it is not part of those rules. The supported way to get an approval-bound grant is a Jobs one-off script, whose approval names the exact methods.
- Only the read tools are methods: `status`, `catalog`, `schema`, `read`, `plan` and `events_list`. The six commit tools are not, and an unknown tool never is. So a script can plan a change but cannot commit it: a commit runs only from the model's approved commit tool, and a plan binds to the session and agent, so only a commit in that session applies it.
- The RPC is reachable only by callers of the OpenCode server API, who already hold the server's full authority. The session is not a login: it scopes a script to what its agent may do.
- Audit records of a script's reads and plans carry `caller: "rpc"`.
- `events_list` is how Memory's collector reads Gmail unattended. It is reads only: it asserts `gws.events_list`, then `gws.read` on each Gmail operation it runs (`getProfile`, `history.list`, `messages.list`, `messages.get`), each under the plugin's read policy and audit. Its events carry the senders' and recipients' addresses as `mailto:` ids and up to 4,096 characters of each message's own text, marked untrusted; the owner is the account's own address. A deny rule on `gws.events_list` stops it without stopping `gws_read`.
