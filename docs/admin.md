# Admin operations

Unofficial plugin. Not affiliated with Google.

Admin is a separate gate. It is open by default for every service with an admin-class entry; each admin change is still a plan with a reason, an ask on `gws.admin`, and a commit with `gws_admin`. Set `admin.enabled` to `false`, or `admin.allowedServices` to `[]`, to refuse every admin plan.

## What the gate requires

An admin-category plan needs all of these:

1. `admin.enabled` is `true` (the default).
2. The service is in `admin.allowedServices`. Omit the list to allow every service that has an admin-class manifest entry. An explicit empty array denies every admin operation.
3. A non-empty `reason` on the plan, unless `admin.requireReason` is `false`.

The host then asks, on `gws.admin`, for that exact `<account>:<operation>`. Admin does not offer Always. A user deny hides `gws_admin`.

Plugin policy cannot allow an admin call. A policy rule can only deny. Deploy and watch never run, including when admin is enabled.

```jsonc
{
  "accounts": {
    "work": {
      "enabledServices": ["admin-reports"],
      "access": "read"
    }
  },
  "admin": {
    "enabled": true,
    "requireReason": true,
    "allowedServices": ["admin-reports"]
  }
}
```

Allow the prompt in noninteractive `opencode run` with a user rule, not a policy rule. The rule includes `resource`:

```json
{ "action": "gws.admin", "resource": "work:*", "effect": "allow" }
```

## Plan and commit

Admin uses the same two steps as any other change.

1. `gws_plan` with the operation id, the request, and `reason`.
2. Show the preview. Commit with `gws_admin` and only `{ "planId" }`.

A read on an admin-class service is still a read: `gws_read`, no admin gate. A write that the manifest classifies as write, send, share, delete, or export uses that category's commit tool, not `gws_admin`.

`/gws-status` and the audit record show the category. They do not show the reason's surrounding Workspace content. The reason is in the redacted preview, not in the `gws` argv.

## Services

The default allowlist follows the manifest. It includes every service with an admin-class method or helper: `admin-reports`, `drive`, and `modelarmor`. Model Armor helpers cannot run; catalog marks them not executable. Apps Script deployments and Workspace Events subscriptions are deploy or watch, so they never run.

High-risk services (`admin-reports`, `script`, `events`, `modelarmor`, `workflow`) are documented in the `opencode-gws-admin` skill, which is not loaded automatically. Enabling the skill does not enable the gate.
