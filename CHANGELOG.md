# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- Policy recipient rules no longer fail open. `allowedRecipientDomains`, `allowedRecipients`, `deniedRecipientDomains` and `allowExternalRecipients` now read every address in `to`, `cc` and `bcc`: comma- and semicolon-separated strings, `Name <address>`, quoted names and groups. They read the `To`, `Cc` and `Bcc` headers of a raw `gmail.users.messages.send`, and before the plan they read who a reply, reply-all, `gmail.users.drafts.send`, a notifying event change or a Drive permission update reaches. Calendar ACL scopes (by address, domain or rule id), Gmail delegates and forwarding addresses, Drive domain shares and the other share methods are read too. When a matching rule limits recipients and the plugin cannot tell who a send or share reaches, the plan is refused with the new code `RECIPIENTS_UNKNOWN`. A plan whose recipients were read is checked again at commit, and expires if someone was added.
- `allowExternalRecipients: false` now compares each recipient with the account's own domain, not with the first recipient, so a send only to outside addresses is refused. The domain is the new `accounts.<alias>.domains` option, or the signed-in address's domain, read with Gmail, Drive or Calendar; when neither is known the plan is refused with the new code `ACCOUNT_DOMAIN_UNKNOWN`.

### Added

- `accounts.<alias>.domains`: the account's own email domains, for `allowExternalRecipients`.

## [0.0.2] - 2026-11-03

### Fixed

- The default sign-in no longer requests the Keep scopes, which Google grants only through domain-wide delegation, so Google no longer refuses the whole consent with `invalid_scope`. No access level requests `keep` or `keep.readonly`, and the `default` account no longer enables Keep: Read and write now requests 45 scopes and Read-only 37. `gws_catalog` and `gws_schema` mark the 7 Keep methods `restriction: "domain-wide-delegation"` (app-only methods keep `appOnly` and gain `restriction: "app-only"`), and the scope check refuses them with that reason. For an interactive account that enables `keep` without adding a Keep scope in `accounts.<alias>.scopes`, status carries `delegationRequired`, the sign-in form says Keep needs delegation, and `/gws-doctor` reports Keep `SKIPPED` with the reason. (#8)
- A non-admin's Admin SDK refusal of a valid sign-in, such as the Reports API's 401 `Access denied. You are not authorized to read activity records.`, is now `ADMIN_PRIVILEGE_REQUIRED`, not `AUTH_REQUIRED`. Its next step is to sign in with a Workspace admin account that has the privilege (Reports for `admin-reports`) or to remove the service from `enabledServices`. Reads, plans, commits and `/gws-doctor` classify it the same way; it never marks the account as needing sign-in in status or `/connect`, and the doctor reports it as its own status, counted as needing attention. Token failures (`invalid_grant`, an expired or revoked token, `UNAUTHENTICATED`) stay `AUTH_REQUIRED`. (#9)
- The tools RPC reports `SESSION_UNKNOWN` only when OpenCode says the session does not exist (`Session.NotFoundError`, or a 404). Any other failure to look the session up now propagates unchanged instead of being reported as an unknown session.

## [0.0.1] - 2026-11-03

### Added

- Sign-in from a browser on another machine: the `redirectUri` and `callbackPort` options, and hidden form fields of the same names a host can fill per sign-in. The authorize URL and the token exchange carry the redirect, and the listener binds `127.0.0.1:<callbackPort>` and accepts only the redirect's path, with the same state and PKCE checks and single use. Without them, nothing changes.
- Google Web application clients, given as Google's downloaded client JSON in `oauthClient` or in the hidden **OAuth client JSON** form field. Before the browser opens, a Web client whose `redirect_uris` do not include the redirect, and a Desktop client with a non-loopback redirect, are refused with `AUTH_REDIRECT_MISMATCH`; a malformed redirect is `AUTH_REDIRECT_INVALID`. A Web client's secret is kept only in the credential store and never shown.
- `appOnly` on `gws_catalog` entries and `gws_schema` results: the 29 methods only a Chat app's or a Classroom add-on's own credentials can run (`chat.bot`, `chat.import`, `classroom.addons.*`). No access level requests those scopes, and the scope check refuses them with a next step that says no sign-in can run them.
- A `jelly` section in `package.json`: each tool with its permission, its default effect and whether it only reads, the skill ids, views. Jelly reads it without loading the plugin and applies the declared asks, because its agents have no base allow rule for this plugin's own default rules to follow. `docs/jelly.md` explains it.
- `title` and `signIns` in the `jelly` section: the name Jelly shows on the plugin's card, and what the plugin signs in to, so that one card can say whether each sign-in is connected and start, renew or end it. `docs/jelly.md` lists them.
- A Gmail thread view for Jelly, `views/gmail-thread.html`, shipped in the package.
- The tools RPC, `google-workspace.gws.tools`: scripts call `status`, `catalog`, `schema`, `read` and `plan` with no model, for example through `opencode api`. Each method runs that tool's own definition as a named session and its agent, with the same permission checks; an ask is denied, since no one can answer it. `describe` lists the methods with their JSON Schemas. The six commit tools are never methods.
- Error codes `SESSION_UNKNOWN`, `SESSION_AGENT_REQUIRED` and `PERMISSION_DENIED` for scripts.
- Audit records of a script's reads and plans carry `caller: "rpc"`.

### Changed

- Read-only sign-ins cover every read that accepts a read-only scope. The read sets add `drive.apps.readonly`, `calendar.acls.readonly`, `chat.customemojis.readonly`, `chat.users.availability.readonly`, `chat.users.readstate.readonly`, `chat.users.sections.readonly`, `classroom.courseworkmaterials.readonly`, `classroom.guardianlinks.students.readonly`, `classroom.rosters.readonly` and `classroom.topics.readonly`, so the Drive app list, calendar ACLs, Chat emoji, availability, read-state and section reads, and the Classroom roster, topic, material and guardian reads no longer need Read and write. A Read-only sign-in of every service requests 38 scopes.
- With no `accounts` option, the `default` account enables every manifest service at Read and write. Read and write now requests every scope a Google sign-in can use, Gmail settings, `https://mail.google.com/` (permanent delete), the Chat user scopes, the Classroom roster and coursework scopes, `drive.apps.readonly` and `cloud-platform` included: 46 scopes in one consent. Read-only is still in the form, and `enabledServices`, `access`, `services` and your own `accounts` narrow it as before.
- `admin.enabled` defaults to `true`. Admin plans still need an allowed service, a reason, the ask on `gws.admin`, and `gws_admin`; `admin.enabled: false` or `admin.allowedServices: []` refuses them. The Jelly declaration asks for `gws.admin` instead of denying it.
- The form's Read-only choice is labelled **Read-only**.
- `gws_read` is a direct tool instead of a pinned Code Mode tool, so a host can show each read's result. A Code Mode script can no longer call `tools.gws.read`; the model calls `gws_read` directly.

### Fixed

- People's read and write sign-ins request `directory.readonly` and `contacts.other.readonly`, both read-only, so `people.people.searchDirectoryPeople`, `people.people.listDirectoryPeople`, `people.otherContacts.list` and `people.otherContacts.search` no longer fail with `AUTH_SCOPE_MISSING`.
- Invalid helper input, such as `gmail.read` without `id`, is refused with `GWS_VALIDATION_ERROR` and the helper's next step before any permission check or `gws` run, instead of a raw zod error.

## [0.0.0] - 2026-11-01

### Added

- Google Workspace tools for OpenCode through the unmodified `gws` 0.22.5 CLI: `gws_status`, `gws_catalog`, `gws_schema`, `gws_read` and `gws_plan`, and the commit tools `gws_write`, `gws_send`, `gws_share`, `gws_delete`, `gws_export` and `gws_admin`. A change is a dry-run plan, then one commit the user approves.
- Sign-in from `/connect` with a Desktop app OAuth client, read-only by default, with the scopes shown before consent. Organisation config can set the client through `oauthClient`.
- Default ask rules for every commit category; reads do not prompt.
- `/gws-status`, `/gws-doctor`, and the TUI dialog **Google Workspace: Status** (`/gws`).
- The `gws` binary in per-platform packages for macOS (arm64, x64) and Linux (arm64, x64, glibc).
- Three skills: `opencode-gws`, `opencode-gws-recipes` and `opencode-gws-admin`.
