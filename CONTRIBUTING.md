# Contributing

## Setup

Node 24 or later. The TUI render check needs Bun 1.3.14 or later. `gws` is fetched by the script below; do not install a different version on `PATH` and expect the plugin to use it.

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

The pack check loads the installed tarball in each tested stock OpenCode: 2.2.3, 2.2.4, 2.2.5 and 2.2.6, the one list `TESTED_HOSTS` in `src/domain/host.ts`. Set `OPENCODE_BIN_2_2_3`, `OPENCODE_BIN_2_2_4` and `OPENCODE_BIN_2_2_5` to those binaries to skip the download. When one is unset, the script installs `@opencode/cli` and the current platform package into its temp folder with scripts disabled, once per version. It checks the version each binary reports, which must be inside `opencode.host`, so a slot may hold a newer binary. Do not set `OPENCODE_BIN`. The script ignores it. Each stock load uses its own temp root for `HOME`, the XDG folders, `OPENCODE_TEST_HOME` and `TMPDIR`, starts in that project directory, and refuses to continue unless every `opencode debug paths` entry is inside the root.

## Generated files

Do not edit these by hand:

```bash
npm run manifest
npm run docs:coverage
npm run drift
```

`npm run manifest` regenerates `manifest/generated.json` from the pinned `gws`. `npm run docs:coverage` regenerates `docs/coverage.md`, the Errors section of `docs/configuration.md`, and the scope table in `docs/auth.md`. `npm run generated:check` fails if those drifted. `npm run drift` compares the manifest with the pinned `gws` and warns; it does not stop a call.

`node scripts/build-bin-packages.mjs --record` writes binary digests into `native/provenance.json` after the archive digest has been verified. Use it only when the pinned upstream archive changes.

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

## Releasing

1. Set the version in `package.json`, its four `optionalDependencies` and the lockfile, and date its `CHANGELOG.md` section.
2. Push a `vX.Y.Z` tag on `master`.
3. A reviewer approves the `release` environment.
4. CI (`.github/workflows/release.yml`) refuses a private package or a tag that differs from the version, then runs `npm ci` and `npm run check`. It packs the main package and the four `@joe-broadhead/opencode-gws-bin-<target>` packages, each built from the pinned upstream archive and checked against `native/provenance.json`, and runs the pack test on those exact tarballs.
5. It publishes the four platform packages first, then the main package, each with `npm publish <tarball> --provenance --access public` through npm trusted publishing. A version already on npm is skipped, so a rerun is safe.

## Live checks

These need the owner's authorization for that run, on a disposable test account. Do not run them against a personal or production Workspace.

1. Sign in from zero with no plugin options. The form and Google's consent screen show only read scopes plus the identity scopes. `/gws-status` shows `access: read`. A Gmail list read succeeds. A Drive write plan fails with `AUTH_SCOPE_MISSING` and does not start `gws`. After signing in again with Read and write and acknowledging, the same plan can be committed.
2. On that same account, exercise `status`, `catalog`, `schema`, `read`, `plan`, `write`, `send` (to self), `share` then revoke, `delete` of the asset just created, and `export` to a temp path. `admin` stays denied with the default config.
3. Confirm an agent defined only in user config is named by `/gws-status` and the status dialog, and counted by `gws_status`.
