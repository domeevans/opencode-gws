---
name: opencode-gws-admin
description: Load only when the user asks for admin reports, Apps Script, Workspace Events, Model Armor, or a workflow helper.
opencode/autoinvoke: false
---

# High-risk Workspace services

This skill is not loaded automatically. Use it only when the user asked for admin reports, Apps Script, Workspace Events, Model Armor, or a workflow helper.

Search with `gws_catalog` and check `gws_schema` before you call. If `executable` is false, do not call that id. Deploy and watch never run. A helper with no adapter cannot run; use `alternative` when the catalog names one.

## Admin gate

An operation whose category is `admin` needs all of these before `gws_plan` will accept it:

1. `admin.enabled` is true, which is the default.
2. The service is in `admin.allowedServices` (the default list is the services that have an admin-class entry).
3. The plan includes a non-empty `reason` when `admin.requireReason` is true, which is the default.

Then commit with `gws_admin` and only `{ "planId": "<planId>" }`. `gws_admin` asks every time. It does not offer Always. A user deny hides the tool.

A read on one of these services is still a read: `gws_read`, no admin gate. A write that is not category `admin` still uses `gws_write` and the normal ask.

Plugin policy cannot allow an admin call. A policy rule can only deny.

## Admin reports

Read-only at both access levels. The sign-in still needs the admin report scopes from the auth doc, and the account must be a Workspace admin with the Reports privilege: otherwise every call fails with `ADMIN_PRIVILEGE_REQUIRED`, which signing in again as the same account does not fix.

Activity list, read. `fields` is required because this is a list:

```json
{
  "operation": "admin-reports.activities.list",
  "params": { "userKey": "all", "applicationName": "login" },
  "fields": "items(id,actor,events),nextPageToken"
}
```

Watching an activity feed is category `admin`, not a read. Plan it only when the user asked, with a reason, then commit with `gws_admin`:

```json
{
  "operation": "admin-reports.activities.watch",
  "params": { "userKey": "all", "applicationName": "login" },
  "reason": "The user asked to watch login activity."
}
```

`gws_schema` shows the watch body. Do not invent a channel.

## Apps Script

Read a project:

```json
{
  "operation": "script.projects.get",
  "params": { "scriptId": "SCRIPT_ID" }
}
```

Creating a project is a write. Plan, then `gws_write`. Deployments and running a script never run. If catalog marks an id not executable, stop and tell the user.

## Workspace Events

Most subscription methods never run. A status read can:

```json
{
  "operation": "events.operations.get",
  "params": { "name": "operations/OPERATION_ID" }
}
```

## Model Armor

Read and write requests `https://www.googleapis.com/auth/cloud-platform` for Model Armor; Read-only requests nothing for it. The Model Armor helpers cannot run. Do not invent a call. Tell the user, and use `gws_catalog` if they still want a Discovery method.

## Workflow

These three helpers are reads. They need the account to enable `workflow`, which uses the Gmail, Calendar, Tasks, and Drive scopes.

```json
{ "operation": "workflow.meeting-prep", "input": {} }
```

```json
{ "operation": "workflow.standup-report", "input": {} }
```

```json
{ "operation": "workflow.weekly-digest", "input": {} }
```

Other workflow helpers cannot run. Use the alternative `gws_catalog` names, and commit with that method's category tool.
