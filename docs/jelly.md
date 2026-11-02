# In Jelly

[Jelly](https://heyjelly.ai) runs OpenCode agents. It reads the `jelly` section of this
package's `package.json` as JSON, without loading the plugin, when a person reviews the exact
version, and uses it as follows.

## Tools and permissions

11 tools are declared (5 read-only). Jelly's agents have no base "allow everything"
rule, so this plugin's own default rules, which it puts after that rule, never reach them. Jelly
writes each declared `ask` or `deny` as that tool's default instead (the person's own choice
replaces it), and denies a read-only helper every tool not marked `readOnly`. A declared `allow`
changes nothing in Jelly.

- Ask: `gws.write`, `gws.export`, `gws.send`, `gws.share`, `gws.delete`.
- Off: `gws.admin`.
- Everything else runs, as the plugin's own rules let it.

`gws.admin` is declared `deny`: the plugin's own admin gate is off unless configured, and Jelly sets up no admin account.

A tool the upstream server adds later is not declared, so in Jelly it is not asked about by
default. Keep `jelly.tools` in step with the known-tool list; `test/views.test.ts` checks
each declared effect against the plugin's own default rules.

## Skills

Declared: `opencode-gws`, `opencode-gws-recipes`, `opencode-gws-admin`. Jelly refuses an install whose
skill ids collide with another plugin's or the agent's own.

## Views

- **Gmail thread** (`views/gmail-thread.html`, a sealed page, grant `data` only), behind `gws_read`.
  It draws `gmail.users.threads.get`: the subject, then each message's sender, time and text part
  (or Gmail's snippet). For any other read it declines, and the call keeps its ordinary look. It
  carries Jelly's bridge helper inline (`views/jelly-view.js`, the text of `@jelly/contracts`
  `VIEW_HELPER`) and loads nothing by URL.

  `gws_read` is a direct tool for this: Jelly sees the result of a direct call, and not of a call
  made inside a Code Mode script. A thread read with `fields` narrow enough to stay under Jelly's
  64 KB copy, such as `messages(id,internalDate,snippet,payload(headers,mimeType,parts(mimeType,body/data)))`,
  is shown; a larger one is not offered.

## Signing in

OpenCode's integration `gws-<alias>` (OAuth with your own Desktop app client: client ID and secret in the form, or `oauthClient` in the options). Jelly shows it as the card `integration:gws-default`.

<!-- AUTH-PLACEHOLDER (Jelly rd152): settings and secrets for signing in from Jelly are being
designed by Jelly's auth lane. Until that lands this package declares no `contributes.settings`;
add the auth declarations here and in package.json when that design is agreed. -->
**Not yet declared for Jelly.** How this plugin's sign-in appears in Jelly (desktop and web,
expiry, reconnect and sign-out) is still being designed; this section and
`jelly.contributes.settings` will say it once it is.

## Versions

Jelly's curated catalogue pins an exact version. `latest` is `0.0.0`; publish each release
under a new version so a review in Jelly can tell the two apart.
