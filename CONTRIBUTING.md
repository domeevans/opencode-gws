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

`npm run check` is the local gate: lint, typecheck, build, unit tests, the release kit's tests, the host suite, the pack-install check, the generated-file check, and the TUI render. Run it before a change is reviewed.

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

Each release is the GitHub tag `v<version>`, where `<version>` is the `version` in `package.json`, and users install from
that tag. The release is one commit on top of a `master` head that CI passed, and the tag points at it. The release
workflow makes both, in GitHub Actions: nobody builds, commits or tags a release on their own machine, and no personal
key signs it.

While changes land, their notes go under `## [Unreleased]` at the top of `CHANGELOG.md`. Each earlier GitHub release is
a `## [x.y.z] - YYYY-MM-DD` heading below it, newest first, and the npm history stays last, under
`## Earlier releases on npm`.

1. On `master`, set `version` in `package.json` to the new version, and change every install spec in the README,
   `CONTRIBUTING.md` and `docs/` to `#v<version>` (`test/docs.test.ts` fails until they match). Then run
   `node scripts/changelog.mjs release`: it turns `## [Unreleased]` into `## [<version>] - <today>`, above the earlier
   releases, and refuses a CHANGELOG it cannot shape. Run `npm run check`.
2. Push that commit to `master`, and wait for CI to pass on it. A pull request's CI runs the Linux runners only; the
   push to `master` runs every runner, macOS too, and the release stands on that run.
3. Run the `native` workflow on that commit (`gh workflow run native.yml --ref master`), and wait for it to pass. It
   builds the release files for `v<version>`.
4. Start the release with that commit's full sha and the native run's id:
   `gh workflow run release.yml --ref master -f sha=<full sha> -f native_run=<native run id>`, or from Actions → release →
   Run workflow, on `master`.
5. Read the run's summary, then approve the `release` environment. The summary is on the run page, under the `stage`
   job: the tag, the parent and its CI run, the release commit and its tree, the sha256 of `SHA256SUMS` and the staged
   artifact's id, `SHA256SUMS` itself, and the notes. Open the release commit on `release/v<version>` and read them
   before approving: the approval releases exactly those bytes. Only the owner approves a release. Agents never approve
   one, never call the deployment-approval API, and never bypass a ruleset or the environment; the kit's scripts make
   only their own GitHub calls and refuse every other.
6. Check the published Release: not a draft, its notes, and every asset against `SHA256SUMS`.

`package.json` stays `"private": true`, so npm can never publish the plugin by accident; a GitHub install does not read
it, and `npm pack` still packs the release tarball. It is kept in its canonical form, `JSON.stringify(pkg, null, 2)` and
one newline: the kit tests check both in `npm run check`, as the release planner does.

The declaration is checked against what the provider serves. `npm run capture` (`scripts/capture-tools.mjs`, run by hand
through the signed-in OpenCode, never by CI) writes `test/fixtures/live-tools.json` and `test/fixtures/provenance.json`,
with the signed-in account's own values that some servers write into descriptions (Slack's "Your user_id: …") replaced
by placeholders such as `U00CURRENTUSER`; the drift check fails a committed capture that still holds one.
`scripts/check-drift.mjs` checks `jelly.tools`, `test/fixtures/tool-registry.json`, the skills and the docs against them,
offline, in the kit tests of `npm run check`. The release build runs it with `--release`, which also refuses a capture
more than 14 days old, unless `provenance.json` holds the owner's written waiver for exactly that capture:
`"waiver": { "listedAt": "<the capture's date>", "reason": "…", "approvedBy": "…" }` (a new capture drops it). A plugin
with no capture yet, or only a names-only one, releases with a warning on the run; one that serves only its own tools
says so with `"upstream": "none"` in the registry.

Before the approval, the workflow:
- **plans:** refuses a run that is not on `master`, a sha that is not `master`'s head, a sha without a successful
  `ci.yml` push run with a successful job on every runner its push matrix names (macOS included), a `ci.yml` whose
  matrix runs macOS on a pull request or not on a push (the kit tests check it too), a version that is not `x.y.z`, a
  `package.json` that is not `"private": true` or not in its canonical form, a CHANGELOG whose newest release is not
  this version, a release that does not move forward from the last published Release, a leftover `release/v<version>`
  branch, a native run that did not build this sha on `master`, by hand, with success, and a missing `native_run` (or
  one given to a plugin that is not native);
- **builds**: refuses a failing tool drift check (`scripts/check-drift.mjs --release`, above), then builds `dist/` with
  `npm ci --ignore-scripts` and `npm run build`, with a read-only token, and writes the release files: `dist/`,
  `package.json` without its lifecycle scripts, and the vetted native manifest;
- **commits** them on a temporary branch `release/v<version>` at the parent, through GitHub's API with the workflow's token,
  so GitHub signs the commit (author `github-actions[bot]`, committer GitHub). This job runs no npm. It refuses a commit
  that GitHub does not verify, or whose parent or tree is not the one the files give;
- **verifies** on a fresh runner: the commit's identity, one parent on `master`, `package.json` exactly the parent's
  without the lifecycle scripts, only regular files in the allowed paths, no `package.json` under `dist/`, and a second,
  independent build of the parent (its own job) equal to the committed `dist/` byte for byte;
- **installs** the release commit with `plugin add` on each stock OpenCode host (2.2.3 to 2.2.6);
- **packs** the commit before installing anything and keeps that tarball, then runs the pack stage against a copy;
- **stages** the Release: verifies the attested native files, writes `SHA256SUMS` and the notes (the version's CHANGELOG
  section), and shows them all in the run summary with the sha256 of `SHA256SUMS`.

A job either runs repository or dependency code (`npm ci`, the build, the pack stage, a host install) and has no write
token, or uses the API and runs only the kit's scripts on a fresh checkout, after checking that the release commit's
`scripts/` and `.github/` are the parent's. The first kind is not token-free: `actions/checkout` fetches with the job's
read-only (`contents: read`) token, and its post step and the artifact uploads run after repository code on the same
runner, so that code could reach a read-only token for this public repository and the runner's artifact token. Jobs
pass files as artifacts downloaded by the id the uploading job gave, and each is checked again on arrival.

After the approval, it downloads the staged artifact by the id the summary names, and refuses unless `SHA256SUMS` has
the sha256 the summary shows and every staged file matches it, and every native file is the one the release commit's
`manifest/native.json` pins, size and sha256, with each gzip holding the pinned executable. Then it checks everything again, creates the annotated tag
`v<version>` on the release commit (tagger `github-actions[bot]`, unsigned), checks the tag, creates the Release with the
notes, the tarball, the native files and `SHA256SUMS`, and deletes `release/v<version>`. The tag keeps the commit.

GitHub's signature and the bot identity show only that GitHub made the commit through its API for the workflow; anyone
with write access can make such a commit. What ties the release to `master` is its content: one parent CI passed, the
exact `package.json`, the allowed paths and the byte-for-byte rebuild. Never relax those because the commit is signed.

**A rejected, expired or failed run** leaves nothing behind: the `cleanup` job deletes `release/v<version>` when it points
at the parent or at that run's commit, and never touches another branch. No tag exists before the approval, so the
version is not burned: fix `master` and start again. If `cleanup` itself failed, the next run refuses until the branch
is deleted: `gh api -X DELETE repos/joe-broadhead/opencode-gws/git/refs/heads/release/v<version>`.

**Resume.** If the run fails after creating the tag and before the Release is complete, start it again with the same `sha`
and `native_run`. The plan finds the kit's tag on a release commit on that sha with no published Release, and resumes:
it makes no new commit, checks and installs the tagged commit, stages the files, and after a new approval reuses the tag
and adds what the Release lacks. Delete a draft Release a failed upload left first: the publish step refuses a draft.
Any other existing tag is refused: release the next version.

The repository's tag ruleset keeps a `v*` tag from being moved or deleted. A stray `v*` tag, one that never became a
Release, does not block later releases: only published Releases count, and drafts do not. Its version cannot be
released, so release the next one. To remove the tag anyway, an admin disables the `release tags` ruleset, deletes the
tag, and restores the ruleset exactly as it was.

**Known limit: a `v*` tag pushed by hand.** No ruleset limits who creates a `v*` tag, so anyone with write access can
push one by hand, pointing at any commit. Such a tag has no published Release, the forward-only check ignores it, and
Jelly installs only a published Release whose `SHA256SUMS` it verifies. But a user who installs
`github:joe-broadhead/opencode-gws#v<x>` directly gets whatever that tag points at. Only the release workflow makes
release tags; never push one by hand.

The release kit is these files, the same in every plugin: `scripts/release-rules.mjs`, `scripts/release-commit.mjs`,
`scripts/release-github.mjs`, `scripts/check-release-shape.mjs`, `scripts/changelog.mjs`, `scripts/release-version.mjs`,
`scripts/release-pack.mjs`, `scripts/publish-release.mjs`, `scripts/attach-native.mjs`, `scripts/native-manifest.mjs`,
`scripts/tested-hosts.mjs`, `scripts/check-release-plugin-add.sh`, `scripts/check-drift.mjs`, `scripts/capture-tools.mjs`,
`scripts/release-kit.test.mjs`, `scripts/drift-kit.test.mjs` and `.github/workflows/release.yml`. `scripts/check-copies.mjs`
pins each of the scripts whole by its sha256, so a plugin whose copy differs from the family's fails `npm run check`:
change the kit in every plugin at once, with the new hashes. Do not re-run the older `apply-release-kit.mjs`: it writes
back the kit that could release only `v0.0.0`.

Each release has its own tag, and a Git install does not update by itself. To move to a newer release, remove the old entry with `opencode plugin remove github:joe-broadhead/opencode-gws#v<old version>`, then add the new tag with `opencode plugin add github:joe-broadhead/opencode-gws#v<version>`.

Or add the plugin to `opencode.json` instead, with the same spec:

```json
{ "plugins": [{ "package": "github:joe-broadhead/opencode-gws#v0.0.4" }] }
```
## Live checks

These need the owner's authorization for that run, on a disposable test account. Do not run them against a personal or production Workspace.

1. Sign in from zero with no plugin options. The form and Google's consent screen show only read scopes plus the identity scopes. `/gws-status` shows `access: read`. A Gmail list read succeeds. A Drive write plan fails with `AUTH_SCOPE_MISSING` and does not start `gws`. After signing in again with Read and write and acknowledging, the same plan can be committed.
2. On that same account, exercise `status`, `catalog`, `schema`, `read`, `plan`, `write`, `send` (to self), `share` then revoke, `delete` of the asset just created, and `export` to a temp path. `admin` stays denied with the default config.
3. Confirm an agent defined only in user config is named by `/gws-status` and the status dialog, and counted by `gws_status`.
