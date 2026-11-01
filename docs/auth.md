# Sign-in

Unofficial plugin. Not affiliated with Google.

An interactive account signs in through OpenCode: run `/connect` and choose **Google Workspace**, or run `opencode auth login gws-<alias>`. With more than one interactive account, each entry is named **Google Workspace (`<alias>`)**. With no `accounts` option the alias is `default`.

In the TUI, `/connect` shows the sign-in link: press `o` or Enter to open it in your browser. The CLI, `opencode auth login gws-<alias>`, opens the browser automatically. The default access is read-only. Read and write is an explicit choice, and the form lists the exact scopes before Google's consent screen.

Headless accounts do not use this flow. `credentials_file` reads a credentials file from the environment variable named by `credentialsFileEnv`. `access_token` reads a token from `tokenEnv`. Neither is a fallback. `/gws-doctor` is what checks them.

The plugin writes no credential file. Tokens stay in OpenCode's credential store. Refresh uses the client stored with that sign-in.

## The form

The form renders before authentication starts.

| Field | When it shows | What it does |
| --- | --- | --- |
| OAuth client ID, OAuth client secret | When no `oauthClient` option sets a client. | The ID and secret of your Desktop app client. Leave both blank to reuse the client from this account's previous sign-in. When `oauthClient` is set (for example by organisation config), both fields are hidden and submit the option's values. The host refuses a malformed ID or secret before any network call. |
| Access | Always | **Read-only (recommended)** or **Read and write**. Each option's description lists the scope URLs it will request. An account whose config sets `access` to read, with no write service, does not offer write. |
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
5. **Copy its ID and secret.** Copy the client ID (`….apps.googleusercontent.com`) and the client secret, then run `/connect`, choose Google Workspace, and enter them. Choose Read-only unless agents must change Workspace data.

Then run `/gws-doctor`. It makes one small read per enabled service and reports `OK`, `AUTH_REQUIRED`, `AUTH_SCOPE_MISSING`, or `API_DISABLED` with the enable URL.

## What a sign-in requests

`access` is `"read"` (the default), `"write"`, or a per-service map such as `{ "drive": "write" }`. A service a map omits stays read-only. Extra scopes on `accounts.<alias>.scopes` are always requested and always shown. Short names are accepted: `gmail.readonly` is stored as the scope URL.

Before a read or a plan, the plugin compares the operation's manifest scopes with the scopes Google granted. A miss fails with `AUTH_SCOPE_MISSING` and does not start `gws`. The next step is to sign in again with Read and write, or to add the scope to `accounts.<alias>.scopes`.

Model Armor is not in either access level. Add `https://www.googleapis.com/auth/cloud-platform` to that account's `scopes` if you enable the service. The helpers still cannot run; `gws_catalog` marks them and names no alternative.

<!-- generated:scopes -->

Generated from `src/domain/scopes.ts` by `npm run docs:coverage`. Do not edit this section by hand.

Every interactive sign-in also requests the identity scopes `openid`, `https://www.googleapis.com/auth/userinfo.email`, `https://www.googleapis.com/auth/userinfo.profile`. A short name such as `gmail.readonly` is the same scope as `https://www.googleapis.com/auth/gmail.readonly`.

| Service | Read-only | Read and write |
| --- | --- | --- |
| admin-reports | `https://www.googleapis.com/auth/admin.reports.audit.readonly`<br>`https://www.googleapis.com/auth/admin.reports.usage.readonly` | `https://www.googleapis.com/auth/admin.reports.audit.readonly`<br>`https://www.googleapis.com/auth/admin.reports.usage.readonly` |
| calendar | `https://www.googleapis.com/auth/calendar.readonly` | `https://www.googleapis.com/auth/calendar` |
| chat | `https://www.googleapis.com/auth/chat.spaces.readonly`<br>`https://www.googleapis.com/auth/chat.messages.readonly`<br>`https://www.googleapis.com/auth/chat.memberships.readonly` | `https://www.googleapis.com/auth/chat.spaces`<br>`https://www.googleapis.com/auth/chat.messages`<br>`https://www.googleapis.com/auth/chat.memberships` |
| classroom | `https://www.googleapis.com/auth/classroom.courses.readonly`<br>`https://www.googleapis.com/auth/classroom.coursework.me.readonly`<br>`https://www.googleapis.com/auth/classroom.announcements.readonly` | `https://www.googleapis.com/auth/classroom.courses`<br>`https://www.googleapis.com/auth/classroom.coursework.me`<br>`https://www.googleapis.com/auth/classroom.announcements` |
| docs | `https://www.googleapis.com/auth/documents.readonly` | `https://www.googleapis.com/auth/documents` |
| drive | `https://www.googleapis.com/auth/drive.readonly` | `https://www.googleapis.com/auth/drive` |
| events | `https://www.googleapis.com/auth/chat.spaces.readonly`<br>`https://www.googleapis.com/auth/chat.messages.readonly`<br>`https://www.googleapis.com/auth/chat.memberships.readonly`<br>`https://www.googleapis.com/auth/drive.readonly`<br>`https://www.googleapis.com/auth/meetings.space.readonly` | `https://www.googleapis.com/auth/chat.spaces`<br>`https://www.googleapis.com/auth/chat.messages`<br>`https://www.googleapis.com/auth/chat.memberships`<br>`https://www.googleapis.com/auth/drive`<br>`https://www.googleapis.com/auth/meetings.space.created`<br>`https://www.googleapis.com/auth/meetings.space.readonly` |
| forms | `https://www.googleapis.com/auth/forms.body.readonly`<br>`https://www.googleapis.com/auth/forms.responses.readonly` | `https://www.googleapis.com/auth/forms.body`<br>`https://www.googleapis.com/auth/forms.responses.readonly`<br>`https://www.googleapis.com/auth/drive.file` |
| gmail | `https://www.googleapis.com/auth/gmail.readonly` | `https://www.googleapis.com/auth/gmail.modify` |
| keep | `https://www.googleapis.com/auth/keep.readonly` | `https://www.googleapis.com/auth/keep` |
| meet | `https://www.googleapis.com/auth/meetings.space.readonly` | `https://www.googleapis.com/auth/meetings.space.created`<br>`https://www.googleapis.com/auth/meetings.space.readonly` |
| modelarmor | _(none)_ | _(none)_ |
| people | `https://www.googleapis.com/auth/contacts.readonly` | `https://www.googleapis.com/auth/contacts` |
| script | `https://www.googleapis.com/auth/script.projects.readonly`<br>`https://www.googleapis.com/auth/script.processes`<br>`https://www.googleapis.com/auth/script.metrics` | `https://www.googleapis.com/auth/script.projects`<br>`https://www.googleapis.com/auth/script.processes`<br>`https://www.googleapis.com/auth/script.metrics` |
| sheets | `https://www.googleapis.com/auth/spreadsheets.readonly` | `https://www.googleapis.com/auth/spreadsheets` |
| slides | `https://www.googleapis.com/auth/presentations.readonly` | `https://www.googleapis.com/auth/presentations` |
| tasks | `https://www.googleapis.com/auth/tasks.readonly` | `https://www.googleapis.com/auth/tasks` |
| workflow | `https://www.googleapis.com/auth/gmail.readonly`<br>`https://www.googleapis.com/auth/calendar.readonly`<br>`https://www.googleapis.com/auth/tasks.readonly`<br>`https://www.googleapis.com/auth/drive.readonly` | `https://www.googleapis.com/auth/gmail.modify`<br>`https://www.googleapis.com/auth/calendar`<br>`https://www.googleapis.com/auth/tasks`<br>`https://www.googleapis.com/auth/drive` |

Read methods that the read-only set does not cover, so they need a Read and write sign-in:

- `calendar.acl.list`
- `drive.files.generateIds`
- `sheets.spreadsheets.developerMetadata.get`
- `sheets.spreadsheets.developerMetadata.search`
- `sheets.spreadsheets.getByDataFilter`
- `sheets.spreadsheets.values.batchGetByDataFilter`

Methods neither access level covers. Add one of the method's manifest scopes to the account's `scopes`; every sign-in then requests it and shows it:

- `chat.customEmojis.create`
- `chat.customEmojis.delete`
- `chat.customEmojis.get`
- `chat.customEmojis.list`
- `chat.spaces.completeImport`
- `chat.spaces.delete`
- `chat.spaces.messages.attachments.get`
- `chat.spaces.messages.replaceCards`
- `chat.users.availability.get`
- `chat.users.availability.markAsActive`
- `chat.users.availability.markAsAway`
- `chat.users.availability.markAsDoNotDisturb`
- `chat.users.availability.patch`
- `chat.users.sections.create`
- `chat.users.sections.delete`
- `chat.users.sections.items.list`
- `chat.users.sections.items.move`
- `chat.users.sections.list`
- `chat.users.sections.patch`
- `chat.users.sections.position`
- `chat.users.spaces.getSpaceReadState`
- `chat.users.spaces.spaceNotificationSetting.get`
- `chat.users.spaces.spaceNotificationSetting.patch`
- `chat.users.spaces.threads.getThreadReadState`
- `chat.users.spaces.updateSpaceReadState`
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
- `classroom.courses.courseWork.create`
- `classroom.courses.courseWork.delete`
- `classroom.courses.courseWork.getAddOnContext`
- `classroom.courses.courseWork.modifyAssignees`
- `classroom.courses.courseWork.patch`
- `classroom.courses.courseWork.rubrics.create`
- `classroom.courses.courseWork.rubrics.delete`
- `classroom.courses.courseWork.rubrics.patch`
- `classroom.courses.courseWork.studentSubmissions.return`
- `classroom.courses.courseWork.updateRubric`
- `classroom.courses.courseWorkMaterials.addOnAttachments.create`
- `classroom.courses.courseWorkMaterials.addOnAttachments.delete`
- `classroom.courses.courseWorkMaterials.addOnAttachments.get`
- `classroom.courses.courseWorkMaterials.addOnAttachments.list`
- `classroom.courses.courseWorkMaterials.addOnAttachments.patch`
- `classroom.courses.courseWorkMaterials.create`
- `classroom.courses.courseWorkMaterials.delete`
- `classroom.courses.courseWorkMaterials.get`
- `classroom.courses.courseWorkMaterials.getAddOnContext`
- `classroom.courses.courseWorkMaterials.list`
- `classroom.courses.courseWorkMaterials.patch`
- `classroom.courses.posts.addOnAttachments.create`
- `classroom.courses.posts.addOnAttachments.delete`
- `classroom.courses.posts.addOnAttachments.get`
- `classroom.courses.posts.addOnAttachments.list`
- `classroom.courses.posts.addOnAttachments.patch`
- `classroom.courses.posts.addOnAttachments.studentSubmissions.patch`
- `classroom.courses.posts.getAddOnContext`
- `classroom.courses.studentGroups.create`
- `classroom.courses.studentGroups.delete`
- `classroom.courses.studentGroups.list`
- `classroom.courses.studentGroups.patch`
- `classroom.courses.studentGroups.studentGroupMembers.create`
- `classroom.courses.studentGroups.studentGroupMembers.delete`
- `classroom.courses.studentGroups.studentGroupMembers.list`
- `classroom.courses.students.create`
- `classroom.courses.students.delete`
- `classroom.courses.students.get`
- `classroom.courses.students.list`
- `classroom.courses.teachers.create`
- `classroom.courses.teachers.delete`
- `classroom.courses.teachers.get`
- `classroom.courses.teachers.list`
- `classroom.courses.topics.create`
- `classroom.courses.topics.delete`
- `classroom.courses.topics.get`
- `classroom.courses.topics.list`
- `classroom.courses.topics.patch`
- `classroom.invitations.accept`
- `classroom.invitations.create`
- `classroom.invitations.delete`
- `classroom.invitations.get`
- `classroom.invitations.list`
- `classroom.userProfiles.get`
- `classroom.userProfiles.guardianInvitations.create`
- `classroom.userProfiles.guardianInvitations.get`
- `classroom.userProfiles.guardianInvitations.list`
- `classroom.userProfiles.guardianInvitations.patch`
- `classroom.userProfiles.guardians.delete`
- `classroom.userProfiles.guardians.get`
- `classroom.userProfiles.guardians.list`
- `drive.apps.list`
- `gmail.users.messages.batchDelete`
- `gmail.users.messages.delete`
- `gmail.users.settings.cse.identities.create`
- `gmail.users.settings.cse.identities.delete`
- `gmail.users.settings.cse.identities.patch`
- `gmail.users.settings.cse.keypairs.create`
- `gmail.users.settings.cse.keypairs.disable`
- `gmail.users.settings.cse.keypairs.enable`
- `gmail.users.settings.cse.keypairs.obliterate`
- `gmail.users.settings.delegates.create`
- `gmail.users.settings.delegates.delete`
- `gmail.users.settings.filters.create`
- `gmail.users.settings.filters.delete`
- `gmail.users.settings.forwardingAddresses.create`
- `gmail.users.settings.forwardingAddresses.delete`
- `gmail.users.settings.sendAs.create`
- `gmail.users.settings.sendAs.delete`
- `gmail.users.settings.sendAs.patch`
- `gmail.users.settings.sendAs.smimeInfo.delete`
- `gmail.users.settings.sendAs.smimeInfo.insert`
- `gmail.users.settings.sendAs.smimeInfo.setDefault`
- `gmail.users.settings.sendAs.update`
- `gmail.users.settings.sendAs.verify`
- `gmail.users.settings.updateAutoForwarding`
- `gmail.users.settings.updateImap`
- `gmail.users.settings.updateLanguage`
- `gmail.users.settings.updatePop`
- `gmail.users.settings.updateVacation`
- `gmail.users.threads.delete`
- `people.otherContacts.list`
- `people.otherContacts.search`
- `people.people.listDirectoryPeople`
- `people.people.searchDirectoryPeople`

<!-- /generated:scopes -->

## After sign-in

`/gws-status` and `gws_status` show, per account, the mode, access, client source (`account`, `plugin`, or `pasted`), granted scopes, scopes still missing for the enabled services, and a next step. The TUI status dialog shows the same fields. The status RPC carries those account fields.
