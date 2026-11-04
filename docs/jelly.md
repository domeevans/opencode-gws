# In Jelly

[Jelly](https://heyjelly.ai) runs OpenCode agents. It reads the `jelly` section of this
package's `package.json` as JSON, without loading the plugin, when a person reviews the exact
version, and uses it as follows.

Jelly names the plugin **Google Workspace** (`jelly.title`), with the package name and version beneath.

## Tools and permissions

11 tools are declared (5 read-only). Jelly's agents have no base "allow everything"
rule, so this plugin's own default rules, which it puts after that rule, never reach them. Jelly
writes each declared `ask` or `deny` as that tool's default instead (the person's own choice
replaces it), and denies a read-only helper every tool not marked `readOnly`. A declared `allow`
changes nothing in Jelly.

- Ask: `gws.write`, `gws.export`, `gws.send`, `gws.share`, `gws.delete`, `gws.admin`.
- Everything else runs, as the plugin's own rules let it.

`gws.admin` is declared `ask`, as the plugin's own rule is: the admin gate is on by default, and each admin plan still needs an allowed service and a reason.

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
  `VIEW_HELPER`) and loads nothing by URL. Its types, for a page checked with TypeScript, are in
  the repository's `views/jelly-view.d.ts`; the package ships no `.d.ts`.

  `gws_read` is a direct tool for this: Jelly sees the result of a direct call, and not of a call
  made inside a Code Mode script. A thread read with `fields` narrow enough to stay under Jelly's
  64 KB copy, such as `messages(id,internalDate,snippet,payload(headers,mimeType,parts(mimeType,body/data)))`,
  is shown; a larger one is not offered.

## Signing in

`jelly.signIns` declares one sign-in, `google`, for OpenCode's integration `gws-*`: every account (`gws-<alias>`) folds into it, so the card waits while any account waits. Each account signs in with OAuth through a Desktop app client. Jelly holds the person's Desktop client and fills in `clientId` and `clientSecret`, so its form shows only Access (starting on `default`, read-only) and the write acknowledgement while it applies, and no `oauthClient` option is needed. Jelly writes only `{ mode: "interactive", enabledServices }` for each account. When the engine runs on another machine than the person's browser, a host can also fill the form's hidden `redirectUri`, `callbackPort` and `clientJson` fields (a Web application client that lists the redirect), so Google's redirect comes back through the host to the engine's listener; see [docs/auth.md](auth.md#sign-in-when-opencode-runs-on-another-machine).

Jelly folds the declared sign-ins into this plugin's one card, which shows each as Connected, Not signed in or Sign in again (expired or revoked), and starts, renews and signs out of each. An agent's `jelly_connection_request`, or a tool result that names this plugin's "Run /connect and choose …" next step, opens the same card. The plugin still signs in through OpenCode, as it does without Jelly; the declaration only tells Jelly which of the engine's integrations and servers are this plugin's.

## Versions

Jelly's curated catalogue pins an exact version. `latest` is `0.0.0`; publish each release
under a new version so a review in Jelly can tell the two apart.
