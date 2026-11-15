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

- Ask: none: every declared tool is allowed, as the plugin's default `access` is.
- Everything else runs. `gws.events_list` is for Memory's collector, which runs it unattended, so it never asks; it also asserts `gws.read` on each Gmail read it makes.

A commit still needs its plan: `gws_plan` returns a `planId`, and only the matching commit tool
applies it. The admin gate is on by default, and each admin plan needs an allowed service and a
reason. To make the commits ask, or stop them, the person sets the plugin's `access` option, or a
tool rule of their own in Jelly.

`test/jelly.test.ts` checks each declared effect against `defaultRules("all")`.

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
- **Today** (`views/calendar.html`, a sealed Home tile, size `m`, grant `rpc` for `calendar.today` only). It
  calls `calendar.today` every five minutes while it is shown and lists the entries not yet ended: all-day ones
  first, then by start, with each one's time and place. A stale answer, or one read more than 15 minutes ago, says
  "not up to date"; a missing or malformed answer says the calendar is not available, never that the day is empty.

- **Changes from agent UIs** (`views/ui-changes.html`, a sealed page in the plugin's settings, no grants). It only
  says what the `commit` action does and that it is off unless `uiActions` lists it; it never calls the action. It
  exists because Jelly's schema makes every action name at least one of the plugin's pages, and naming the Gmail
  thread or the Today tile would give that page a write it never needs. It goes once Jelly drops that rule for
  actions bound from agent UIs, as it has offered.

## Today's calendar

`jelly.nativeData` is `[{ "v": 1, "capability": "calendar", "view": "calendar-native", "read": "calendar.today", "source": "gws.calendar.today" }]`:
Jelly's own calendar reads the same method the **Today** tile calls, and draws it natively. `calendar.today` is
declared in `jelly.rpc` with `readOnly: true`, the label "read today's calendar", and the permission `gws.read`, the
permission `gws_read` already declares. Jelly calls it on the plugin's RPC named after the package,
`@joe-broadhead/opencode-gws`, through its core plugin's relay, with the input `{}`, and judges `gws.read` against
the agent's rules before the call reaches the plugin: an RPC call carries no session, so the plugin cannot ask
OpenCode itself. Outside Jelly, any client of the OpenCode server can call the method, as it can the status RPC.
The read therefore exposes event titles, locations and meeting links to any client of the OpenCode server, as the tools RPC can already reach `gws_read`, so serving OpenCode beyond localhost needs the server's own authentication.

`calendar.today` is deprecated until 0.1.0: the same read is the source contract's snapshot `gws.calendar.today`, the
method `calendar_today` on the tools RPC `google-workspace.gws.tools` (action `gws.calendar_today`), answering
`{ data: <agenda>, asOf, account, trust }` ([Sources](configuration.md#sources)). The hint names it:
`nativeData[0].source` is `gws.calendar.today`, so a Jelly with the source setting on reads Home's calendar from
`calendar_today`, and `view` and `read` stay for a Jelly without it (they go at contract version 2). The old method
answers as before for any other caller, and status says once it was called.

What it answers: `{ account, at, state, events }`.

- `account` is the alias of the account that answers: the implicit `default` account, or else the first configured
  account that enables `calendar`, interactive accounts before headless ones. It reads that account's primary
  calendar only and never says it checked another.
- Today is midnight to midnight in the primary calendar's own time zone, which the method reads from Google
  (`calendar.calendars.get`), not the machine's. A day with a clock change is 23 or 25 hours long.
- `events` are the entries of today not yet ended, at most 50, the earliest kept: `id` (Google's, or `sha256:<hex>`
  of one longer than 128 characters), `title` (at most 200 characters; "(No title)" when Google has none), `start`
  and `end` in UTC, `allDay: true` for an all-day entry (from the calendar's midnight to the next), and, when Google
  gives them, `location` (at most 200 characters), `url` (the event's Google Calendar link) and `joinUrl` (the
  event's Meet link, or else the video entry point of its conference). A link is kept only when it is https and
  carries no user name or password. Cancelled entries, entries the person declined and working-location entries are
  left out. Descriptions, guests and every other field are never read into the answer. The whole answer stays
  within 60 KB of JSON, under Jelly's 64 KB limit: when it would not, the latest-starting events are left out,
  whole, until it does, and the audit records how many as `omitted` on a `calendar.today` record.
- `state` is `ready` for a fresh reading. The method keeps its last good reading in memory and answers from it for a
  minute, so a tile that polls does not reach Google each time. When a later read fails, or takes more than eight
  seconds, it answers `stale` with the kept events of the same day and `at`, the time they were read. Nothing is
  written to disk.
- With nothing of today kept, a failure is the declared error `failed`, with the plugin's code and next step:
  `AUTH_REQUIRED` or `AUTH_SCOPE_MISSING` when the account must sign in (these also drop the kept reading, so a
  signed-out calendar is never shown as stale), `CALENDAR_UNAVAILABLE` when no account enables `calendar`, and
  the read's own code otherwise. Jelly shows any failure as "not available".

The method runs two reads through the plugin's read path, with the account's own sign-in and the read policy, as
`gws_read` does: `calendar.calendars.get` (`fields: timeZone`) and one page of `calendar.events.list` (single
events in start order, at most 250, with a field mask). It never downloads gws: when no verified copy is cached yet, the
method fails with `GWS_UNAVAILABLE`. A day with more than 250 entries is cut at 250.

`test/calendar.test.ts` checks the declaration against Jelly's native data rules, and the method against fake
Calendar answers; `test/host/calendar.test.ts` calls it on a real OpenCode host.

## Pictures in an agent's UI

`jelly.imageHosts` lists exactly the hosts the method takes: `drive.google.com` and Google's own image servers,
`lh3` to `lh7`, `lh7-rt` and `lh7-us` under `googleusercontent.com`, each by its full name. `jelly.imageRead` is
`{ "method": "images.read" }`: when an agent's UI shows a picture whose address is on one of those hosts, Jelly asks
this plugin for it, and the window never gets the address or a token. `images.read` is declared in `jelly.rpc` with
`readOnly: true`, the label "read a Google Workspace picture", and the permission `gws.read`, the one `gws_read`
declares. Jelly calls it on the RPC named after the package with `{ url }`, the picture's address, after judging
`gws.read` against the agent's rules: an ask or a deny shows no picture, and nobody is asked. Outside Jelly, any
client of the OpenCode server can call the method, as it can `calendar.today`.

What it answers: `{ mime, base64 }`, a PNG, JPEG, GIF or WebP of at most 1 MB. The type comes from the picture's first
bytes, never from a `Content-Type` or Drive's `mimeType`; SVG, HTML and every other kind are `IMAGE_TYPE_REFUSED`. A
picture over 1 MB is `IMAGE_TOO_LARGE`: the plugin stops reading at that size and answers nothing, never a picture cut
short. Jelly checks the answer again before it draws it.

Which addresses it takes. The address must be https, with no user name, password, port or IP address, on
`drive.google.com` or one of those image servers; anything else is `IMAGE_HOST_REFUSED`, and nothing is fetched. Any
other `googleusercontent.com` name is refused too: Apps Script pages and every Compute Engine machine's reverse DNS
name live there, so a prompt-injected agent could otherwise put data in a picture address and have the person's
machine send it to a server anyone can run. The plugin checks this itself, whatever Jelly checked.

- **A Drive link** (`https://drive.google.com/file/d/<id>/…`, `/open?id=`, `/uc?id=` or `/thumbnail?id=`) is never
  fetched. The plugin reads the file through gws, as the account, with the read policy and the audit, as `gws_read`
  does: `drive.files.get` with `fields: mimeType,size,thumbnailLink`, then, for a PNG, JPEG, GIF or WebP of at most
  1 MB, its bytes (`alt=media`). gws writes those bytes to a file in a private directory under the plugin's work
  folder, which the plugin reads back with the cap and removes before it answers. Any other file, and a picture over
  1 MB, answers its thumbnail; a file with neither is `IMAGE_UNAVAILABLE`.
- **An image-server address** (a Drive `thumbnailLink`, a Docs or Slides picture, a profile photo) is fetched over HTTPS by
  the plugin itself: gws reads Google's APIs, not an arbitrary address. A redirect is never followed, any answer but
  200 is `IMAGE_UNAVAILABLE`, no cookie or referrer is sent, and the size is checked while the body streams.

Where the account's token goes. Only to those image servers, and only for an address Google returned to that account
in this process: the plugin remembers, in memory for an hour, the addresses in the fields Google itself fills with a
picture or file link (Drive's `thumbnailLink`, `iconLink`, `webViewLink`, `webContentLink` and a user's `photoLink`,
Docs' `contentUri`, Slides' `contentUrl`, People's `photos[].url` and `coverPhotos[].url`, the Directory's
`thumbnailPhotoUrl`), at most 1,000, never the bytes. Text that people write, such as a document, a cell, an event's
description or a slide's `sourceUrl`, never counts. An image-server address Google did not return is fetched without
credentials, so a private picture there shows nothing. A credentials-file account's token stays inside gws, so its
pictures come only from Drive links.

Which account reads it: the one Google returned the address to; else the only account that enables `drive`; else the
`default` account when it is one of them. Otherwise it is `IMAGE_ACCOUNT_AMBIGUOUS`, and the plugin never tries each
account in turn. An account must also enable `drive` for its token to be used. When that account is signed out, the
answer is `AUTH_REQUIRED`; Jelly shows no picture, and its card for this plugin asks the person to sign in.

At most four pictures are read at once (one more is `IMAGE_UNAVAILABLE`), and each gives up after eight seconds,
inside Jelly's ten. A failure is the declared error `failed`, with the plugin's code and next step; Jelly shows any
failure as no picture. No error, log line or audit record names the address, the file or the token: an
`images.read` audit record notes only the outcome, the account, the duration and the code.

Jelly's limit today: Jelly's picture contract allows 1 MB (`AGENT_UI_IMAGE_MAX_BYTES`), but its host refuses any plugin
RPC answer over 64 KB of JSON (`VIEW_DATA_MAX_BYTES`), so a picture over about 47 KB, which base64 makes larger than
that, shows no picture in Jelly until Jelly lifts that limit for pictures. The plugin answers the whole picture
regardless; the limit is Jelly's.

`test/images.test.ts` checks the address gate, the token hosts, the cap while streaming, the type from the bytes, the
account rule and the declaration against Jelly's rules, all against fake answers with no network.

## Changes a person approves in an agent's UI

Off by default. `jelly.actions` declares one action, `commit`, with `ui: true`, so an agent can bind it to a button in
a UI it makes. It is plan-shaped: its input is a gws plan request, the same shape `gws_plan` takes, and this release
allows only one operation, a Sheets value update:

```json
{
  "account": "work",
  "operation": "sheets.spreadsheets.values.update",
  "params": { "spreadsheetId": "<id>", "range": "Invoices!D2:D3", "valueInputOption": "RAW" },
  "body": { "values": [["Paid"], ["Paid"]] }
}
```

To turn it on, list the operation in the plugin's options: `"uiActions": ["sheets.spreadsheets.values.update"]`. The
list takes no other value yet; a later release that supports more operations never turns them on for someone who
listed this one.

What the declaration says. Label "update cells in your Google Sheets"; `class: "local"`, so only an owner device can
take it; `confirm: "always"`, so Jelly asks every time; `summary: ["account", "params"]`; `preview: "plan.preview"`;
`tool: "gws.write"`, because an agent makes the same change with `gws_plan` then `gws_write`. It declares no `done`,
because Jelly's `{count}` is how many rows the person picked, not how many cells changed; the receipt says the label.

**The preview.** `plan.preview` is declared in `jelly.rpc` with `readOnly: true` and the permission `gws.plan`, so a
rule that denies `gws.plan` also stops the preview. Given the same input, it runs gws's own plan path (the account,
the service, every policy rule, the admin gate and the recipient rules) and `gws --dry-run`, stores no plan, and
answers in words: the category and operation, the account, the method and address, the spreadsheet and range, and
every cell it writes, row by row. Each field the agent wrote stays on its own line in reading order: the spreadsheet,
the range and every cell are quoted, and a control character, a line or paragraph separator (U+2028, U+2029) or a
bidi mark, embedding, override or isolate is shown as a visible `\uXXXX` escape, so a field cannot fake or reorder
a line. Those values are the input's own; they are shown to the person, never logged or audited. When the words would
be over the 4,000 characters Jelly's confirmation shows, the preview refuses rather than cut them short, and Jelly
then offers only Not now.

The preview is a dry run: it needs no grant, changes nothing, and writes no audit record. Like `calendar.today` and
`images.read`, any client of the OpenCode server can call it; it still refuses when `uiActions` does not list the
operation or `access` is `read-only`.

**The action.** Jelly's core plugin calls `act.commit` on the RPC named after the package with `{ input, grant }`. In
order, the plugin:

1. checks Jelly's grant, as Jelly's own verifier does: Jelly's action key (published in the engine), this plugin,
   the action `commit`, the digest of exactly this input, at most 60 seconds old, and never used before; the
   class must be `local`, and the grant's `cfm`, the confirmation Jelly drew before the person chose, must be
   `always`: a grant without one, or with `never` or `session`, is `UI_GRANT_REFUSED` before anything reaches Google.
   In stock OpenCode there is no Jelly key, so nothing can take the action;
2. refuses any operation but `sheets.spreadsheets.values.update`, `USER_ENTERED` (a value would be read as a
   formula, and a formula can send the sheet's contents elsewhere), any extra field, and more than 100 rows of 26
   cells (`UI_ACTION_REFUSED`);
3. refuses when `uiActions` does not list the operation (`UI_ACTION_OFF`), or `access` is `read-only`
   (`UI_ACTION_REFUSED`); at `ask-changes` it runs, because the person's every-time confirmation is the ask;
4. plans the change as the person, in a plan bound to this grant alone, through the same path as `gws_plan`, and
   commits it, single-use, as `gws_write` does;
5. answers what Google says changed: `{ account, operation, spreadsheetId, updatedRange, updatedRows,
   updatedColumns, updatedCells }`.

Every call, refused ones included, writes a `ui.act` audit record with `caller: "person"`, the Jelly member whose
device approved it (`member`, the grant's `mbr`) and the grant's id (`grant`, its `jti`); the plan and commit
records carry the same three. No record holds the values, the spreadsheet or the range.

**Whose rules apply.** On this path the person is acting, not an agent. The plugin's own settings apply: `access`
(read-only refuses), `uiActions`, the policy rules and the admin gate. The person's OpenCode permission rules for
agents are not consulted, because no agent or session makes the call: a rule of their own that denies or asks for
`gws_write` (or `gws.write`) holds an agent's commits, not this one. To stop it, leave `uiActions` empty, set
`access` to `read-only`, or add a policy rule that denies the change.

What the plugin cannot check yet, and has asked Jelly for:

- **That the preview was shown.** The grant binds the input, and the preview is worked out from that same input, so
  what is committed is what the preview describes; but nothing in the grant says the preview was drawn.
- **The receipt.** Jelly words it from the rows picked; the plugin's answer says what changed.
- **Whose Google account.** The grant names a Jelly member, not a Google account; owner devices only is the guard.

Jelly also gives an act ten seconds in all. The action runs a dry run and then the commit; when Google is slow, Jelly
can give up after the change was made. Check the sheet before asking again.

`test/ui-action.test.ts` checks every refusal above, that the preview is the plan the commit runs, the audit records,
and the declaration against Jelly's action rules.

## Signing in

`jelly.signIns` declares one sign-in, `google`, for OpenCode's integration `gws-*`: every account (`gws-<alias>`) folds into it, so the card waits while any account waits. The sign-in declares what Jelly does for it, so Jelly has no code of its own for gws:

- `account`: Jelly asks for an account's name and writes `{ "mode": "interactive" }` under it in `accounts`; gws has no account until one is named, so Jelly adds it to an agent with that question and never gives it blank. That account names no `enabledServices`, so it gets every service the `default` account enables, and its form starts on Read-only and still offers Read and write.
- `hostClient`: `{ "id": "google", "field": "clientJson", "replaces": ["clientId", "clientSecret"] }`. Jelly holds the person's OAuth clients and answers the hidden `clientJson` field with one, whole: the Desktop app client for a loopback sign-in. Its form shows only Access (starting on `default`, read-only) and the write acknowledgement while it applies, and no `oauthClient` option is needed.
- `needed`: `AUTH_REQUIRED` and `AUTH_SCOPE_MISSING`, the codes a gws tool result carries when an account must sign in again, so Jelly puts this card in front of the person.

These need Jelly 0.3.2 or later; an older Jelly refuses the declaration's new keys. When the engine runs on another machine than the person's browser, a host can also fill the form's hidden `redirectUri` and `callbackPort` fields, and answer `clientJson` with a Web application client that lists the redirect, so Google's redirect comes back through the host to the engine's listener; see [docs/auth.md](auth.md#sign-in-when-opencode-runs-on-another-machine). The sign-in declares `"relay": { "redirectField": "redirectUri", "portField": "callbackPort" }`: those are the two fields a Jelly web tab fills with its fixed relay address at Jelly ID and a loopback port for the listener (Jelly ADR 0019). The plugin's code is the same either way, and the Web application client must list that relay address.

Jelly folds the declared sign-ins into this plugin's one card, which shows each as Connected, Not signed in or Sign in again (expired or revoked), and starts, renews and signs out of each. An agent's `jelly_connection_request`, or a tool result that names this plugin's "Run /connect and choose …" next step, opens the same card. The plugin still signs in through OpenCode, as it does without Jelly; the declaration only tells Jelly which of the engine's integrations and servers are this plugin's.

The account's name on the card is its verified email: the method's `label` is the email Google returned at sign-in, else the alias. OpenCode keeps the label it gets at sign-in, so an account signed in with an earlier release shows its alias until the person signs it in again.

**An agent's copy.** The person signs in once, in their own engine; an agent given the account gets Jelly's copy of that sign-in (D210): the access token, `jelly-host-owns-refresh` in place of the refresh token, an expiry a day ahead, and every metadata key but the secret-named ones, so the client secret stays with the person. Every call reads the copy as it reads a sign-in: the token, the access level, the scopes Google granted, the email and the domain, which is all a tool, status, `/gws-status` or the source contract's `probe` needs. The client is read only to renew or to sign in again. Jelly renews the person's sign-in in their engine and puts the next copy in before this one runs out; the plugin reads the credential from OpenCode on every call and keeps no token, so it uses the new copy at once. If OpenCode ever asks the plugin to renew a copy (the refresh token is `jelly-host-owns-refresh`), it refuses with `AUTH_REQUIRED` and the sign-in-again step, without calling Google, and Jelly puts this card in front of the person. A sign-in without its client secret is never renewed either.

**Headless accounts are outside Jelly.** Jelly adds only interactive accounts. A `credentials_file` account hands gws a credentials file, and gws exchanges it for a token and caches that token, encrypted, in the plugin's own per-account directory, by design; an `access_token` account reads its environment variable, whose value is fixed when OpenCode starts. Neither is read from OpenCode's credential store, so neither is a copy Jelly can put in or replace.

## Settings

`jelly.contributes.settings` declares one setting, `access`, the option of the same name, as a choice of three:
**Allowed** (`all`, the default), **Ask before changes** (`ask-changes`) and **Read only** (`read-only`), with Jelly's
own line for each. Jelly draws it as a choice, never as free text, and saves only one of the three, the options
parser's own set. A Jelly that does not know declared choices (before app#1301) refuses the whole declaration. The
other options are not declared: `uiActions` is a list, `accounts`, `execution`, `policy` and `admin` are objects, and
Jelly writes only flat values. `test/jelly.test.ts` checks the setting against Jelly's setting rules, restated in
`test/support/jelly-settings.ts`, and each declared value against the options parser.

## Versions

Jelly's curated catalogue pins an exact version. Publish each release under a new version so a
review in Jelly can tell the two apart.

The declaration test runs the shared kit, `test/support/jelly-kit.ts`, which checks the declaration and this page against Jelly's plugin authors' standard. `scripts/check-copies.mjs` holds the kit and Jelly's setting rules (`test/support/jelly-settings.ts`) equal to the copies every plugin carries. The kit's list of keys does not yet name `nativeData`, `imageHosts`, `imageRead` or `actions`, so `test/jelly.test.ts` accepts those findings, and `test/calendar.test.ts`, `test/images.test.ts` and `test/ui-action.test.ts` check the fields instead.
