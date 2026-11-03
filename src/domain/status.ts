import * as z from "zod"

/**
 * The gws_status tool output: the plugin's status model, compact. It has
 * the versions, the resolved gws binary, each account's sign-in state,
 * the model-facing services, one next step, and only the count of
 * unguarded agents with a pointer to /gws-status, which names them and
 * gives the block. Nothing here is a token or a client secret.
 */

const AccountStatus = z.object({
  alias: z.string(),
  mode: z.enum(["interactive", "credentials_file", "access_token"]),
  services: z.array(z.string()),
  integrationID: z.string().optional().describe("The OpenCode integration an interactive account signs in through"),
  connected: z.boolean().describe("Interactive: signed in and usable. Headless: its environment variable is set; /gws-doctor checks the credential"),
  needsAuth: z.literal(true).optional().describe("OpenCode reports that the sign-in must be renewed"),
  access: z.enum(["read", "write"]).optional().describe("The signed-in access level; before sign-in, the form's default"),
  clientSource: z.enum(["account", "plugin", "pasted"]).optional().describe("Where the sign-in's OAuth client comes from"),
  grantedScopes: z.array(z.string()).optional().describe("Scopes Google granted to the current sign-in"),
  missingScopes: z.array(z.string()).optional().describe("Scopes the enabled services need at this access level that were not granted"),
  delegationRequired: z
    .array(z.string())
    .optional()
    .describe("Enabled services that need domain-wide delegation, which a Workspace admin sets up; the sign-in requests none of their scopes unless accounts.<alias>.scopes adds them"),
  nextStep: z.string().optional().describe("What to do next; absent when nothing is needed"),
})

export const StatusOutput = z.object({
  pluginVersion: z.string(),
  hostVersion: z.string(),
  hostWarning: z.string().optional().describe("Present when the OpenCode host is outside the tested range and allowUntestedHost is set"),
  gws: z.object({ path: z.string(), version: z.string() }),
  services: z.array(z.string()).describe("Model-facing services"),
  accounts: z.array(AccountStatus),
  auditDegraded: z.boolean().describe("Audit records were dropped, failed, or exceeded the sink deadline; sticky until reload"),
  unguardedAgents: z.number().int().describe("How many agents missed the default ask rules"),
  permissions: z.string().optional().describe("Present when an agent missed the ask rules: where to find the fix"),
  nextStep: z.string().optional().describe("The one thing to do next; absent when nothing is needed"),
})

export type StatusOutput = z.infer<typeof StatusOutput>

export type AccountStatus = z.infer<typeof AccountStatus>

/** What the runtime knows without OpenCode: versions, the binary, and the accounts. */
export interface RuntimeStatus {
  auditDegraded: boolean
  pluginVersion: string
  hostVersion: string
  hostWarning?: string
  binary: { path: string; version: string }
  services: string[]
  accounts: AccountStatus[]
}
