# Configuration

Unofficial plugin. Not affiliated with Google.

Options are the plugin `options` object in `opencode.json` or `opencode.jsonc`. Unknown keys are rejected. Omit `options` (or `accounts`) and the plugin creates one interactive account, `default`, with every manifest service except Keep at `access: "write"`: one consent grants every scope a Google sign-in can use. Keep needs domain-wide delegation ([Keep](auth.md#keep-needs-domain-wide-delegation)), so no default sign-in requests its scopes. Set `accounts` to narrow it; your accounts then apply exactly as written, and an account without `access` is read-only.

An annotated file is in [examples/opencode.jsonc](../examples/opencode.jsonc).

## Accounts

`accounts` is a map of alias to profile. The alias is what the model passes when more than one account exists. `mode` may be omitted; an account is interactive unless it names a headless mode.

| Mode | Required | Meaning |
| --- | --- | --- |
| `interactive` | `enabledServices` | Run `/connect` and choose Google Workspace, or run `opencode auth login gws-<alias>`. |
| `credentials_file` | `enabledServices`, `credentialsFileEnv` | The named environment variable holds the path of a credentials file. Not a fallback. |
| `access_token` | `enabledServices`, `tokenEnv` | The named environment variable holds an access token. Not a fallback. |

`credentialsFileEnv` and `tokenEnv` are environment variable names. The values are read at run time and are never stored in config.

| Field | Default | Meaning |
| --- | --- | --- |
| `enabledServices` | every manifest service except `keep`, on the implicit `default` account only | Services this account may call. `reports` and `wf` canonicalize to `admin-reports` and `workflow`. |
| `access` | `"read"`; `"write"` on the implicit `default` account | `"read"`, `"write"`, or a per-service map such as `{ "drive": "write" }`. A service a map omits stays read-only. Interactive accounts only. |
| `scopes` | none | Extra scope URLs or short names, always shown at sign-in. Interactive accounts only. |
| `oauthClient` | none | `{ "clientId", "clientSecret" }` of a Desktop app client, or Google's downloaded client JSON (`{ "installed": … }` or `{ "web": … }`), for this account. Overrides the plugin client. Interactive accounts only. |
| `domains` | the domain of the signed-in address | The account's own email domains, such as `["example.com", "example.org"]`. A policy rule with `allowExternalRecipients: false` treats a recipient outside them as external. Any mode. |

An account whose config sets `access` to read, with no write service, does not offer write on the sign-in form. With no explicit `access`, the form defaults to read and still offers write, which needs the acknowledgment. The implicit `default` account defaults to write and still offers Read-only.

`account` on a tool call is optional when exactly one account is configured.

## Plugin options

| Option | Default | Meaning |
| --- | --- | --- |
| `services` | the union of every account's `enabledServices` | Limits what catalog, schema, read, and plan accept. A service here must be enabled by at least one account. It does not add tools. |
| `oauthClient` | none | `{ clientId, clientSecret }` of a Desktop app client, or Google's downloaded client JSON, usually set by organisation config. When set, the sign-in form hides its client fields and uses this client; a Web client's secret is never put in the form. An account `oauthClient` overrides it. See [auth.md](auth.md). |
| `redirectUri` | none: a loopback redirect | The absolute URL Google redirects to after consent, when the browser is not on the machine OpenCode runs on, such as `https://host.example/oauth/return`. `https`, unless it is loopback. Needs `callbackPort` and a Web application client that lists it exactly. See [auth.md](auth.md#sign-in-when-opencode-runs-on-another-machine). |
| `callbackPort` | none: a random port | The port on `127.0.0.1` where the sign-in listens and the redirect is forwarded. Alone, a loopback redirect on that port. |
| `binary.path` | the platform package | Absolute path to a `gws` 0.22.5 executable. See [backend.md](backend.md). |
| `allowUntestedHost` | `false` | Load a host outside `>=2.2.3 <2.3.0`, such as 2.2.2, 2.3.0, 3.0.0, a prerelease or a dev build, and show it as host untested in status. A release inside the range loads without it; only 2.2.3, 2.2.4 and 2.2.5 are tested. |
| `policy` | see below | Deny-only content constraints, plus the plan lifetime. |
| `execution` | see below | Timeouts, page caps, and file roots. |
| `audit` | JSONL in the state directory | Audit sink. |
| `skills` | all three skills enabled | `enabled`, `include`, `exclude`. Ids are `opencode-gws`, `opencode-gws-recipes`, and `opencode-gws-admin`. |
| `admin` | enabled, every admin service, reason required | The admin gate. See [admin.md](admin.md). |

## Policy

Policy rules are deny-only content constraints. They do not ask, and they cannot allow. A rule with no constraint denies whatever it matches. A rule with a constraint denies only when that constraint is violated. A deny is final (`POLICY_DENIED`, or `RECIPIENTS_UNKNOWN` and `ACCOUNT_DOMAIN_UNKNOWN` below).

| Key | Default | Meaning |
| --- | --- | --- |
| `planTtlSeconds` | `300` | A plan's lifetime: how long after `gws_plan` its commit tool accepts it. |
| `rules` | `[]` | Deny rules. Each needs `id` and `"effect": "deny"`. |

A rule may match `categories`, `accounts`, `services`, and `operations` (wildcards). It may set `allowedRecipientDomains`, `allowedRecipients`, `deniedRecipientDomains`, `allowExternalRecipients`, `allowPublicSharing`, `allowedReadRoots`, `allowedWriteRoots`, `maxPages`, and `maxItems`.

```jsonc
{
  "policy": {
    "rules": [
      {
        "id": "work-recipients",
        "effect": "deny",
        "categories": ["send", "share"],
        "accounts": ["work"],
        "allowedRecipientDomains": ["example.com"]
      }
    ]
  }
}
```

### Recipients

The recipient constraints (`allowedRecipientDomains`, `allowedRecipients`, `deniedRecipientDomains`, `allowExternalRecipients: false`) check everyone a send or share reaches:

- Every address in `to`, `cc` and `bcc`, whether a list, a comma- or semicolon-separated string, `Name <address>`, or a group.
- The `To`, `Cc` and `Bcc` headers of a raw message (`gmail.users.messages.send`).
- What the request does not carry, read before the plan: the sender (or `Reply-To`) of the message a reply answers, and for reply-all its other recipients; a draft's stored recipients (`gmail.users.drafts.send`); an event's guests for a notifying change; a Drive permission's grantee. Each read needs `gws.read` on that method, and the commit reads them again: a plan whose recipients changed expires.
- A domain share (a Drive or Calendar ACL for a whole domain) counts as `*@<domain>`.

The check fails closed. When a matching rule limits recipients and the plugin cannot tell who the call reaches, the plan is refused with `RECIPIENTS_UNKNOWN`: a raw message without readable headers, a read that failed, an address it cannot read (such as a quoted local part), or a method whose recipients it does not know (Chat messages, Drive approvals). Scope such rules with `services` or `operations` when that is too broad. A share that only removes access reaches no one new.

"External" means outside the account's own domains: `accounts.<alias>.domains`, or else the domain of the signed-in address, which the plugin reads with Gmail, Drive or Calendar. A subdomain is a different domain. When neither is available the plan is refused with `ACCOUNT_DOMAIN_UNKNOWN`.

Deploy and watch are never committable, whatever a rule says. Admin is the admin gate, not a policy allow. See [admin.md](admin.md).

A Calendar event write (`insert`, `patch`, `update`, `move`, `quickAdd`) becomes `send` when it emails guests: `params.sendUpdates` is anything but `none`, or the deprecated `params.sendNotifications` is anything but `false`. A notifying `calendar.events.delete` stays `delete`, which asks every time and never offers Always. Calendar ACL changes, which notify by default, are already `share`. Drive `files.update` with `body.trashed` true becomes `delete`, including when the same body also renames the file. Commit with the plan's category, not the manifest category.

## Approvals

The model is default ask rules through `ctx.agent.transform`. Setup inserts these rules immediately after each agent's base `{ "action": "*", "resource": "*", "effect": "allow" }` rule. An agent without that rule gets none, so its default deny stays a deny:

```json
{ "action": "gws.write", "resource": "*", "effect": "ask" }
{ "action": "gws.export", "resource": "*", "effect": "ask" }
{ "action": "gws.send", "resource": "*", "effect": "ask" }
{ "action": "gws.share", "resource": "*", "effect": "ask" }
{ "action": "gws.delete", "resource": "*", "effect": "ask" }
{ "action": "gws.admin", "resource": "*", "effect": "ask" }
```

Reads (`gws.status`, `gws.catalog`, `gws.schema`, `gws.read`, `gws.plan`) have no rule, so they do not prompt. A later rule wins, so a user's `permissions` rules and a saved Always override the asks, and a stricter agent is not weakened.

Write and export offer Always for that exact `<account>:<operation>`. Send, share, and delete pass no save patterns, so they never offer Always and ask every time unless a user rule allows them. Admin asks every time the same way.

`opencode run` cannot answer an ask. To let a commit run there, add a user allow rule, for example `{ "action": "gws.write", "resource": "work:*", "effect": "allow" }`. A user `deny` hides that tool. A Plan-style or custom deny such as `{ "action": "gws.*", "resource": "*", "effect": "deny" }` still wins, because it is later than the inserted ask.

An agent defined only in the user's config is created after plugins run, so it misses the inserted rules. `/gws-status` and the status dialog name those agents and give the block to add first in **that agent's own** `permissions`, followed by any rules already set for gws tools in the top-level `permissions`. Do not put the block in the top-level `permissions`: those rules apply after every agent's base rules and would loosen Explore.

`gws_status` gives the model only the count and points to `/gws-status`.

Saved Always is stored by OpenCode for that exact resource. It applies across agents in the project, Plan included. A directory with no git commit belongs to the shared `global` project, so an Always saved there is not limited to one folder.

Plugin `policy` rules can only deny. They constrain recipients, public sharing, read and write roots, and page and item caps. They do not ask. Deploy and watch are never committable. Admin still needs `admin.enabled`, an allowed service, and a reason when `admin.requireReason` is set; the host ask is the human prompt.

Every permission rule in this document includes `resource`. A rule without it is skipped.

## Admin

| Key | Default | Meaning |
| --- | --- | --- |
| `admin.enabled` | `true` | Master switch for admin planning. Set `false` to refuse every admin plan. |
| `admin.requireReason` | `true` | Require a non-empty `reason` on admin plans. |
| `admin.allowedServices` | every service with an admin-class manifest entry | Allowlist. An explicit empty array denies every admin operation. |

Details are in [admin.md](admin.md).

## Execution

| Key | Default |
| --- | --- |
| `timeoutMs` | `120000` |
| `schemaTimeoutMs` | `15000` |
| `maxPages` | `10` |
| `maxItems` | `1000` |
| `pageDelayMs` | `100` |
| `maxStdoutBytes` | 5 MiB |
| `maxStderrBytes` | 1 MiB |
| `maxInlineBytes` | 256 KiB |
| `maxUploadBytes` | 25 MiB |
| `maxDownloadBytes` | 100 MiB |
| `allowedReadRoots` | `[]` (no root restriction) |
| `allowedWriteRoots` | `[]` (no root restriction) |

Requested pagination is clamped to these caps and to any matching policy rule. Agent input cannot raise them. `response.maxInlineBytes` can only lower the inline cap for one read. Roots are checked on the requested path and again on its resolved location, so a symlink cannot leave them. A root must be an absolute path.

## Audit

```jsonc
{ "audit": { "enabled": true, "sink": "jsonl" } }
```

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Write audit records. |
| `sink` | `"jsonl"` | `"jsonl"` or `"stderr"`. |
| `path` | `<stateDir>/audit.jsonl` | Absolute path of the JSONL file, when `sink` is `jsonl`. |

The state directory is `$XDG_STATE_HOME/opencode-gws` when that variable is an absolute path, otherwise `~/Library/Application Support/opencode-gws` on macOS and `~/.local/state/opencode-gws` elsewhere. The file is capped at 5 MiB: a write that would pass the cap first moves it to `audit.jsonl.1`, replacing the previous one, so the log takes at most about 10 MiB. Every start writes one `plugin.loaded` record. Records contain the operation, account, category, duration, and outcome, and `caller: "rpc"` for a read or plan a script made through the [tools RPC](scripting.md). They do not contain bodies, tokens, credentials, or file contents.

A sink failure does not turn a completed operation into an error. Status keeps `auditDegraded: true` for that process. Do not retry a successful operation to obtain a record.

## Skills

```jsonc
{ "skills": { "enabled": true, "include": [], "exclude": ["opencode-gws-admin"] } }
```

| Id | Loaded automatically |
| --- | --- |
| `opencode-gws` | yes |
| `opencode-gws-recipes` | yes |
| `opencode-gws-admin` | no |

`include`, when non-empty, is the only set registered. `exclude` removes ids from that set. Service detail comes from `gws_catalog` and `gws_schema`, not from a skill per service.

## Binary

`binary.path` is an optional absolute path to a `gws` 0.22.5 executable outside the project directory. Without it, the plugin uses the platform package. See [backend.md](backend.md).

## Errors

<!-- generated:errors -->

Generated from `src/domain/errors.ts` by `npm run docs:coverage`. Do not edit this section by hand.

Every plugin error reads `CODE: What happened. Next step: What to do.` A tool error reaches the model with the metadata `{ code, next, enableUrl? }`. A raise site may give a more specific next step than the one in this table. Host permission errors are not in this table; they propagate unchanged.

| Code | Meaning | Next step |
| --- | --- | --- |
| `ACCOUNT_REQUIRED` | More than one account is configured and the call named none. | Pass account with one of the configured aliases; gws_status lists them. |
| `ACCOUNT_UNKNOWN` | The account alias is not configured. | Pass a configured alias; gws_status lists them. |
| `OPERATION_UNKNOWN` | The operation id is not in the gws manifest. | Find the exact method or helper id with gws_catalog, then retry. |
| `HELPER_UNSUPPORTED` | The helper is in the catalog but cannot run. | Use the Discovery method gws_catalog names as the helper's alternative. |
| `GWS_VALIDATION_ERROR` | The request is malformed: a schema violation, a field helpers do not take, a missing field mask on list or search, a relative path, a download on gws_read, or arguments gws rejected. | Fix the request as the message says; gws_schema shows the parameters and request body. |
| `POLICY_DENIED` | Plugin policy refused the call: the category, the service, recipients, public sharing, the admin gate, or a path outside the allowed roots. A deny is final. | Do not work around it. If the message says to use gws_plan, plan the change; otherwise tell the user, who can change the plugin policy. |
| `RECIPIENTS_UNKNOWN` | A policy rule limits recipients, and the plugin could not tell who this send or share reaches: a raw message without readable To, Cc or Bcc headers, a draft, message or event it could not read, a draft that names no recipient, or a method whose recipients it does not know. Nothing ran. | Name the recipients in the request (to, cc and bcc, or the To, Cc and Bcc headers of raw), or tell the user the policy rule refuses this method. |
| `ACCOUNT_DOMAIN_UNKNOWN` | A policy rule sets allowExternalRecipients to false, and the account's own email domain is unknown: accounts.<alias>.domains is unset and the signed-in address could not be read. Nothing ran. | Ask the user to set accounts.<alias>.domains to the account's email domains, or to enable Gmail, Drive or Calendar for the account so the plugin can read its address. |
| `PLAN_NOT_FOUND` | No plan has this planId: it never existed, or its time limit passed and it was removed. | Create a plan with gws_plan, then commit its planId. |
| `PLAN_ALREADY_USED` | The plan was committed, or is being committed. Plans are single-use. | Check the result of the earlier commit with gws_read before planning the change again. |
| `PLAN_EXPIRED` | The plan's time limit passed, or a failed commit expired it. | Check the current state with gws_read, then plan again and show the new preview. |
| `PLAN_CALLER_MISMATCH` | Another session, agent, or account created the plan. | Plan again from the session and agent that will commit it. |
| `CATEGORY_MISMATCH` | The commit tool does not match the plan's category. | Commit with the tool named by the plan's category. |
| `SESSION_UNKNOWN` | A script named a session that does not exist. A script runs as a session, under that session's agent and its permission rules. | Create a session that names an agent, such as POST /api/session with {"agent":"build"}, and pass its id. |
| `SESSION_AGENT_REQUIRED` | A script named a session that names no agent. A script runs as its session's agent, so its permissions and plans never depend on the default agent. | Create a session that names an agent, such as POST /api/session with {"agent":"build"}, and pass its id. |
| `PERMISSION_DENIED` | The permission rules of the session's agent deny the call, or ask for an approval that a script cannot give, so the call did not run. | Add an allow rule for the tool to the session's agent or to the session, or use a session whose agent allows it. |
| `AUTH_REQUIRED` | The account is not signed in, its sign-in expired or was revoked, or a headless credential variable is unset. A call that fails this way before gws runs changes nothing. | Ask the user to sign in as the message says, then retry. |
| `AUTH_SCOPE_MISSING` | The sign-in has not granted a scope this operation needs. The plugin checks before gws runs, so nothing ran. | Ask the user to sign in again with the access the message names, or to add the scope to the account's scopes, then retry. For a method only an app's credentials can run, use another method. |
| `ADMIN_PRIVILEGE_REQUIRED` | The sign-in is valid, but an Admin SDK service (admin-reports) refused the call because the account lacks a Workspace admin privilege the API needs, such as Reports. Signing in again as the same account does not help, and the sign-in is not marked as needing renewal. Another service's refusal is never this code. | Ask the user to sign in with a Workspace admin account that has the needed privilege (Reports for admin-reports), or to remove the service from enabledServices. |
| `AUTH_CLIENT_REQUIRED` | No OAuth client is configured for the sign-in, none was entered in the form, and no earlier sign-in has one. | Run /connect and choose Google Workspace, then enter your Desktop OAuth client ID and secret, or ask your administrator. |
| `AUTH_CLIENT_INVALID` | The sign-in form has only one of the client ID and secret, a value in the wrong format, or a client JSON that is not Google's downloaded client JSON. | Enter both the client ID and the secret of the same Desktop app OAuth client; /gws-status lists the steps. |
| `AUTH_REDIRECT_INVALID` | The sign-in's redirectUri is not an absolute https (or loopback http) URL, or callbackPort is missing or not a port. | Set redirectUri to an absolute https URL and callbackPort to a port from 1 to 65535, or leave both unset for a loopback redirect. |
| `AUTH_REDIRECT_MISMATCH` | Google would refuse the redirect for this client: a Desktop app client accepts only a loopback redirect, and a Web application client accepts only a redirect URI registered on it, exactly. Nothing was opened in the browser. | Use a Web application client that lists the redirect, as its downloaded client JSON, or leave redirectUri unset for a Desktop app client. |
| `AUTH_WRITE_UNCONFIRMED` | Read and write access was chosen in the sign-in form without confirming the write scopes. | Sign in again and confirm the write scopes, or choose Read-only. |
| `API_DISABLED` | The Google API is not enabled in the Google Cloud project of the OAuth client. | Ask the user to enable the API in the Google Cloud console, wait about a minute, and retry. |
| `GWS_API_ERROR` | Google returned an error; the message carries Google's text. | Fix the ids or parameters once from the message; if it fails again, report it. |
| `GWS_DISCOVERY_ERROR` | gws could not load the API description (the Discovery document) it builds requests from. | Check that this machine can reach www.googleapis.com, then retry. |
| `GWS_INTERNAL_ERROR` | gws failed unexpectedly. | Retry once; if it fails again, report the message. |
| `TIMEOUT` | gws did not finish within execution.timeoutMs. | Narrow the request with fields, a smaller page size, maxPages, or maxItems, then retry. |
| `OUTPUT_LIMIT` | gws output exceeded execution.maxStdoutBytes or execution.maxStderrBytes. | Narrow the request with fields, a smaller page size, maxPages, or maxItems, then retry. |
| `CANCELLED` | The call was cancelled and the gws process stopped. A commit stopped while gws ran may or may not have been applied. | Do not retry unless the user asks; check the state with gws_read before planning again. |
| `SCHEMA_INVALID` | gws schema returned no usable JSON. | Retry once; if it fails again, report the message. |
| `SCHEMA_NOT_FOUND` | gws schema does not know this method. | Check the operation id with gws_catalog. |
| `UPLOAD_INVALID` | An upload or attachment path is not absolute, does not exist, or is not a regular file. | Use the absolute path of an existing regular file. |
| `UPLOAD_LIMIT` | The upload is larger than execution.maxUploadBytes. | Use a smaller file, or ask the user to raise execution.maxUploadBytes. |
| `UPLOAD_CHANGED` | An upload or attachment changed between the plan and the commit, so the plan expired. | Plan again and show the new preview. |
| `DOWNLOAD_EXISTS` | The download destination exists and download.overwrite is not true. | Choose another path, or plan again with download.overwrite set to true after the user agrees. |
| `DOWNLOAD_INVALID` | The destination is not absolute, its directory does not exist, it is a directory, or gws wrote no file. | Fix the destination path; if gws wrote no file, report it. |
| `DOWNLOAD_LIMIT` | The download is larger than execution.maxDownloadBytes; nothing was written to the destination. | Tell the user; they can raise execution.maxDownloadBytes. The plan is used up. |
| `HOST_UNTESTED` | The OpenCode version is outside the supported range in package.json opencode.host (>=2.2.3 <2.3.0). | Use OpenCode 2.2.3, 2.2.4 or 2.2.5 (tested) or another release in the range, or set allowUntestedHost to true to run anyway; status then shows the host as untested. |
| `OPTIONS_INVALID` | The plugin options are not valid: an unknown key, a wrong type, an unknown service, or access or scopes that name something the account does not enable. | Fix the plugin options in opencode.json; the message names the option. |
| `STATUS_UNAVAILABLE` | The status could not be read from the plugin. | Run /gws-status in a session for the details. |
| `SKILLS_INVALID` | A skill file that ships with the plugin is missing or unreadable. | Reinstall the plugin. |
| `GWS_UNAVAILABLE` | No gws binary is available: this platform has no gws package, the package is not installed, or binary.path does not exist. | Reinstall the plugin so npm installs the gws package for this platform, or set binary.path to a gws 0.22.5 executable. |
| `GWS_NOT_FOUND` | The packaged gws binary is missing. | Reinstall the plugin. |
| `GWS_UNSUPPORTED_PLATFORM` | The packaged gws binary does not support this platform. | Set binary.path to a gws 0.22.5 executable for this platform. |
| `GWS_VERSION_MISMATCH` | The gws version check failed, or gws is not the version the manifest was generated from. | Reinstall the plugin, or point binary.path at gws 0.22.5. |
| `BINARY_TRUST_FAILED` | The gws binary failed a trust check: a relative path, not a regular file, group- or world-writable, inside the project, a writable ancestor, or a checksum mismatch. | Reinstall the plugin, or move the binary.path executable to a location only you can write. |

<!-- /generated:errors -->
