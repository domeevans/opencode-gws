# gws binary

Unofficial plugin. Not affiliated with Google. `gws` 0.22.5 is Google's open-source Workspace CLI (Apache-2.0). The plugin does not modify the binary. Its licence and notice ship with the plugin in [licenses/gws](../licenses/gws).

## The release binary

The plugin's GitHub Release carries one gzip per platform: the unmodified `gws` executable, compressed. The plugin never runs a binary it has not verified:

- The release commit's `manifest/native.json` pins, for each platform, the release file's size and SHA-256 and the executable's size and SHA-256. The executable's SHA-256 is the upstream pin in [native/provenance.json](../native/provenance.json).
- The first use downloads the file over HTTPS from `github.com`, checks its size and SHA-256 as it arrives, decompresses it, checks the executable, and only then installs it into the plugin's cache (`$XDG_CACHE_HOME/opencode-gws`, or `~/Library/Caches/opencode-gws` on macOS). A file that fails a check is discarded and never reaches the cache.
- A cached executable is used without a download. It is refused if it is not a regular file with owner read and execute and no permission bits outside `0755`.

| Platform | Target |
| --- | --- |
| macOS arm64 | `darwin-arm64` |
| macOS x64 | `darwin-x64` |
| Linux arm64, glibc | `linux-arm64-gnu` |
| Linux x64, glibc | `linux-x64-gnu` |

Windows, musl and any other platform have no release binary. Setup does not fail: the tools refuse with `GWS_UNAVAILABLE` and name `binary.path` as the way out.

## When a download happens

The download is a change, because it writes a program the plugin then runs. The access rules decide it, through the namespace rule `gws.*`:

| `access` | A tool call that needs the binary | `/gws-install` |
| --- | --- | --- |
| `all` (the default) | Downloads on first use. | Downloads. |
| `ask-changes` | Asks first. | Downloads. |
| `read-only` | Refused: `GWS_UNAVAILABLE`, with `/gws-install` as the next step. | Downloads. |

`/gws-install` is the person's own command, so it runs under every access value. It reports the result. Setup makes no network call, and status never downloads: `gws_status` reports the cached binary, or an empty path when none is cached.

## Explicit `binary.path`

`binary.path` is an absolute path to some other `gws` 0.22.5 executable. It is admitted only when all of these hold:

- it is absolute, and exists;
- its real path is a regular file with owner execute and no group or world write;
- it is not inside the project directory;
- no ancestor directory is world-writable, and none is writable by a group the user is not in.

There is no hash option on the override. The version probe still requires `gws 0.22.5`. A relative path, a missing file, or a failed trust check does not fall through to a binary elsewhere, and nothing is looked up on `PATH`.

## Development and the pack test

A checkout has no release manifest, so its tests and the pack check name the verified executable directly. `npm run fetch:gws` downloads the pinned upstream archive once into `.cache/gws-archives/`, checks its SHA-256 and the executable's against [native/provenance.json](../native/provenance.json), and puts the executable at `.cache/gws/<target>/gws`. Run it after `npm ci`. The pack check installs a release copy into each stock host's cache to prove the installed plugin finds it.

## Releasing the binary

`node scripts/build-native.mjs --release <dir> --tag v0.0.0 --repository joe-broadhead/opencode-gws --commit <sha> --run <id>` writes `gws-<target>.gz` for every platform and the candidate `native-manifest.json`. The `native` workflow ([.github/workflows/native.yml](../.github/workflows/native.yml)) runs it on `master`, attests the files and uploads them. The release commit pins the candidate's hashes, and the release checks them again before it attaches the files. [native/provenance.json](../native/provenance.json) records the upstream archive URL, its SHA-256, and the executable's SHA-256 for each target.
