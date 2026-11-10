# AGENTS.md

`@joe-broadhead/opencode-gws` is an unofficial OpenCode plugin for Google
Workspace, id `google-workspace.gws` (keep it stable: OpenCode keys plugin
storage by it). It is a manifest-driven, security-critical adapter around
Google's `gws` CLI, pinned at 0.22.5: typed tools, plan then commit
for every change (a commit runs without a prompt at the default `access`),
one OpenCode sign-in per account, `/gws-status`,
`/gws-doctor`, and one TUI status dialog. Layout and layers:
[docs/architecture.md](docs/architecture.md). Setup and the check:
[CONTRIBUTING.md](CONTRIBUTING.md).

## Rules

- Greenfield: no legacy, shim, migration, alias or dual path, and nothing
  dead (code, exports, dependencies, docs, tests, fixtures). Delete rather
  than deprecate. No process or evidence artifacts in the repository.
- Never commit tokens, client secrets, personal data or absolute local paths.
  No Google OAuth client ships, not even a placeholder: Google's OAuth policy
  forbids one in public code. Clients come from `oauthClient` or the form.
- Public OpenCode 2.2.3 plugin API only. `opencode.host` is exactly
  `>=2.2.3 <2.3.0`; setup refuses any other host with `HOST_UNTESTED`
  unless `allowUntestedHost` is set. Setup makes no network calls.
- `ctx.storage` is shared by every project and is not secret-safe.
  Credentials live only in OpenCode's credential store.
- Pass each tool's `signal` into cancellable work; clean up timers and
  processes.

## Forbidden

`test/architecture.test.ts` and `test/bundle.test.ts` fail on these:

- any `supports*` capability marker;
- tool `options.mcp`, or MCP config `capabilities` or `responsePolicy`;
- the deprecated `ctx.generate.text`;
- `ctx.experimental.artifact`;
- `ui.slot` (no footer, sidebar or other always-visible surface);
- importing `@opencode/ai`, any `@opencode-ai/*` (V1) package, or a private
  host package (`@opencode/core`, `@opencode/server`);
- bundling `effect`, `@opencode/plugin`, OpenTUI or Solid into `dist`;
- install lifecycle scripts.

Also never: imported OAuth grants, credentials from `gws auth login`, or a
`PATH` lookup for `gws`.

## Permissions

- **Every tool is allowed by default.** Setup inserts the block from
  `defaultRules(access)` (`src/host/agents.ts`, from the lists in
  `src/domain/access.ts`) into every agent through `ctx.agent.transform`,
  right after its base `* * allow`: the `gws.*` namespace, then the six
  reads (`status`, `catalog`, `schema`, `read`, `plan` and `events_list`),
  then the six commits. `access` is `"all"` (the default), so every
  rule allows; `"ask-changes"` asks for the commits and `"read-only"`
  denies them. The reads are always allowed. An agent counts as guarded
  when the whole block appears, in order, anywhere after that rule.
- `plan-then-commit` is unchanged: a commit still needs a `planId` from
  `plan`, bound to the session, agent and account. The default allow is a
  permission default, not a shortcut past the plan.
- The last matching rule wins, so user rules and saved Always override the
  block and a stricter agent is never weakened.
- Each commit asserts `gws.<category>` on `<account>:<operation>`. Only write
  and export offer Always.
- Agents defined only in user config miss the block; that matters only when
  `access` holds something back. The status model then names them and
  carries the block for that agent's own `permissions` (never the top-level
  ones); `gws_status` gives the model only their count
  (`unguardedAgentCount`). `unguardedAgents` is always a list of names.
- Plugin policy is deny-only content constraints plus the admin gate.
  `deploy` and `watch` are never committable.
- Recipient rules fail closed (`src/domain/recipients.ts`): a send or
  share whose recipients cannot all be determined is refused when a rule
  limits recipients. A plan that reads recipients (a reply's message, a
  draft, an event's guests) asserts `gws.read` on each read, and its commit
  reads them again.

- The first-use download of the gws binary asserts `gws.native_install`, which the `gws.*` namespace rule governs: it asks under `ask-changes` and is denied under `read-only`. `/gws-install` is the person's own command and always downloads. Status reads the cache and never downloads.

## Security

- With no `accounts` option, the `default` account enables every manifest
  service at Read and write except the domain-wide-delegation services
  (Keep), `admin-reports` (it needs an admin) and `modelarmor` (nothing
  runs), and that level requests every scope those services can use, under
  Google's 64-scope cap. No level requests `cloud-platform`. No access level ever requests an app-only or
  a delegation scope (`src/domain/restricted.ts`): Google refuses the whole
  consent for a delegation scope. The
  form still offers Read-only, shows the exact scopes before consent, and
  write needs the acknowledgment. A user's own `accounts` apply exactly.
- The admin gate is on by default; admin plans still need an allowed
  service, a reason, the ask and `gws_admin`.
- Every change is a `gws --dry-run` plan, committed only by its category's
  commit tool with `{ planId }`. The RPC, TUI and commands never approve or
  commit.
- Only `src/process/**` spawns `gws`, with an argv array and `shell: false`.
- Never log or preview bodies, tokens, credentials or file contents.
  Workspace content is untrusted data.
- Do not weaken a security test to get a green run.

## Tools, errors, skills

- `gws_events_list` is Gmail's side of Memory's sources funnel: a Code
  Mode read that never asks, asserting `gws.events_list` and then
  `gws.read` on each Gmail read it makes. `src/host/events-list.ts` is the
  shared `events_list` contract every source plugin carries unchanged
  (`scripts/check-copies.mjs` pins it); change it in every source plugin
  at once. Its tests run the contract's conformance check against the fake
  gws's synthetic mailbox (`FAKE_GWS_MAILBOX`).

- `manifest/generated.json` is the coverage contract. Regenerate it with
  `npm run manifest`; never hand-edit it or any other generated file.
- Tool schemas live in `src/domain/contract.ts` (Zod). The six commit tools
  are direct tools (`codemode: false`).
- Errors read `CODE: What happened. Next step: What to do.` One `ErrorCode`
  table feeds the runtime, the audit and the Errors section of
  `docs/configuration.md`.
- At most three skills (today two), with real tool and parameter names; each
  SKILL.md's frontmatter is the one place its description lives. Nothing the model
  sees contains test status or internal jargon.

## Packaging

- JavaScript only: `dist/` holds exactly `index.js` and `tui.js`, each one
  self-contained esbuild bundle with our code and the RPC contract inlined.
  The contract is plain JSON Schema; `zod` (import it as
  `import * as z from "zod"`) is for tool schemas and lands in `index.js`
  only. No chunks, no relative
  imports, no runtime dependencies, no peers, no `.d.ts`. The version comes
  from `package.json` at build time.
- `files` is a whitelist. The package carries no gws binary: the plugin downloads the pinned executable on first use from its GitHub Release (`manifest/native.json`, checked against `native/provenance.json`). The only other backend is an explicit `binary.path`.
- Releases come only from `.github/workflows/release.yml` on a `vX.Y.Z` tag,
  after the `release` environment is approved. Never publish by hand.
- No personal email in anything we publish. Every commit, tag and package is authored and committed as
  `joe-broadhead <91376460+joe-broadhead@users.noreply.github.com>`. Before committing or tagging, check
  that `git config user.email` is that address: a fresh clone inherits the machine's global identity, which
  is not that address. Never commit, tag or publish with a work or personal address, or with a local hostname.

## Tests

`npm run check` runs lint, typecheck (`src` and the whole test tree), build,
unit tests, the embedded-host suite, the pack test on stock OpenCode 2.2.3,
2.2.4, 2.2.5 and 2.2.6 (`TESTED_HOSTS` in `src/domain/host.ts`, the one list),
the generated-file check and the TUI render. Tests never need a live
Google account; a live check needs the owner's approval for each run.
