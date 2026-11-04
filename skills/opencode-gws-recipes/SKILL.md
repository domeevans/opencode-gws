---
name: opencode-gws-recipes
description: Use when building a Gmail, Drive, Calendar, Docs, or Sheets request for gws_read or gws_plan.
---

# Recipes

These are exact requests for the everyday Gmail, Drive, Calendar, Docs, and Sheets tasks. Copy the shape. Replace the placeholder ids and text. Confirm the parameters with `gws_schema` when the task is not one of these.

Pass `account` only when `gws_status` shows more than one account. `fields` is required on list and search. A change is `gws_plan`, then the commit tool of the **returned** category, with only `{ "planId": "<planId>" }`. Show the preview first.

If `gws_catalog` says `executable` is false, do not call that id. Use `alternative`.

## Gmail

Unread inbox, read:

```json
{
  "operation": "gmail.users.messages.list",
  "params": { "userId": "me", "q": "is:unread", "maxResults": 10 },
  "fields": "messages(id,threadId),nextPageToken"
}
```

Mail between two times, read. `after:` and `before:` take Unix seconds; `newer_than:` and `older_than:` take only days, months, or years:

```json
{
  "operation": "gmail.users.messages.list",
  "params": { "userId": "me", "q": "after:1767225600 before:1767312000", "maxResults": 100 },
  "fields": "messages(id,threadId),nextPageToken"
}
```

Sender, subject, and date of one message, read, without the body:

```json
{
  "operation": "gmail.users.messages.get",
  "params": { "userId": "me", "id": "MESSAGE_ID", "format": "metadata", "metadataHeaders": ["From", "Subject"] },
  "fields": "id,threadId,snippet,internalDate,payload/headers"
}
```

One message, read. Prefer the helper when you want the text, not the raw payload:

```json
{
  "operation": "gmail.read",
  "input": { "id": "MESSAGE_ID", "format": "text" }
}
```

Triage, read:

```json
{
  "operation": "gmail.triage",
  "input": { "max": 10, "query": "is:unread" }
}
```

Send. Plan, show the preview, then `gws_send`. Send does not offer Always.

```json
{
  "operation": "gmail.send",
  "input": {
    "to": "person@example.com",
    "subject": "Hello",
    "body": "Hello"
  }
}
```

Reply. Same commit tool, `gws_send`:

```json
{
  "operation": "gmail.reply",
  "input": { "messageId": "MESSAGE_ID", "body": "Thanks" }
}
```

## Drive

Recent files, read:

```json
{
  "operation": "drive.files.list",
  "params": { "q": "trashed = false", "pageSize": 20, "orderBy": "modifiedTime desc" },
  "fields": "files(id,name,mimeType,modifiedTime),nextPageToken"
}
```

One file's metadata, read:

```json
{
  "operation": "drive.files.get",
  "params": { "fileId": "FILE_ID" },
  "fields": "id,name,mimeType,modifiedTime"
}
```

Create a file, write. Plan, then `gws_write`. An upload path must be absolute and inside an allowed read root. `gws_schema` shows the upload field.

```json
{
  "operation": "drive.files.create",
  "body": { "name": "Notes.txt", "mimeType": "text/plain" }
}
```

Move to trash. The plan category is **delete**, even if the manifest says write. Commit with `gws_delete`, not `gws_write`.

```json
{
  "operation": "drive.files.update",
  "params": { "fileId": "FILE_ID" },
  "body": { "trashed": true }
}
```

Share with one person. Plan category is share. Commit with `gws_share`. Share does not offer Always.

```json
{
  "operation": "drive.permissions.create",
  "params": { "fileId": "FILE_ID" },
  "body": { "type": "user", "role": "reader", "emailAddress": "person@example.com" }
}
```

## Calendar

Today's agenda, read:

```json
{
  "operation": "calendar.agenda",
  "input": { "today": true }
}
```

Events on the primary calendar, read:

```json
{
  "operation": "calendar.events.list",
  "params": { "calendarId": "primary", "maxResults": 10, "singleEvents": true, "orderBy": "startTime" },
  "fields": "items(id,summary,start,end),nextPageToken"
}
```

Create an event that does not email anyone. Plan category is write. Commit with `gws_write`.

```json
{
  "operation": "calendar.events.insert",
  "params": { "calendarId": "primary" },
  "body": {
    "summary": "Standup",
    "start": { "dateTime": "2026-11-02T09:00:00+01:00" },
    "end": { "dateTime": "2026-11-02T09:15:00+01:00" }
  }
}
```

Create or move an event that emails attendees (`sendUpdates` of `all` or `externalOnly`; prefer it to the deprecated `sendNotifications`, which counts as a send too). The plan category is **send**. Commit with `gws_send`.

```json
{
  "operation": "calendar.events.insert",
  "params": { "calendarId": "primary", "sendUpdates": "all" },
  "body": {
    "summary": "Standup",
    "start": { "dateTime": "2026-11-02T09:00:00+01:00" },
    "end": { "dateTime": "2026-11-02T09:15:00+01:00" }
  }
}
```

## Docs

Read a document:

```json
{
  "operation": "docs.documents.get",
  "params": { "documentId": "DOCUMENT_ID" }
}
```

Create a document, write. Plan, then `gws_write`.

```json
{
  "operation": "docs.documents.create",
  "body": { "title": "Notes" }
}
```

Insert text, write. Plan, then `gws_write`.

```json
{
  "operation": "docs.documents.batchUpdate",
  "params": { "documentId": "DOCUMENT_ID" },
  "body": {
    "requests": [
      { "insertText": { "location": { "index": 1 }, "text": "Hello" } }
    ]
  }
}
```

## Sheets

Read a range. The helper is enough for a rectangular range:

```json
{
  "operation": "sheets.read",
  "input": { "spreadsheet": "SPREADSHEET_ID", "range": "Sheet1!A1:D20" }
}
```

The method, when you need the raw values resource:

```json
{
  "operation": "sheets.spreadsheets.values.get",
  "params": { "spreadsheetId": "SPREADSHEET_ID", "range": "Sheet1!A1:D20" }
}
```

Append rows, write. Plan, then `gws_write`.

```json
{
  "operation": "sheets.spreadsheets.values.append",
  "params": {
    "spreadsheetId": "SPREADSHEET_ID",
    "range": "Sheet1!A1",
    "valueInputOption": "USER_ENTERED"
  },
  "body": { "values": [["a", "b"]] }
}
```

Create a spreadsheet, write. Plan, then `gws_write`.

```json
{
  "operation": "sheets.spreadsheets.create",
  "body": { "properties": { "title": "Notes" } }
}
```
