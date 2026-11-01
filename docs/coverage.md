# Coverage

Generated from `manifest/generated.json` (gws 0.22.5) by `npm run docs:coverage`. Do not edit by hand.

The manifest is the contract: every service, Discovery method, and helper the pinned `gws` exposes. `npm run manifest` regenerates it. `npm run drift` warns when the pinned `gws` and the manifest diverge. It does not stop a call.

| | |
| --- | --- |
| gws | `gws 0.22.5` |
| Services | 18 |
| Discovery methods | 471 |
| Helpers | 25 |
| Helpers the plugin can run | 11 |

Category columns count Discovery methods only. A helper keeps its own category. `services` limits what catalog, schema, read, and plan will accept. It does not add tools.

| Service | Methods | Helpers | read | write | send | share | delete | export | admin | deploy | watch | deny |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| drive | 64 | 1 | 25 | 13 | 3 | 7 | 6 | 1 | 1 | 0 | 3 | 5 |
| sheets | 17 | 2 | 7 | 7 | 0 | 0 | 3 | 0 | 0 | 0 | 0 | 0 |
| gmail | 79 | 7 | 28 | 29 | 2 | 5 | 13 | 0 | 0 | 0 | 2 | 0 |
| calendar | 35 | 2 | 11 | 13 | 0 | 5 | 4 | 0 | 0 | 0 | 2 | 0 |
| admin-reports | 6 | 0 | 4 | 0 | 0 | 0 | 0 | 0 | 2 | 0 | 0 | 0 |
| docs | 3 | 1 | 1 | 2 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| slides | 5 | 0 | 3 | 2 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| tasks | 14 | 0 | 4 | 7 | 0 | 0 | 3 | 0 | 0 | 0 | 0 | 0 |
| people | 24 | 0 | 11 | 8 | 0 | 1 | 4 | 0 | 0 | 0 | 0 | 0 |
| chat | 55 | 1 | 23 | 22 | 2 | 2 | 6 | 0 | 0 | 0 | 0 | 0 |
| classroom | 105 | 0 | 44 | 40 | 0 | 3 | 16 | 0 | 0 | 0 | 2 | 0 |
| forms | 10 | 0 | 3 | 3 | 0 | 0 | 0 | 0 | 0 | 0 | 4 | 0 |
| keep | 7 | 0 | 3 | 1 | 0 | 2 | 1 | 0 | 0 | 0 | 0 | 0 |
| meet | 24 | 0 | 17 | 4 | 0 | 2 | 1 | 0 | 0 | 0 | 0 | 0 |
| events | 7 | 2 | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 6 | 0 |
| modelarmor | 0 | 3 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| workflow | 0 | 5 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| script | 16 | 1 | 7 | 2 | 0 | 0 | 0 | 0 | 0 | 7 | 0 | 0 |
| **Total** | **471** | **25** | **192** | **153** | **7** | **27** | **57** | **1** | **3** | **7** | **19** | **5** |

## Categories

| Category | How it runs |
| --- | --- |
| read | `gws_read`. A plan is not required. |
| write | `gws_plan`, then `gws_write` |
| send | `gws_plan`, then `gws_send` |
| share | `gws_plan`, then `gws_share` |
| delete | `gws_plan`, then `gws_delete` |
| export | `gws_plan`, then `gws_export` |
| admin | `gws_plan`, then `gws_admin`, and only when the admin gate allows it |
| deploy | Never runs. |
| watch | Never runs. |
| deny | Never runs. |

A request can raise the manifest category. Trashing a Drive file is a delete. A Calendar event write that emails attendees is a send. A read with `download.path` is an export. The plan's category is the one that commits.

Helpers the plugin can run: `calendar.agenda`, `gmail.forward`, `gmail.read`, `gmail.reply`, `gmail.reply-all`, `gmail.send`, `gmail.triage`, `sheets.read`, `workflow.meeting-prep`, `workflow.standup-report`, `workflow.weekly-digest`.

Helpers in the catalog that cannot run (14): `calendar.insert`, `chat.send`, `docs.write`, `drive.upload`, `events.renew`, `events.subscribe`, `gmail.watch`, `modelarmor.create-template`, `modelarmor.sanitize-prompt`, `modelarmor.sanitize-response`, `script.push`, `sheets.append`, `workflow.email-to-task`, `workflow.file-announce`. `gws_catalog` sets `executable` to false and, when it has one, names the method to use instead.
