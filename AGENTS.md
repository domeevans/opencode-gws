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
  `>=2.2.3 <2.4.0`; setup refuses any other host with `HOST_UNTESTED`
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
- The tools RPC's methods are the six read tools and the source contract's
  three reads (`probe`, `calendar_today`, `images_read`, each with its own
  `gws.<name>` read action). The `rpcCommits` option, off
  by default, makes the six commits methods too (`write`, `send`, `share`,
  `delete`, `export`, `admin`), for a host that confirms each change
  itself. Then a script whose session resolves the commit's action to
  `allow` can commit a `planId` from `plan`; plan-then-commit still holds,
  and `access` and agent and session rules still decide (an `ask` is
  refused, a `deny` is refused, and a later allow on the agent or session
  wins over the block). Status shows the flag (`rpcCommits`, the
  **Script commits** row, which names the agents without the default
  rules). It trusts every caller of the OpenCode server, who can choose a
  session's agent and rules; plans bind to a session, not to script or
  model.
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
  write needs the acknowledgment. A user's own `accounts` apply exactly; an
  interactive one without `enabledServices` (the one Jelly adds) gets the
  default account's services, at Read-only unless its `access` says otherwise.
- The admin gate is on by default; admin plans still need an allowed
  service, a reason, the ask and `gws_admin`.
- Every change is a `gws --dry-run` plan, committed only by its category's
  commit tool with `{ planId }`. The RPC, TUI and commands never approve or
  commit, except the tools RPC's commit methods, which exist only when the
  `rpcCommits` option is on (off by default; for a host that confirms each
  change itself), and Jelly's `commit` action (`src/host/ui-action.ts`),
  which exists only for the operations the `uiActions` option lists (none by
  default): it runs only under a verified Jelly action grant for that exact
  input from an owner device, confirmed every time (`cfm: "always"`),
  re-runs `access` (read-only refuses), policy
  and the admin gate through plan then commit, and audits as
  `caller: "person"`. Never widen its operation list, accept a grant of
  another class or a weaker confirmation, or let `access` stop short of it.
- Every call reads a sign-in with `readSignIn` (no client needed: Jelly's
  copy for an agent has no client secret); only a renewal and a new
  sign-in's reuse of the previous client use `renewableSignIn`.
  `refreshGoogle` refuses `jelly-host-owns-refresh` first, with no network
  call.
- Only `src/process/**` spawns `gws`, with an argv array and `shell: false`.
- Never log or preview bodies, tokens, credentials or file contents.
  Workspace content is untrusted data.
- Do not weaken a security test to get a green run.

## Tools, errors, skills

- `package.json` `sources` declares the plugin's sources under the source
  contract (`@we-the-rebel-alliance/source-contract`, pinned by tag as a
  devDependency and bundled into `dist/index.js`): `gws.gmail` and
  `gws.calendar` (`events_list`), `gws.calendar.today` and `gws.image`
  (snapshots), with `probe`. The page, event, screening, cursor and the
  tools RPC transport are the package's; never copy them back. Every tool
  a source names is a read, and its `permission.operations` are exactly
  what its code asserts: `test/source-conformance.test.ts` runs the
  contract's conformance kit over the real methods against the fake gws
  (`FAKE_GWS_MAILBOX`, `FAKE_GWS_CALENDAR`), and fails on any difference.
  It writes `reports/conformance-report.json`. Change a declaration and
  its code together.

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
- Releases come only from `.github/workflows/release.yml` ("Releasing" in [CONTRIBUTING.md](CONTRIBUTING.md)). A
  release-prep PR sets `version` in `package.json` and the install specs and runs `node scripts/changelog.mjs release`;
  once it is on `master` and CI passed, run the `native` workflow on that commit
  (`gh workflow run native.yml --ref master`), then start the release with
  `gh workflow run release.yml --ref master -f sha=<its full sha> -f native_run=<the native run id>`. The workflow
  builds `dist/`, makes the release commit on a temporary `release/v<version>` branch, checks and stages everything, and
  waits for the owner to approve the `release` environment; only then does it create the tag `v<version>` and the GitHub
  Release. Never push a tag or a `release/*` branch, and never commit, tag or publish a release by hand. Agents never
  approve a release, never call the deployment-approval API, and never bypass a ruleset or the environment.
- No personal email in anything we publish. Every commit is authored as
  `joe-broadhead <91376460+joe-broadhead@users.noreply.github.com>`, except the
  release commit and tag, which the release workflow makes as `github-actions[bot]`. Before committing or tagging, check
  that `git config user.email` is that address: a fresh clone inherits the machine's global identity, which
  is not that address. Never commit, tag or publish with a work or personal address, or with a local hostname.

## Tests

`npm run check` runs lint, typecheck (`src` and the whole test tree), build,
unit tests, the release kit's tests (`scripts/release-kit.test.mjs`), the
embedded-host suite, the pack test on stock OpenCode 2.2.3,
2.2.4, 2.2.5, 2.2.6, 2.2.7 and 2.3.0 (`TESTED_HOSTS` in `src/domain/host.ts`, the one list),
the generated-file check and the TUI render. Tests never need a live
Google account; a live check needs the owner's approval for each run.
