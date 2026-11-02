# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- A `jelly` section in `package.json`: each tool with its permission, its default effect and whether it only reads, the skill ids, views. Jelly reads it without loading the plugin and applies the declared asks, because its agents have no base allow rule for this plugin's own default rules to follow. `docs/jelly.md` explains it.
- `title` and `signIns` in the `jelly` section: the name Jelly shows on the plugin's card, and what the plugin signs in to, so that one card can say whether each sign-in is connected and start, renew or end it. `docs/jelly.md` lists them.
- A Gmail thread view for Jelly, `views/gmail-thread.html`, shipped in the package.

### Changed

- `gws_read` is a direct tool instead of a pinned Code Mode tool, so a host can show each read's result. A Code Mode script can no longer call `tools.gws.read`; the model calls `gws_read` directly.

## [0.0.0] - 2026-11-01

### Added

- Google Workspace tools for OpenCode through the unmodified `gws` 0.22.5 CLI: `gws_status`, `gws_catalog`, `gws_schema`, `gws_read` and `gws_plan`, and the commit tools `gws_write`, `gws_send`, `gws_share`, `gws_delete`, `gws_export` and `gws_admin`. A change is a dry-run plan, then one commit the user approves.
- Sign-in from `/connect` with a Desktop app OAuth client, read-only by default, with the scopes shown before consent. Organisation config can set the client through `oauthClient`.
- Default ask rules for every commit category; reads do not prompt.
- `/gws-status`, `/gws-doctor`, and the TUI dialog **Google Workspace: Status** (`/gws`).
- The `gws` binary in per-platform packages for macOS (arm64, x64) and Linux (arm64, x64, glibc).
- Three skills: `opencode-gws`, `opencode-gws-recipes` and `opencode-gws-admin`.
