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

The `default` account leaves out `admin-reports`, because only a Workspace admin with the Reports privilege can call it. Add the admin as a separate account alias, so its sign-in does not replace your own. Setting `accounts` replaces the implicit `default` account, and an account you configure is read-only unless it sets `access`, so list your own account too:

```jsonc
{
  "accounts": {
    "default": {
      "enabledServices": ["gmail", "calendar", "drive", "docs", "sheets"],
      "access": "write"
    },
    "admin": {
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

Sign in to it with `/connect` and **Google Workspace (`admin`)**. With two accounts, every call names one with `account`.

Allow the prompt in noninteractive `opencode run` with a user rule, not a policy rule. The rule includes `resource`:

```json
{ "action": "gws.admin", "resource": "admin:*", "effect": "allow" }
```

## Plan and commit

Admin uses the same two steps as any other change.

1. `gws_plan` with the operation id, the request, and `reason`.
2. Show the preview. Commit with `gws_admin` and only `{ "planId" }`.

A read on an admin-class service is still a read: `gws_read`, no admin gate. A write that the manifest classifies as write, send, share, delete, or export uses that category's commit tool, not `gws_admin`.

`/gws-status` and the audit record show the category. They do not show the reason's surrounding Workspace content. The reason is in the redacted preview, not in the `gws` argv.

## Services

The default allowlist follows the manifest. It includes every service with an admin-class method or helper: `admin-reports`, `drive`, and `modelarmor`. No Model Armor helper can run, and no account enables Model Armor by default. Apps Script deployments and Workspace Events subscriptions are deploy or watch, so they never run.

High-risk services (`admin-reports`, `script`, `events`, `modelarmor`, `workflow`) are documented in the `opencode-gws-admin` skill, which is not loaded automatically. Enabling the skill does not enable the gate.
