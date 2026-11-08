# In Jelly

[Jelly](https://heyjelly.ai) runs OpenCode agents. It reads the `jelly` section of this
package's `package.json` as JSON, without loading the plugin, when a person reviews the exact
version, and uses it as follows.

Jelly names the plugin **Google Workspace** (`jelly.title`), with the package name and version beneath. Under
that name it shows the one line in `jelly.summary`, and beside it the mark in `jelly.icon`
(`assets/icon.svg`, shipped in the package): Jelly reads that file once, when it records the
plugin, and keeps it only if it is a clean SVG of drawing elements, with no script, style, link
or outside reference. A Jelly whose declaration schema lacks `summary` or `icon` refuses this
declaration, because that schema accepts no unknown keys.

## Tools and permissions

12 tools are declared (6 read-only). Jelly's agents have no base "allow everything"
rule, so this plugin's own default rules, which it puts after that rule, never reach them. Jelly
writes each declared `ask` or `deny` as that tool's default instead (the person's own choice
replaces it), and denies a read-only helper every tool not marked `readOnly`. A declared `allow`
changes nothing in Jelly.

- Ask: `gws.write`, `gws.export`, `gws.send`, `gws.share`, `gws.delete`, `gws.admin`.
- Everything else runs, as the plugin's own rules let it. `gws.events_list` is for Memory's collector, which runs it unattended, so it never asks; it also asserts `gws.read` on each Gmail read it makes.

`gws.admin` is declared `ask`, as the plugin's own rule is: the admin gate is on by default, and each admin plan still needs an allowed service and a reason.

`test/jelly.test.ts` checks each declared effect against the plugin's own default rules.

## Skills

Declared: `opencode-gws`, `opencode-gws-recipes`. Jelly refuses an install whose
skill ids collide with another plugin's or the agent's own.

## Views

- **Gmail thread** (`views/gmail-thread.html`, a sealed page, grant `data` only), behind `gws_read`.
  It draws `gmail.users.threads.get`: the subject, then each message's sender, time and text part
  (or Gmail's snippet). For any other read it declines, and the call keeps its ordinary look. It
  carries Jelly's bridge helper inline (`views/jelly-view.js`, the text of `@jelly/contracts`
  `VIEW_HELPER`) and loads nothing by URL. Its types come with `@jelly/contracts`.

  `gws_read` is a direct tool for this: Jelly sees the result of a direct call, and not of a call
  made inside a Code Mode script. A thread read with `fields` narrow enough to stay under Jelly's
  64 KB copy, such as `messages(id,internalDate,snippet,payload(headers,mimeType,parts(mimeType,body/data)))`,
  is shown; a larger one is not offered.

## Signing in

`jelly.signIns` declares one sign-in, `google`, for OpenCode's integration `gws-*`: every account (`gws-<alias>`) folds into it, so the card waits while any account waits. The sign-in declares what Jelly does for it, so Jelly has no code of its own for gws:

- `account`: Jelly asks for an account's name and writes `{ "mode": "interactive" }` under it in `accounts`; gws has no account until one is named, so Jelly adds it to an agent with that question and never gives it blank.
- `hostClient`: `{ "id": "google", "field": "clientJson", "replaces": ["clientId", "clientSecret"] }`. Jelly holds the person's OAuth clients and answers the hidden `clientJson` field with one, whole: the Desktop app client for a loopback sign-in. Its form shows only Access (starting on `default`, read-only) and the write acknowledgement while it applies, and no `oauthClient` option is needed.
- `needed`: `AUTH_REQUIRED` and `AUTH_SCOPE_MISSING`, the codes a gws tool result carries when an account must sign in again, so Jelly puts this card in front of the person.

These need Jelly 0.3.2 or later; an older Jelly refuses the declaration's new keys. When the engine runs on another machine than the person's browser, a host can also fill the form's hidden `redirectUri` and `callbackPort` fields, and answer `clientJson` with a Web application client that lists the redirect, so Google's redirect comes back through the host to the engine's listener; see [docs/auth.md](auth.md#sign-in-when-opencode-runs-on-another-machine). The sign-in declares `"relay": { "redirectField": "redirectUri", "portField": "callbackPort" }`: those are the two fields a Jelly web tab fills with its fixed relay address at Jelly ID and a loopback port for the listener (Jelly ADR 0019). The plugin's code is the same either way, and the Web application client must list that relay address.

Jelly folds the declared sign-ins into this plugin's one card, which shows each as Connected, Not signed in or Sign in again (expired or revoked), and starts, renews and signs out of each. An agent's `jelly_connection_request`, or a tool result that names this plugin's "Run /connect and choose …" next step, opens the same card. The plugin still signs in through OpenCode, as it does without Jelly; the declaration only tells Jelly which of the engine's integrations and servers are this plugin's.

## Versions

Jelly's curated catalogue pins an exact version. Publish each release under a new version so a
review in Jelly can tell the two apart.

The declaration test runs the shared kit, `test/support/jelly-kit.ts`, which checks the declaration and this page against Jelly's plugin authors' standard. `scripts/check-copies.mjs` holds the kit equal to the copy every plugin carries.
