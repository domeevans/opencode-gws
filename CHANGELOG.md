# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.0.0] - 2026-11-01

### Added

- Google Workspace tools for OpenCode through the unmodified `gws` 0.22.5 CLI: `gws_status`, `gws_catalog`, `gws_schema`, `gws_read` and `gws_plan`, and the commit tools `gws_write`, `gws_send`, `gws_share`, `gws_delete`, `gws_export` and `gws_admin`. A change is a dry-run plan, then one commit the user approves.
- Sign-in from `/connect` with a Desktop app OAuth client, read-only by default, with the scopes shown before consent. Organisation config can set the client through `oauthClient`.
- Default ask rules for every commit category; reads do not prompt.
- `/gws-status`, `/gws-doctor`, and the TUI dialog **Google Workspace: Status** (`/gws`).
- The `gws` binary in per-platform packages for macOS (arm64, x64) and Linux (arm64, x64, glibc).
- Three skills: `opencode-gws`, `opencode-gws-recipes` and `opencode-gws-admin`.
