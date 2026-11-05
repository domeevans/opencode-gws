---
name: opencode-gws-recipes
description: Use for ready gws_read and gws_plan requests for everyday Google Workspace tasks: unread or recent mail and who sent it, mail in a time window, replies and drafts, the next meetings or a week's schedule, finding, summarising, sharing or trashing Drive files and Google Docs, reading or appending Sheets rows, and the standup, meeting-prep and weekly-digest reports. Prefer it to any gws-* CLI skill.
---

# Recipes

Copy the shape and replace the ids. `opencode-gws` covers accounts, plan then commit, and errors. Each list example asks only for what the task needs; add a field when you need one.

## Gmail

- **A time window.** `after:` and `before:` take Unix seconds, so compute them for the user's zone. 09:00 to 12:00 on 2026-11-03 at UTC+1 is `after:1793692800 before:1793703600`. `after:2026/11/03` means a whole day, and `newer_than:` takes only `d`, `m` or `y`.
- **Who sent it.** Get each message with `format: "metadata"`, which skips the body. For the text, use `gmail.read` with `{"id": "...", "format": "text"}`. For a whole conversation, use `gmail.users.threads.get` with `format: "metadata"`.
- **Exact unread count.** Read `gmail.users.labels.get`, not a list's `resultSizeEstimate`.

```json
{ "operation": "gmail.users.messages.list", "params": { "userId": "me", "q": "after:1793692800 before:1793703600", "maxResults": 100 }, "fields": "messages(id),nextPageToken" }
```

```json
{ "operation": "gmail.users.messages.get", "params": { "userId": "me", "id": "MESSAGE_ID", "format": "metadata", "metadataHeaders": ["From", "Subject", "Date"] }, "fields": "id,payload/headers" }
```

```json
{ "operation": "gmail.users.labels.get", "params": { "userId": "me", "id": "INBOX" }, "fields": "messagesUnread,threadsUnread" }
```

- **Send, reply, forward.** Use `gmail.send` (`to`, `subject`, `body`, `cc`, `bcc`, `attachments`), or `gmail.reply`, `gmail.reply-all` or `gmail.forward` with `messageId`. Each plans as send. The preview lists everyone it reaches, including the sender a reply answers. Commit with `gws_send`.
- **Draft.** Add `"draft": true`. It plans as write and reaches no one, so commit with `gws_write`. Sending the draft later is `gmail.users.drafts.send`, which is a send.

```json
{ "operation": "gmail.reply", "input": { "messageId": "MESSAGE_ID", "body": "Thanks, Thursday works.", "draft": true } }
```

## Calendar

- **Next meetings.** Always set `timeMin` to now. Without it, `orderBy: "startTime"` returns the calendar's oldest events. `timeMin` also returns events still running, such as all-day ones (`start.date`), so ask for more than you need (`maxResults: 10`) and skip those when the user means meetings. `singleEvents: true` expands recurring meetings.
- **A range, such as next week.** Set `timeMin` to Monday 00:00 and `timeMax` to the next Monday 00:00, both with the user's offset. Put `timeZone` in `fields` to learn the calendar's zone without another call. Count each event on its local start date. All-day events have `start.date`, not `start.dateTime`.
- **The helper.** `calendar.agenda` takes `today`, `tomorrow`, `week` or `days`, plus `timezone`. It is smaller than a full events list.

```json
{ "operation": "calendar.events.list", "params": { "calendarId": "primary", "timeMin": "2026-11-05T14:30:00+01:00", "singleEvents": true, "orderBy": "startTime", "maxResults": 10 }, "fields": "timeZone,items(summary,start,end,htmlLink),nextPageToken" }
```

```json
{ "operation": "calendar.agenda", "input": { "week": true, "timezone": "Europe/Amsterdam" } }
```

- **An event.** `calendar.events.insert` with `calendarId: "primary"` and a body with `summary`, `start` and `end`. It plans as write. With `sendUpdates: "all"` it emails the guests and plans as send.

## Drive and Docs

- **Search.** Drive's `q` uses clauses joined by `and`: `name contains 'budget'`, `fullText contains 'offsite'`, `'me' in owners` and `trashed = false`. A Doc is `mimeType = 'application/vnd.google-apps.document'`, and a Sheet is `mimeType = 'application/vnd.google-apps.spreadsheet'`. For "the one I edited", order by `modifiedByMeTime desc`; otherwise use `modifiedTime desc`.

```json
{ "operation": "drive.files.list", "params": { "q": "mimeType = 'application/vnd.google-apps.document' and trashed = false", "orderBy": "modifiedByMeTime desc", "pageSize": 1 }, "fields": "files(id,name,modifiedTime,webViewLink,ownedByMe,capabilities/canTrash)" }
```

- **A Doc's text.** Read it with this mask. The full document is about five times larger. `drive.files.export` is not a read: it writes a file to disk after a prompt, so don't use it to read a Doc.

```json
{ "operation": "docs.documents.get", "params": { "documentId": "DOCUMENT_ID" }, "fields": "title,body/content/paragraph/elements/textRun/content" }
```

- **Edit a Doc.** `docs.documents.batchUpdate` with `{"requests": [{"insertText": {"location": {"index": 1}, "text": "..."}}]}`. Index 1 is the start of the body. It plans as write.
- **Trash (the bin).** Use `drive.files.update` with `"body": {"trashed": true}`. It plans as delete, so commit with `gws_delete`. The owner can restore it from the trash for 30 days. People it is shared with keep access until it is permanently deleted. Only the owner can trash a file (on a shared drive, an organizer or file organizer, with `supportsAllDrives: true`). Ask for `ownedByMe` and `capabilities/canTrash` in the list, as above, so you need no extra call. `drive.files.delete` is a permanent delete that removes everyone's access, so never use it for "bin" or "trash".

```json
{ "operation": "drive.files.update", "params": { "fileId": "FILE_ID" }, "body": { "trashed": true } }
```

- **Share.** `drive.permissions.create` with `fileId` and a body such as `{"type": "user", "role": "reader", "emailAddress": "..."}`. It plans as share.
- **Upload.** `drive.files.create` with a `body` (`name`, `mimeType`) and the plugin's own top-level `"upload": {"path": "/absolute/file.pdf", "mime": "application/pdf"}`. `gws_schema` doesn't show `upload`.

## Sheets

- **Read.** `sheets.read` with `{"spreadsheet": "ID", "range": "A1:D20"}`. A range without a sheet name reads the first sheet, so don't guess a name such as `Sheet1`.
- **Append rows.** `sheets.spreadsheets.values.append` with `range: "A1"`, `valueInputOption: "USER_ENTERED"` and `{"values": [[...]]}`. It plans as write.

## Reports

`workflow.standup-report`, `workflow.meeting-prep` and `workflow.weekly-digest` are reads. Run them with `gws_read`, and `input: {"format": "json"}` for structured data.

```json
{ "operation": "workflow.standup-report", "input": { "format": "json" } }
```

Login activity is Admin SDK Reports. It needs an account for a Workspace admin with the Reports privilege. Any other account gets `ADMIN_PRIVILEGE_REQUIRED`, which signing in again as the same account won't fix.

```json
{ "operation": "admin-reports.activities.list", "params": { "userKey": "all", "applicationName": "login", "startTime": "2026-11-04T14:30:00Z" }, "fields": "items(actor/email,id/time,events/name),nextPageToken" }
```
