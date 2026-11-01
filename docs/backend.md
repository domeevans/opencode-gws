# gws binary

Unofficial plugin. Not affiliated with Google. `gws` 0.22.5 is Google's open-source Workspace CLI (Apache-2.0). The plugin does not modify the binary.

## Platform packages

The unmodified binary ships in an optional npm package, one per platform, at the same version as this package:

| Package | Platform |
| --- | --- |
| `@joe-broadhead/opencode-gws-bin-darwin-arm64` | macOS arm64 |
| `@joe-broadhead/opencode-gws-bin-darwin-x64` | macOS x64 |
| `@joe-broadhead/opencode-gws-bin-linux-arm64-gnu` | Linux arm64, glibc |
| `@joe-broadhead/opencode-gws-bin-linux-x64-gnu` | Linux x64, glibc |

Each package contains `bin/gws`, `LICENSE`, `NOTICE`, and `provenance.json`. It has no scripts. npm installs the package that matches the machine. There is no `PATH` lookup and no download at runtime.

The plugin resolves that package from its own install location, checks that `bin/gws` is a regular file with owner read and execute and no permission bits outside `0755`, and checks the SHA-256 recorded in [native/provenance.json](../native/provenance.json). The same file records the upstream archive URL and archive digest for each target. A mismatch fails setup with `BINARY_TRUST_FAILED`.

The version probe then requires the binary to report exactly `gws 0.22.5`.

## Checkout

`npm run fetch:gws` builds the host platform's package into `node_modules` so a checkout uses the same resolution path as an install. It downloads the pinned archive once, verifies the archive digest, and extracts `gws`. A later run does nothing when that binary already matches. An unsupported platform fails with a message that names the supported targets and `binary.path`.

## Override

`binary.path` is an absolute path to some other `gws` 0.22.5 executable. It is admitted only when all of these hold:

- it is a regular file, not a symlink to something else after `realpath`;
- it is executable, and not group- or world-writable;
- it is outside the project directory;
- no ancestor is world-writable, and no ancestor is writable by a group this user is not in.

There is no hash option on the override. The version probe still requires `gws 0.22.5`. A relative path, a missing file, or a failed trust check does not fall through to `PATH`.

## Unsupported platform

Windows, musl, and any other platform have no package. Setup fails with `GWS_UNAVAILABLE` and names the four packages. Next step: reinstall on a supported platform, or set `binary.path` to a `gws` 0.22.5 executable for this machine.

A missing platform package on a supported platform is the same code. In a checkout, run `npm run fetch:gws`. In an install, reinstall so npm fetches the optional package.

## Air-gapped install

Runtime never downloads `gws`. An install needs the main package and the matching platform package already present: a local npm cache, a tarball, or `binary.path` pointing at a binary you placed on the machine. `npm run fetch:gws` is the checkout path; it needs the pinned archive in its cache or a network path to the GitHub release. It does not run when OpenCode loads the plugin.

## Provenance

[native/provenance.json](../native/provenance.json) is the record: upstream repository, tag, archive URL, archive SHA-256, and binary SHA-256 for each target. The platform packages carry the same binary and the upstream Apache-2.0 `LICENSE`. A maintainer refreshes the recorded binary digest with `node scripts/build-bin-packages.mjs --record` after verifying the archive digest. Do not point that command at an unpinned release.
