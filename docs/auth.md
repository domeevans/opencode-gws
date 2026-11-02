# Sign-in

Unofficial plugin. Not affiliated with Google.

An interactive account signs in through OpenCode: run `/connect` and choose **Google Workspace**, or run `opencode auth login gws-<alias>`. With more than one interactive account, each entry is named **Google Workspace (`<alias>`)**. With no `accounts` option the alias is `default`.

In the TUI, `/connect` shows the sign-in link: press `o` or Enter to open it in your browser. The CLI, `opencode auth login gws-<alias>`, opens the browser automatically. With no `accounts` option, the `default` account enables every service the plugin covers and the form starts on Read and write, which needs the acknowledgment; Read-only is the other choice. An account you configure without `access` starts on Read-only. The form lists the exact scopes before Google's consent screen.

Headless accounts do not use this flow. `credentials_file` reads a credentials file from the environment variable named by `credentialsFileEnv`. `access_token` reads a token from `tokenEnv`. Neither is a fallback. `/gws-doctor` is what checks them.

The plugin writes no credential file. Tokens stay in OpenCode's credential store. Refresh uses the client stored with that sign-in.

## The form

The form renders before authentication starts.

| Field | When it shows | What it does |
| --- | --- | --- |
| OAuth client ID, OAuth client secret | When no `oauthClient` option sets a client. | The ID and secret of your Desktop app client. Leave both blank to reuse the client from this account's previous sign-in. When `oauthClient` is set (for example by organisation config), both fields are hidden and submit the option's values. The host refuses a malformed ID or secret before any network call. |
| Access | Always | **Read-only** or **Read and write**. It starts on the account's configured access: Read and write for the implicit `default` account, Read-only for an account without `access`. Each option's description lists the scope URLs it will request. An account whose config sets `access` to read, with no write service, does not offer write. |
| I understand this grants write access | Required when Access is Read and write | The acknowledgment. Without it the sign-in stops with `AUTH_WRITE_UNCONFIRMED`. |

If Google shows `redirect_uri_mismatch`, the client is not a Desktop app.

## OAuth client

No Google OAuth client ships with the plugin. Each sign-in uses your own Desktop app client, or the one your organisation sets through `oauthClient`. Google treats a Desktop client's secret as non-confidential. Security does not rest on the secret. It rests on PKCE (S256), the loopback redirect to `127.0.0.1`, and the user's consent on Google's screen.

Precedence, first match wins:

1. `accounts.<alias>.oauthClient`
2. the plugin `oauthClient` (organisation managed config)
3. the client ID and secret entered in the `/connect` form
4. the client entered at the previous sign-in, when the fields are left blank

With none of these, the sign-in stops with `AUTH_CLIENT_REQUIRED`, and status says: run `/connect` and choose Google Workspace, then enter your Desktop OAuth client ID and secret, or ask your administrator.

Set `oauthClient` in user, project, or system config. An organisation client of user type **Internal** serves only that Workspace organisation. Do not put a client secret in a chat, a skill, or a commit message.

## Create your Desktop client

`/gws-status` gives the API link for each account that has no client yet.

1. **Create a project.** In the [Google Cloud console](https://console.cloud.google.com/projectcreate), create a project, or pick one you own.
2. **Enable the APIs.** Enable the API of each service the account uses. `/gws-status` gives one link per account, built from `enabledServices`.
3. **Set up the consent screen.** Open [Google Auth platform → Branding](https://console.developers.google.com/auth/branding) and fill in the app name and your email. Under [Audience](https://console.developers.google.com/auth/audience), choose **Internal** if the project belongs to your Workspace organisation. For **External**, add yourself as a test user; in **Testing** status Google expires refresh tokens after 7 days. Setting the app **In production** avoids that expiry, at the cost of an unverified-app warning on the consent screen.
4. **Create a Desktop client.** Under [Clients](https://console.developers.google.com/auth/clients), create a client of type **Desktop app**. A Web client does not work with the loopback redirect.
5. **Copy its ID and secret.** Copy the client ID (`….apps.googleusercontent.com`) and the client secret, then run `/connect`, choose Google Workspace, and enter them. Choose the access: every change still needs a plan and your approval.

Then run `/gws-doctor`. It makes one small read per enabled service and reports `OK`, `AUTH_REQUIRED`, `AUTH_SCOPE_MISSING`, or `API_DISABLED` with the enable URL.

## What the default consent asks for

The `default` account at Read and write requests every scope in the table below's Read and write column, plus the identity scopes: 46 scopes in one consent, under Google's limit of 64 per request.

- **Granular consent.** Google lists the scopes with a checkbox each. A scope you untick is not granted; `/gws-status` and `gws_status` list it under missing scopes, and the methods that need it fail with `AUTH_SCOPE_MISSING` until you sign in again and approve it.
- **External client in Testing.** Many of these scopes are sensitive or restricted (Gmail, Drive, and others). An External client shows Google's unverified-app warning for them, only its test users can sign in, and in Testing status Google expires its refresh tokens after 7 days, so you sign in again every week. An Internal client in your own Workspace organisation avoids all three.
- **APIs to enable** in the client's Cloud project, one per service: Gmail (`gmail.googleapis.com`), Drive (`drive.googleapis.com`), Calendar (`calendar-json.googleapis.com`), Docs (`docs.googleapis.com`), Sheets (`sheets.googleapis.com`), Slides (`slides.googleapis.com`), Tasks (`tasks.googleapis.com`), People (`people.googleapis.com`), Chat (`chat.googleapis.com`), Classroom (`classroom.googleapis.com`), Forms (`forms.googleapis.com`), Meet (`meet.googleapis.com`), Keep (`keep.googleapis.com`), Admin reports (`admin.googleapis.com`), Apps Script (`script.googleapis.com`), Workspace Events (`workspaceevents.googleapis.com`) and Model Armor (`modelarmor.googleapis.com`). `/gws-status` gives one link that enables them all for the account's services. A service whose API is off fails with `API_DISABLED`; the others still work.
- **Account requirements.** Keep and Chat need a Google Workspace account. Admin reports need a Workspace admin. Model Armor needs a Cloud project with the Model Armor API. The Apps Script API also needs the user's own switch at <https://script.google.com/home/usersettings>.

To ask for less, set `accounts` with only the services you use, or `access: "read"`, or choose Read-only in the form.

## What a sign-in requests

`access` is `"read"` (the default for an account you configure), `"write"` (the implicit `default` account), or a per-service map such as `{ "drive": "write" }`. A service a map omits stays read-only. Extra scopes on `accounts.<alias>.scopes` are always requested and always shown. Short names are accepted: `gmail.readonly` is stored as the scope URL.

Before a read or a plan, the plugin compares the operation's manifest scopes with the scopes Google granted. A miss fails with `AUTH_SCOPE_MISSING` and does not start `gws`. The next step is to sign in again and approve every scope Google lists, choosing Read and write when only that level requests the scope. A method only an app's own credentials can run (listed below) fails with a next step that says no sign-in can run it.

Model Armor has no read-only scope: Read and write requests `https://www.googleapis.com/auth/cloud-platform`, which grants access to the whole Cloud project, and Read-only requests nothing for it. The Model Armor helpers still cannot run; `gws_catalog` marks them and names no alternative.

<!-- generated:scopes -->

Generated from `src/domain/scopes.ts` and `src/domain/app-only.ts` by `npm run docs:coverage`. Do not edit this section by hand.

Every interactive sign-in also requests the identity scopes `openid`, `https://www.googleapis.com/auth/userinfo.email`, `https://www.googleapis.com/auth/userinfo.profile`. A short name such as `gmail.readonly` is the same scope as `https://www.googleapis.com/auth/gmail.readonly`.

| Service | Read-only | Read and write |
| --- | --- | --- |
| admin-reports | `https://www.googleapis.com/auth/admin.reports.audit.readonly`<br>`https://www.googleapis.com/auth/admin.reports.usage.readonly` | `https://www.googleapis.com/auth/admin.reports.audit.readonly`<br>`https://www.googleapis.com/auth/admin.reports.usage.readonly` |
| calendar | `https://www.googleapis.com/auth/calendar.readonly` | `https://www.googleapis.com/auth/calendar` |
| chat | `https://www.googleapis.com/auth/chat.spaces.readonly`<br>`https://www.googleapis.com/auth/chat.messages.readonly`<br>`https://www.googleapis.com/auth/chat.memberships.readonly` | `https://www.googleapis.com/auth/chat.spaces`<br>`https://www.googleapis.com/auth/chat.messages`<br>`https://www.googleapis.com/auth/chat.memberships`<br>`https://www.googleapis.com/auth/chat.delete`<br>`https://www.googleapis.com/auth/chat.customemojis`<br>`https://www.googleapis.com/auth/chat.users.availability`<br>`https://www.googleapis.com/auth/chat.users.readstate`<br>`https://www.googleapis.com/auth/chat.users.sections`<br>`https://www.googleapis.com/auth/chat.users.spacesettings` |
| classroom | `https://www.googleapis.com/auth/classroom.courses.readonly`<br>`https://www.googleapis.com/auth/classroom.coursework.me.readonly`<br>`https://www.googleapis.com/auth/classroom.announcements.readonly` | `https://www.googleapis.com/auth/classroom.courses`<br>`https://www.googleapis.com/auth/classroom.coursework.me`<br>`https://www.googleapis.com/auth/classroom.announcements`<br>`https://www.googleapis.com/auth/classroom.coursework.students`<br>`https://www.googleapis.com/auth/classroom.courseworkmaterials`<br>`https://www.googleapis.com/auth/classroom.guardianlinks.students`<br>`https://www.googleapis.com/auth/classroom.rosters`<br>`https://www.googleapis.com/auth/classroom.topics` |
| docs | `https://www.googleapis.com/auth/documents.readonly` | `https://www.googleapis.com/auth/documents` |
| drive | `https://www.googleapis.com/auth/drive.readonly` | `https://www.googleapis.com/auth/drive`<br>`https://www.googleapis.com/auth/drive.apps.readonly` |
| events | `https://www.googleapis.com/auth/chat.spaces.readonly`<br>`https://www.googleapis.com/auth/chat.messages.readonly`<br>`https://www.googleapis.com/auth/chat.memberships.readonly`<br>`https://www.googleapis.com/auth/drive.readonly`<br>`https://www.googleapis.com/auth/meetings.space.readonly` | `https://www.googleapis.com/auth/chat.spaces`<br>`https://www.googleapis.com/auth/chat.messages`<br>`https://www.googleapis.com/auth/chat.memberships`<br>`https://www.googleapis.com/auth/chat.delete`<br>`https://www.googleapis.com/auth/chat.customemojis`<br>`https://www.googleapis.com/auth/chat.users.availability`<br>`https://www.googleapis.com/auth/chat.users.readstate`<br>`https://www.googleapis.com/auth/chat.users.sections`<br>`https://www.googleapis.com/auth/chat.users.spacesettings`<br>`https://www.googleapis.com/auth/drive`<br>`https://www.googleapis.com/auth/drive.apps.readonly`<br>`https://www.googleapis.com/auth/meetings.space.created`<br>`https://www.googleapis.com/auth/meetings.space.readonly` |
| forms | `https://www.googleapis.com/auth/forms.body.readonly`<br>`https://www.googleapis.com/auth/forms.responses.readonly` | `https://www.googleapis.com/auth/forms.body`<br>`https://www.googleapis.com/auth/forms.responses.readonly`<br>`https://www.googleapis.com/auth/drive.file` |
| gmail | `https://www.googleapis.com/auth/gmail.readonly` | `https://www.googleapis.com/auth/gmail.modify`<br>`https://www.googleapis.com/auth/gmail.settings.basic`<br>`https://www.googleapis.com/auth/gmail.settings.sharing`<br>`https://mail.google.com/` |
| keep | `https://www.googleapis.com/auth/keep.readonly` | `https://www.googleapis.com/auth/keep` |
| meet | `https://www.googleapis.com/auth/meetings.space.readonly` | `https://www.googleapis.com/auth/meetings.space.created`<br>`https://www.googleapis.com/auth/meetings.space.readonly` |
| modelarmor | _(none)_ | `https://www.googleapis.com/auth/cloud-platform` |
| people | `https://www.googleapis.com/auth/contacts.readonly`<br>`https://www.googleapis.com/auth/contacts.other.readonly`<br>`https://www.googleapis.com/auth/directory.readonly` | `https://www.googleapis.com/auth/contacts`<br>`https://www.googleapis.com/auth/contacts.other.readonly`<br>`https://www.googleapis.com/auth/directory.readonly` |
| script | `https://www.googleapis.com/auth/script.projects.readonly`<br>`https://www.googleapis.com/auth/script.processes`<br>`https://www.googleapis.com/auth/script.metrics` | `https://www.googleapis.com/auth/script.projects`<br>`https://www.googleapis.com/auth/script.processes`<br>`https://www.googleapis.com/auth/script.metrics` |
| sheets | `https://www.googleapis.com/auth/spreadsheets.readonly` | `https://www.googleapis.com/auth/spreadsheets` |
| slides | `https://www.googleapis.com/auth/presentations.readonly` | `https://www.googleapis.com/auth/presentations` |
| tasks | `https://www.googleapis.com/auth/tasks.readonly` | `https://www.googleapis.com/auth/tasks` |
| workflow | `https://www.googleapis.com/auth/gmail.readonly`<br>`https://www.googleapis.com/auth/calendar.readonly`<br>`https://www.googleapis.com/auth/tasks.readonly`<br>`https://www.googleapis.com/auth/drive.readonly` | `https://www.googleapis.com/auth/gmail.modify`<br>`https://www.googleapis.com/auth/gmail.settings.basic`<br>`https://www.googleapis.com/auth/gmail.settings.sharing`<br>`https://mail.google.com/`<br>`https://www.googleapis.com/auth/calendar`<br>`https://www.googleapis.com/auth/tasks`<br>`https://www.googleapis.com/auth/drive`<br>`https://www.googleapis.com/auth/drive.apps.readonly` |

Read methods that the read-only set does not cover, so they need a Read and write sign-in:

- `calendar.acl.list`
- `chat.customEmojis.get`
- `chat.customEmojis.list`
- `chat.users.availability.get`
- `chat.users.sections.items.list`
- `chat.users.sections.list`
- `chat.users.spaces.getSpaceReadState`
- `chat.users.spaces.spaceNotificationSetting.get`
- `chat.users.spaces.threads.getThreadReadState`
- `classroom.courses.courseWorkMaterials.get`
- `classroom.courses.courseWorkMaterials.list`
- `classroom.courses.studentGroups.list`
- `classroom.courses.studentGroups.studentGroupMembers.list`
- `classroom.courses.students.get`
- `classroom.courses.students.list`
- `classroom.courses.teachers.get`
- `classroom.courses.teachers.list`
- `classroom.courses.topics.get`
- `classroom.courses.topics.list`
- `classroom.invitations.get`
- `classroom.invitations.list`
- `classroom.userProfiles.get`
- `classroom.userProfiles.guardianInvitations.get`
- `classroom.userProfiles.guardianInvitations.list`
- `classroom.userProfiles.guardians.get`
- `classroom.userProfiles.guardians.list`
- `drive.apps.list`
- `drive.files.generateIds`
- `sheets.spreadsheets.developerMetadata.get`
- `sheets.spreadsheets.developerMetadata.search`
- `sheets.spreadsheets.getByDataFilter`
- `sheets.spreadsheets.values.batchGetByDataFilter`

Google grants `https://www.googleapis.com/auth/chat.bot`, `https://www.googleapis.com/auth/chat.import`, `https://www.googleapis.com/auth/classroom.addons.student`, `https://www.googleapis.com/auth/classroom.addons.teacher` only to an app's own credentials (a Chat app or a Classroom add-on), so no access level requests them. These methods accept nothing else, so no Google sign-in can run them; `gws_catalog` and `gws_schema` mark them `appOnly`:

- `chat.spaces.completeImport`
- `chat.spaces.messages.attachments.get`
- `chat.spaces.messages.replaceCards`
- `classroom.courses.announcements.addOnAttachments.create`
- `classroom.courses.announcements.addOnAttachments.delete`
- `classroom.courses.announcements.addOnAttachments.get`
- `classroom.courses.announcements.addOnAttachments.list`
- `classroom.courses.announcements.addOnAttachments.patch`
- `classroom.courses.announcements.getAddOnContext`
- `classroom.courses.courseWork.addOnAttachments.create`
- `classroom.courses.courseWork.addOnAttachments.delete`
- `classroom.courses.courseWork.addOnAttachments.get`
- `classroom.courses.courseWork.addOnAttachments.list`
- `classroom.courses.courseWork.addOnAttachments.patch`
- `classroom.courses.courseWork.addOnAttachments.studentSubmissions.patch`
- `classroom.courses.courseWork.getAddOnContext`
- `classroom.courses.courseWorkMaterials.addOnAttachments.create`
- `classroom.courses.courseWorkMaterials.addOnAttachments.delete`
- `classroom.courses.courseWorkMaterials.addOnAttachments.get`
- `classroom.courses.courseWorkMaterials.addOnAttachments.list`
- `classroom.courses.courseWorkMaterials.addOnAttachments.patch`
- `classroom.courses.courseWorkMaterials.getAddOnContext`
- `classroom.courses.posts.addOnAttachments.create`
- `classroom.courses.posts.addOnAttachments.delete`
- `classroom.courses.posts.addOnAttachments.get`
- `classroom.courses.posts.addOnAttachments.list`
- `classroom.courses.posts.addOnAttachments.patch`
- `classroom.courses.posts.addOnAttachments.studentSubmissions.patch`
- `classroom.courses.posts.getAddOnContext`

<!-- /generated:scopes -->

## After sign-in

`/gws-status` and `gws_status` show, per account, the mode, access, client source (`account`, `plugin`, or `pasted`), granted scopes, scopes still missing for the enabled services, and a next step. The TUI status dialog shows the same fields. The status RPC carries those account fields.
