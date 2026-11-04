# Status view, RPC, and commands

Unofficial plugin. Not affiliated with Google.

The TUI is one status dialog. It cannot approve or commit a plan. Neither can the RPC or the commands.

## Status dialog

The palette command **Google Workspace: Status**, or `/gws` in the prompt, opens one dialog. Nothing is always visible: the plugin adds no footer, sidebar or other slot. The dialog and `/gws-status` show the same rows, in this order:

| Row | Value |
| --- | --- |
| Connection | per account: `connected`, `sign-in required`, or `not configured` (a headless account whose environment variable is unset) |
| Account | the alias and how it signs in: OpenCode sign-in, credentials file, or access token |
| Access | `read-only` or `read and write`, then the client, services, and granted and missing scopes |
| Tools | the services whose gws tools the model sees |
| Agents without default rules | their names and the block to put first in each agent's own `permissions` |
| OpenCode | the version, then `(tested)`, or `(host untested; supported range >=2.2.3 <2.3.0)` |
| Next step | exactly one; `Nothing to do.` when nothing is needed |

The key hint reads `r refresh · esc close`. The dialog listens for server reconnects and integration, credential and agent changes only while it is open. It loads nothing while closed, and it reads only the `status` RPC.

## Commands

Each command posts a message and does not start a model turn.

| Command | What it posts |
| --- | --- |
| `/gws-status` | The status model: each account's mode, access, client source, granted and missing scopes, and next step; the Google Cloud steps for accounts that have no OAuth client yet; this session's pending plans, redacted (category, operation, account, preview, expiry; never argv, a body, or a token); agents that missed the ask rules, with the block to add in each agent's own permissions; and one next step. |
| `/gws-doctor` | One small read per enabled service per account. Reports `OK`, `AUTH_REQUIRED`, `AUTH_SCOPE_MISSING`, `ADMIN_PRIVILEGE_REQUIRED` (a valid sign-in without the admin privilege the service needs, with the next step), `API_DISABLED` (with the enable URL), `SKIPPED` (with the reason), or a denied `gws.read`. The summary counts every status but `OK` and `SKIPPED` as needing attention. |

`/gws-doctor` asks for `gws.read` on `<account>:<operation>` before each probe, the same way `gws_read` does. A refusal stops the run.

## RPC

Contract: `src/rpc.ts`, id `google-workspace.gws`, method `status` only. It is internal: the build inlines it into both `dist/index.js` and `dist/tui.js`, and the package exports only `.` and `./tui`.

`status` returns the fields every plugin's status RPC shares (`version`, `host`, `state`, `unguardedAgents`, `nextStep`), with the plugin's own beside them:

| Field | Meaning |
| --- | --- |
| `version` | This package's version. |
| `host` | `{ version, range, tested }`: the OpenCode version (`null` when unknown), the supported range `>=2.2.3 <2.3.0`, and `true` only for a tested release (2.2.3, 2.2.4, 2.2.5). |
| `state` | `sign_in_required` when an interactive account needs signing in, `not_configured` when a headless account's variable is unset, `host_untested` on an untested OpenCode, else `connected`. |
| `gws` | `{ path, version }` of the resolved binary. |
| `services` | Model-facing services. |
| `accounts` | One entry per account, below. |
| `auditDegraded` | Present when the audit sink has failed. Omitted means false. |
| `unguardedAgents` | Agents that missed the default ask rules, so a commit there runs without asking. |
| `permissionsBlock` | The JSON block to add first in each of those agents' own `permissions`. Present when `unguardedAgents` is not empty. |
| `nextStep` | The one thing to do next, as one sentence: an account's sign-in step, then the unguarded agents. `Nothing to do.` when nothing is needed. |

An account entry is `{ alias, mode, services, integrationID?, connected, needsAuth?, access?, clientSource?, grantedScopes?, missingScopes?, delegationRequired?, nextStep? }`. `delegationRequired` names the enabled services that need domain-wide delegation (Keep) when the interactive account's scopes do not add them; the dialog and `/gws-status` show it as **Needs domain-wide delegation**.

- `connected` is true when an interactive account is signed in and usable, or when a headless account's environment variable is set. `/gws-doctor` checks the headless credential itself.
- `needsAuth` is `true` or absent.
- `access` is the signed-in level, or the form's default before sign-in.
- `clientSource` is `account`, `plugin`, or `pasted` (entered in the sign-in form).
- An account's `nextStep` is one sentence, absent when nothing is needed.

The RPC cannot approve or commit. A commit happens only when the agent calls a commit tool and the permission prompt allows it.

Scripts call the tools through a separate RPC, `google-workspace.gws.tools`: see [Scripting](scripting.md).
