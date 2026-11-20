// src/tui.tsx
import { createTextNode as _$createTextNode } from "@opentui/solid";
import { memo as _$memo } from "@opentui/solid";
import { createComponent as _$createComponent } from "@opentui/solid";
import { effect as _$effect } from "@opentui/solid";
import { insertNode as _$insertNode } from "@opentui/solid";
import { insert as _$insert } from "@opentui/solid";
import { setProp as _$setProp } from "@opentui/solid";
import { createElement as _$createElement } from "@opentui/solid";
import { TextAttributes } from "@opentui/core";
import { For, Show, createSignal } from "solid-js";

// src/rpc.ts
import { Rpc } from "@opencode/plugin/rpc";
var RPC_ID = "google-workspace.gws";
var text = { type: "string" };
var texts = { type: "array", items: text };
var object = (properties, required) => ({ type: "object", properties, required });
var MODES = ["interactive", "credentials_file", "access_token"];
var ACCESS = ["read", "write"];
var POLICY_ACCESS = ["all", "ask-changes", "read-only"];
var CLIENT_SOURCES = ["account", "plugin", "pasted"];
var STATES = ["connected", "sign_in_required", "not_configured"];
var account = object(
  {
    alias: text,
    mode: { enum: MODES },
    services: texts,
    integrationID: text,
    connected: { type: "boolean" },
    needsAuth: { const: true },
    access: { enum: ACCESS },
    clientSource: { enum: CLIENT_SOURCES },
    grantedScopes: texts,
    email: text,
    domain: text,
    missingScopes: texts,
    delegationRequired: texts,
    nextStep: text
  },
  ["alias", "mode", "services", "connected"]
);
var status = object(
  {
    version: text,
    host: object({ version: { type: ["string", "null"] }, range: text, tested: { type: "boolean" } }, ["version", "range", "tested"]),
    state: { enum: STATES },
    access: { enum: POLICY_ACCESS },
    rpcCommits: { type: "boolean" },
    gws: object({ path: text, version: text, problem: text }, ["path", "version"]),
    services: texts,
    accounts: { type: "array", items: account },
    auditDegraded: { type: "boolean" },
    shadowedSkills: { type: "array", items: object({ id: text, path: text }, ["id", "path"]) },
    shellSkills: { type: "array", items: object({ id: text, path: text }, ["id", "path"]) },
    unguardedAgents: texts,
    permissionsBlock: text,
    deprecated: text,
    nextStep: text
  },
  ["version", "host", "state", "access", "rpcCommits", "gws", "services", "accounts", "unguardedAgents", "nextStep"]
);
var Gws = Rpc.define({
  id: RPC_ID,
  methods: {
    status: {
      input: { type: "object", properties: {}, additionalProperties: false },
      output: status
    }
  },
  events: {}
});
var isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
var isStrings = (value) => Array.isArray(value) && value.every((entry) => typeof entry === "string");
var optional = (value, check) => value === void 0 || check(value);
var isText = (value) => typeof value === "string";
var isSkills = (value) => Array.isArray(value) && value.every((skill) => isRecord(skill) && isText(skill["id"]) && isText(skill["path"]));
function isAccount(value) {
  return isRecord(value) && isText(value["alias"]) && MODES.includes(value["mode"]) && isStrings(value["services"]) && typeof value["connected"] === "boolean" && optional(value["integrationID"], isText) && optional(value["needsAuth"], (entry) => entry === true) && optional(value["access"], (entry) => ACCESS.includes(entry)) && optional(value["clientSource"], (entry) => CLIENT_SOURCES.includes(entry)) && optional(value["grantedScopes"], isStrings) && optional(value["email"], isText) && optional(value["domain"], isText) && optional(value["missingScopes"], isStrings) && optional(value["delegationRequired"], isStrings) && optional(value["nextStep"], isText);
}
function isStatus(value) {
  return isRecord(value) && isText(value["version"]) && isRecord(value["host"]) && (value["host"]["version"] === null || isText(value["host"]["version"])) && isText(value["host"]["range"]) && typeof value["host"]["tested"] === "boolean" && STATES.includes(value["state"]) && POLICY_ACCESS.includes(value["access"]) && typeof value["rpcCommits"] === "boolean" && isRecord(value["gws"]) && isText(value["gws"]["path"]) && isText(value["gws"]["version"]) && isStrings(value["services"]) && Array.isArray(value["accounts"]) && value["accounts"].every(isAccount) && optional(value["auditDegraded"], (entry) => typeof entry === "boolean") && optional(value["shadowedSkills"], isSkills) && optional(value["shellSkills"], isSkills) && isStrings(value["unguardedAgents"]) && optional(value["permissionsBlock"], isText) && optional(value["deprecated"], isText) && isText(value["nextStep"]);
}
function connectionLabel(account2) {
  if (account2.connected) return "connected";
  return account2.mode === "interactive" ? "sign-in required" : "not configured";
}
function openCodeLabel(status2) {
  const version = status2.host.version ?? "unknown";
  return status2.host.tested ? `${version} (tested)` : `${version} (host untested; supported range ${status2.host.range})`;
}
var SHADOWED_LABEL = "Hidden skills";
function shadowedText(status2) {
  return (status2.shadowedSkills ?? []).map((skill) => `${skill.id} (hidden by ${skill.path})`).join(", ");
}
var SHELL_LABEL = "Shell gws skills";
function shellText(status2) {
  return (status2.shellSkills ?? []).map((skill) => `${skill.id} (${skill.path})`).join(", ");
}
var PERMISSIONS_LABEL = "Permissions";
function accessText(status2) {
  if (status2.access === "read-only") return "reads run; every commit is denied until you change access (read-only)";
  if (status2.access === "ask-changes") return "reads run; each commit asks first (ask-changes)";
  return "every tool runs without asking, the six commit tools included (all)";
}
var SCRIPT_COMMITS_LABEL = "Script commits";
function scriptCommitsText(status2) {
  if (!status2.rpcCommits) return "off: a script can plan a change but not commit it (rpcCommits)";
  const on = "on: a script can commit a plan when its agent's rules allow the commit, and the plugin asks no one first (rpcCommits)";
  return status2.unguardedAgents.length === 0 ? on : `${on}; ${unguardedCommitsText(status2.unguardedAgents)}`;
}
function unguardedCommitsText(agents) {
  return `a script running as ${agents.join(", ")} commits without asking, because ${agents.length === 1 ? "that agent lacks" : "those agents lack"} the default rules`;
}
var DELEGATION_LABEL = "Needs domain-wide delegation";
function delegationText(account2) {
  const services = account2.delegationRequired ?? [];
  return `${services.join(", ")} (a Workspace admin sets it up; then add the scopes to accounts.${account2.alias}.scopes)`;
}

// src/tui.tsx
var TITLE = "Google Workspace: Status";
var SCOPE_PREFIX = "https://www.googleapis.com/auth/";
var REFRESH_EVENTS = ["server.connected", "integration.updated", "credential.updated", "credential.switched", "agent.updated"];
function connectionTone(account2) {
  return account2.connected ? "success" : "warning";
}
function accountLabel(account2) {
  const credential = account2.mode === "credentials_file" ? "credentials file" : account2.mode === "access_token" ? "access token" : "OpenCode sign-in";
  return `${account2.alias} (${credential})`;
}
function accessLabel(access) {
  if (access === "read") return "read-only";
  if (access === "write") return "read and write";
  return void 0;
}
function clientLabel(account2) {
  if (account2.mode !== "interactive") return void 0;
  switch (account2.clientSource) {
    case "account":
      return `from accounts.${account2.alias}.oauthClient`;
    case "plugin":
      return "from the plugin's oauthClient option";
    case "pasted":
      return "entered at sign-in";
    default:
      return "none yet";
  }
}
function scopeList(scopes) {
  return scopes.map((scope) => scope.startsWith(SCOPE_PREFIX) ? scope.slice(SCOPE_PREFIX.length) : scope).join(", ");
}
function Row(props) {
  return (() => {
    var _el$ = _$createElement("box"), _el$2 = _$createElement("text"), _el$3 = _$createElement("text");
    _$insertNode(_el$, _el$2);
    _$insertNode(_el$, _el$3);
    _$setProp(_el$, "flexDirection", "row");
    _$setProp(_el$, "gap", 1);
    _$setProp(_el$2, "width", 29);
    _$setProp(_el$2, "flexShrink", 0);
    _$insert(_el$2, () => props.label);
    _$setProp(_el$3, "flexGrow", 1);
    _$setProp(_el$3, "wrapMode", "word");
    _$insert(_el$3, () => props.value);
    _$effect((_p$) => {
      var _v$ = props.muted, _v$2 = props.fg;
      _v$ !== _p$.e && (_p$.e = _$setProp(_el$2, "fg", _v$, _p$.e));
      _v$2 !== _p$.t && (_p$.t = _$setProp(_el$3, "fg", _v$2, _p$.t));
      return _p$;
    }, {
      e: void 0,
      t: void 0
    });
    return _el$;
  })();
}
function AccountStatus(props) {
  const base = () => props.colors.text.base;
  const muted = () => props.colors.text.muted;
  const tone = (value) => props.colors.text.feedback[value].base;
  return (() => {
    var _el$4 = _$createElement("box");
    _$setProp(_el$4, "flexDirection", "column");
    _$insert(_el$4, _$createComponent(Row, {
      label: "Connection",
      get value() {
        return connectionLabel(props.account);
      },
      get fg() {
        return tone(connectionTone(props.account));
      },
      get muted() {
        return muted();
      }
    }), null);
    _$insert(_el$4, _$createComponent(Row, {
      label: "Account",
      get value() {
        return accountLabel(props.account);
      },
      get fg() {
        return base();
      },
      get muted() {
        return muted();
      }
    }), null);
    _$insert(_el$4, _$createComponent(Show, {
      get when() {
        return _$memo(() => props.account.mode === "interactive")() ? accessLabel(props.account.access) : void 0;
      },
      children: (access) => _$createComponent(Row, {
        label: "Access",
        get value() {
          return access();
        },
        get fg() {
          return base();
        },
        get muted() {
          return muted();
        }
      })
    }), null);
    _$insert(_el$4, _$createComponent(Show, {
      get when() {
        return clientLabel(props.account);
      },
      children: (client) => _$createComponent(Row, {
        label: "Client",
        get value() {
          return client();
        },
        get fg() {
          return base();
        },
        get muted() {
          return muted();
        }
      })
    }), null);
    _$insert(_el$4, _$createComponent(Row, {
      label: "Services",
      get value() {
        return props.account.services.join(", ") || "none";
      },
      get fg() {
        return base();
      },
      get muted() {
        return muted();
      }
    }), null);
    _$insert(_el$4, _$createComponent(Show, {
      get when() {
        return _$memo(() => !!props.account.grantedScopes?.length)() ? props.account.grantedScopes : void 0;
      },
      children: (scopes) => _$createComponent(Row, {
        label: "Granted scopes",
        get value() {
          return scopeList(scopes());
        },
        get fg() {
          return base();
        },
        get muted() {
          return muted();
        }
      })
    }), null);
    _$insert(_el$4, _$createComponent(Show, {
      get when() {
        return _$memo(() => !!props.account.missingScopes?.length)() ? props.account.missingScopes : void 0;
      },
      children: (scopes) => _$createComponent(Row, {
        label: "Scopes not granted",
        get value() {
          return scopeList(scopes());
        },
        get fg() {
          return tone("warning");
        },
        get muted() {
          return muted();
        }
      })
    }), null);
    _$insert(_el$4, _$createComponent(Show, {
      get when() {
        return _$memo(() => !!props.account.delegationRequired?.length)() ? props.account : void 0;
      },
      children: (account2) => _$createComponent(Row, {
        label: DELEGATION_LABEL,
        get value() {
          return delegationText(account2());
        },
        get fg() {
          return muted();
        },
        get muted() {
          return muted();
        }
      })
    }), null);
    return _el$4;
  })();
}
function StatusBody(props) {
  const base = () => props.colors.text.base;
  const muted = () => props.colors.text.muted;
  const tone = (value) => props.colors.text.feedback[value].base;
  return (() => {
    var _el$5 = _$createElement("box"), _el$6 = _$createElement("box");
    _$insertNode(_el$5, _el$6);
    _$setProp(_el$5, "flexDirection", "column");
    _$setProp(_el$5, "gap", 1);
    _$insert(_el$5, _$createComponent(Show, {
      get when() {
        return props.status.accounts.length > 0;
      },
      get fallback() {
        return _$createComponent(Row, {
          label: "Connection",
          value: "not configured",
          get fg() {
            return tone("warning");
          },
          get muted() {
            return muted();
          }
        });
      },
      get children() {
        return _$createComponent(For, {
          get each() {
            return props.status.accounts;
          },
          children: (account2) => _$createComponent(AccountStatus, {
            account: account2,
            get colors() {
              return props.colors;
            }
          })
        });
      }
    }), _el$6);
    _$setProp(_el$6, "flexDirection", "column");
    _$insert(_el$6, _$createComponent(Show, {
      get when() {
        return props.status.shadowedSkills?.length;
      },
      get children() {
        return _$createComponent(Row, {
          label: SHADOWED_LABEL,
          get value() {
            return shadowedText(props.status);
          },
          get fg() {
            return tone("warning");
          },
          get muted() {
            return muted();
          }
        });
      }
    }), null);
    _$insert(_el$6, _$createComponent(Show, {
      get when() {
        return props.status.shellSkills?.length;
      },
      get children() {
        return _$createComponent(Row, {
          label: SHELL_LABEL,
          get value() {
            return shellText(props.status);
          },
          get fg() {
            return tone("warning");
          },
          get muted() {
            return muted();
          }
        });
      }
    }), null);
    _$insert(_el$6, _$createComponent(Row, {
      label: "Tools",
      get value() {
        return `gws tools for ${props.status.services.join(", ") || "no services"} (${props.status.gws.version})`;
      },
      get fg() {
        return base();
      },
      get muted() {
        return muted();
      }
    }), null);
    _$insert(_el$6, _$createComponent(Row, {
      label: PERMISSIONS_LABEL,
      get value() {
        return accessText(props.status);
      },
      get fg() {
        return base();
      },
      get muted() {
        return muted();
      }
    }), null);
    _$insert(_el$6, _$createComponent(Row, {
      label: SCRIPT_COMMITS_LABEL,
      get value() {
        return scriptCommitsText(props.status);
      },
      get fg() {
        return _$memo(() => !!props.status.rpcCommits)() ? tone("warning") : base();
      },
      get muted() {
        return muted();
      }
    }), null);
    _$insert(_el$6, _$createComponent(Show, {
      get when() {
        return _$memo(() => props.status.unguardedAgents.length > 0)() ? props.status.unguardedAgents : void 0;
      },
      get fallback() {
        return _$createComponent(Row, {
          label: "Agents without default rules",
          value: "none",
          get fg() {
            return base();
          },
          get muted() {
            return muted();
          }
        });
      },
      children: (agents) => (() => {
        var _el$7 = _$createElement("box"), _el$8 = _$createElement("text");
        _$insertNode(_el$7, _el$8);
        _$setProp(_el$7, "flexDirection", "column");
        _$insert(_el$7, _$createComponent(Row, {
          label: "Agents without default rules",
          get value() {
            return agents().join(", ");
          },
          get fg() {
            return tone("warning");
          },
          get muted() {
            return muted();
          }
        }), _el$8);
        _$insert(_el$8, () => props.status.permissionsBlock ?? "");
        _$effect((_$p) => _$setProp(_el$8, "fg", base(), _$p));
        return _el$7;
      })()
    }), null);
    _$insert(_el$6, _$createComponent(Show, {
      get when() {
        return props.status.auditDegraded;
      },
      get children() {
        return _$createComponent(Row, {
          label: "Audit",
          value: "some records could not be saved, so the audit log may be incomplete",
          get fg() {
            return tone("warning");
          },
          get muted() {
            return muted();
          }
        });
      }
    }), null);
    _$insert(_el$6, _$createComponent(Show, {
      get when() {
        return props.status.deprecated;
      },
      children: (note) => _$createComponent(Row, {
        label: "Deprecated",
        get value() {
          return note();
        },
        get fg() {
          return tone("warning");
        },
        get muted() {
          return muted();
        }
      })
    }), null);
    _$insert(_el$6, _$createComponent(Row, {
      label: "OpenCode",
      get value() {
        return openCodeLabel(props.status);
      },
      get fg() {
        return tone(props.status.host.tested ? "success" : "warning");
      },
      get muted() {
        return muted();
      }
    }), null);
    _$insert(_el$6, _$createComponent(Row, {
      label: "Next step",
      get value() {
        return props.status.nextStep;
      },
      get fg() {
        return base();
      },
      get muted() {
        return muted();
      }
    }), null);
    return _el$5;
  })();
}
function Dialog(props) {
  props.context.keymap.layer(() => ({
    mode: "modal",
    commands: [{
      title: "Refresh Google Workspace status",
      group: "Google Workspace",
      bind: "r",
      run: () => props.refresh()
    }, {
      title: "Close Google Workspace status",
      group: "Google Workspace",
      bind: "escape",
      run: () => props.context.ui.dialog.clear()
    }]
  }));
  const colors = () => props.context.theme.surface("dialog");
  return (() => {
    var _el$9 = _$createElement("box"), _el$0 = _$createElement("box"), _el$1 = _$createElement("text"), _el$17 = _$createElement("text");
    _$insertNode(_el$9, _el$0);
    _$insertNode(_el$9, _el$17);
    _$setProp(_el$9, "flexDirection", "column");
    _$setProp(_el$9, "gap", 1);
    _$setProp(_el$9, "paddingLeft", 2);
    _$setProp(_el$9, "paddingRight", 2);
    _$setProp(_el$9, "paddingBottom", 1);
    _$insertNode(_el$0, _el$1);
    _$setProp(_el$0, "flexDirection", "row");
    _$setProp(_el$0, "justifyContent", "space-between");
    _$insertNode(_el$1, _$createTextNode(`Google Workspace: Status`));
    _$insert(_el$0, _$createComponent(Show, {
      get when() {
        return _$memo(() => !!props.refreshing)() && props.view.state !== "loading";
      },
      get children() {
        var _el$11 = _$createElement("text");
        _$insertNode(_el$11, _$createTextNode(`refreshing\u2026`));
        _$effect((_$p) => _$setProp(_el$11, "fg", colors().text.muted, _$p));
        return _el$11;
      }
    }), null);
    _$insert(_el$9, _$createComponent(Show, {
      get when() {
        return props.view.state === "loading";
      },
      get children() {
        var _el$13 = _$createElement("text");
        _$insertNode(_el$13, _$createTextNode(`Loading\u2026`));
        _$effect((_$p) => _$setProp(_el$13, "fg", colors().text.muted, _$p));
        return _el$13;
      }
    }), _el$17);
    _$insert(_el$9, _$createComponent(Show, {
      get when() {
        return props.view.state === "failed";
      },
      get children() {
        var _el$15 = _$createElement("text");
        _$insertNode(_el$15, _$createTextNode(`STATUS_UNAVAILABLE: Google Workspace status could not be read. Next step: Run /gws-status in a session for the details.`));
        _$setProp(_el$15, "wrapMode", "word");
        _$effect((_$p) => _$setProp(_el$15, "fg", colors().text.feedback.error.base, _$p));
        return _el$15;
      }
    }), _el$17);
    _$insert(_el$9, _$createComponent(Show, {
      get when() {
        return _$memo(() => props.view.state === "ready")() ? props.view.status : void 0;
      },
      children: (status2) => _$createComponent(StatusBody, {
        get status() {
          return status2();
        },
        get colors() {
          return colors();
        }
      })
    }), _el$17);
    _$insertNode(_el$17, _$createTextNode(`r refresh \xB7 esc close`));
    _$effect((_p$) => {
      var _v$3 = colors().text.base, _v$4 = TextAttributes.BOLD, _v$5 = colors().text.muted;
      _v$3 !== _p$.e && (_p$.e = _$setProp(_el$1, "fg", _v$3, _p$.e));
      _v$4 !== _p$.t && (_p$.t = _$setProp(_el$1, "attributes", _v$4, _p$.t));
      _v$5 !== _p$.a && (_p$.a = _$setProp(_el$17, "fg", _v$5, _p$.a));
      return _p$;
    }, {
      e: void 0,
      t: void 0,
      a: void 0
    });
    return _el$9;
  })();
}
var tui_default = {
  id: "google-workspace.gws.tui",
  setup(context) {
    const [view, setView] = createSignal({
      state: "loading"
    });
    const [refreshing, setRefreshing] = createSignal(false);
    let generation = 0;
    let controller;
    let open;
    let disposed = false;
    let unsubscribe;
    const cancel = () => {
      generation++;
      controller?.abort();
      controller = void 0;
    };
    const refresh = () => {
      if (disposed || !open) return;
      cancel();
      const request = generation;
      const current = new AbortController();
      controller = current;
      setRefreshing(true);
      void context.client.rpc(Gws).status({}, {
        location: context.location ?? context.data.location.default(),
        signal: current.signal
      }).then((status2) => isStatus(status2) ? {
        state: "ready",
        status: status2
      } : {
        state: "failed"
      }, () => ({
        state: "failed"
      })).then((next) => {
        if (request !== generation) return;
        controller = void 0;
        setView(next);
        setRefreshing(false);
      });
    };
    const show = () => {
      if (disposed) return;
      const token = {};
      const stops = REFRESH_EVENTS.map((type) => context.data.on(type, refresh));
      context.ui.dialog.show(() => _$createComponent(Dialog, {
        context,
        get view() {
          return view();
        },
        get refreshing() {
          return refreshing();
        },
        refresh
      }), () => {
        for (const stop of stops.splice(0)) stop();
        if (open !== token) return;
        open = void 0;
        cancel();
      });
      context.ui.dialog.set({
        size: "large"
      });
      open = token;
      unsubscribe = () => {
        for (const stop of stops.splice(0)) stop();
      };
      setView({
        state: "loading"
      });
      refresh();
    };
    context.keymap.layer(() => ({
      mode: "global",
      commands: [{
        id: "google-workspace.gws.status",
        title: TITLE,
        description: "Sign-in, access, services, unguarded agents and the next step for each Google Workspace account",
        group: "Google Workspace",
        palette: true,
        slash: {
          name: "gws"
        },
        run: show
      }]
    }));
    return () => {
      if (disposed) return;
      disposed = true;
      cancel();
      unsubscribe?.();
      if (open) {
        open = void 0;
        context.ui.dialog.clear();
      }
    };
  }
};
export {
  tui_default as default
};
