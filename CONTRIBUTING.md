# Contributing

## Setup

Node 24 or later. The TUI render check needs Bun 1.4.4 or later, the version CI runs. `gws` is fetched by the script below; do not install a different version on `PATH` and expect the plugin to use it.

```bash
npm ci
npm run fetch:gws
npm run check
```

`npm run build` runs `scripts/bundle.mjs`, which writes exactly `dist/index.js` and `dist/tui.js`, each a self-contained esbuild bundle. To load the checkout in OpenCode, build it and point a plugin entry at its directory:

```bash
npm run build
```

```jsonc
{ "plugins": [{ "package": "<path-to-checkout>" }] }
```

`npm run check` is the local gate: lint, typecheck, build, unit tests, the host suite, the pack-install check, the generated-file check, and the TUI render. Run it before a change is reviewed.

The host suite embeds `@opencode/sdk` 2.2.3. It needs Node 24. `HOST_SDK_DIR`, when set, is an extra embedded SDK directory for that pack check (for example a 2.2.4 SDK kept outside the lockfile).

The pack check loads the installed tarball in each tested stock OpenCode: 2.2.3, 2.2.4, 2.2.5 and 2.2.6, the one list `TESTED_HOSTS` in `src/domain/host.ts`. Set `OPENCODE_BIN_2_2_3`, `OPENCODE_BIN_2_2_4`, `OPENCODE_BIN_2_2_5` and `OPENCODE_BIN_2_2_6` to those binaries to skip the download. When one is unset, the script installs `@opencode/cli` and the current platform package into its temp folder with scripts disabled, once per version. It checks the version each binary reports, which must be inside `opencode.host`, so a slot may hold a newer binary. Do not set `OPENCODE_BIN`. The script ignores it. Each stock load uses its own temp root for `HOME`, the XDG folders, `OPENCODE_TEST_HOME` and `TMPDIR`, starts in that project directory, and refuses to continue unless every `opencode debug paths` entry is inside the root.

## Generated files

Do not edit these by hand:

```bash
npm run manifest
npm run docs:coverage
npm run drift
```

`npm run manifest` regenerates `manifest/generated.json` from the pinned `gws`. `npm run docs:coverage` regenerates `docs/coverage.md`, the Errors section of `docs/configuration.md`, and the scope table in `docs/auth.md`. `npm run generated:check` fails if those drifted. `npm run drift` compares the manifest with the pinned `gws` and warns; it does not stop a call.

A new upstream release: record its archive URL and SHA-256 (checked against the release's own `.sha256` file), and the executable's size and SHA-256, in `native/provenance.json`; mirror the executable's SHA-256 in `src/domain/backend.ts`. Then `npm run fetch:gws` refuses any archive or executable that does not match the pins.

An example config is in [examples/opencode.jsonc](examples/opencode.jsonc). The source layout is in [docs/architecture.md](docs/architecture.md#source-layout).

## Behaviour

- Tool schemas: `src/domain/contract.ts`
- Tool adapters: `src/host/tools.ts`
- Options: `src/domain/config.ts`
- Ask rules: `src/host/agents.ts`
- Policy: `src/domain/policy.ts`
- Scope sets: `src/domain/scopes.ts`
- Errors: `src/domain/errors.ts`
- Skills: `skills/*/SKILL.md` and `src/host/skills.ts`

Add a focused test under `test/`. Keep it independent of a live Google account.

A public tool or config change needs a test and a docs update.

## Release

### Releasing

Every plugin releases as `v0.0.0`, and it installs from that GitHub tag. The release is one commit on top of a `master`
head that CI passed, and the tag points at it.

1. Set `version` to `0.0.0` in `package.json`, date the `## [0.0.0]` entry in `CHANGELOG.md`, then run `npm run check`.
2. Push that commit to `master`, and wait for CI to pass on it.
3. In a clean checkout of `master` at that commit, run `node scripts/release-commit.mjs --ci-sha <its full sha>`. It builds
   `dist/`, removes the lifecycle scripts, and creates the signed commit and the signed annotated tag `v0.0.0`. It never
   pushes; `--dry-run` shows the change first.
4. Push the tag only: `git push origin v0.0.0`.
5. Approve the run in the `release` environment. The release workflow checks the tag and its commit, installs the tag on
   each stock OpenCode host (2.2.3 to 2.2.6), packs it, and creates the GitHub Release with the notes, the tarball and
   `SHA256SUMS`.

A tag that already exists stops step 3. Delete the old tag and its Release first, then start again.

A Git install is removed and updated by its installed spec: `opencode plugin remove github:joe-broadhead/opencode-gws#v0.0.0`. `opencode plugin update` and `opencode plugin check` take the same spec.
## Live checks

These need the owner's authorization for that run, on a disposable test account. Do not run them against a personal or production Workspace.

1. Sign in from zero with no plugin options. The form and Google's consent screen show only read scopes plus the identity scopes. `/gws-status` shows `access: read`. A Gmail list read succeeds. A Drive write plan fails with `AUTH_SCOPE_MISSING` and does not start `gws`. After signing in again with Read and write and acknowledging, the same plan can be committed.
2. On that same account, exercise `status`, `catalog`, `schema`, `read`, `plan`, `write`, `send` (to self), `share` then revoke, `delete` of the asset just created, and `export` to a temp path. `admin` stays denied with the default config.
3. Confirm an agent defined only in user config is named by `/gws-status` and the status dialog, and counted by `gws_status`.
