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

const Host = z.object({
  version: z.string().nullable().describe("The OpenCode version; null when unknown"),
  range: z.string().describe("The supported range, as in package.json opencode.host"),
  tested: z.boolean().describe("True only for a release the plugin is tested on"),
})

/** The plugin's state, in the shared status names. */
const STATES = ["connected", "sign_in_required", "not_configured"] as const

export const StatusOutput = z.object({
  version: z.string().describe("The plugin's version"),
  host: Host,
  state: z.enum(STATES).describe("connected; sign_in_required or not_configured when an account needs it"),
  gws: z.object({ path: z.string(), version: z.string() }),
  services: z.array(z.string()).describe("Model-facing services"),
  accounts: z.array(AccountStatus),
  auditDegraded: z.boolean().describe("Audit records were dropped, failed, or exceeded the sink deadline; sticky until reload"),
  unguardedAgentCount: z.number().int().describe("How many agents lack the default ask rules; /gws-status names them"),
  permissions: z.string().optional().describe("Present when an agent lacks the default rules: where to find the fix"),
  nextStep: z.string().describe('The one thing to do next; "Nothing to do." when nothing is needed'),
})

export type StatusOutput = z.infer<typeof StatusOutput>

type AccountStatus = z.infer<typeof AccountStatus>

/** What the runtime knows without OpenCode: versions, the binary, and the accounts. */
export interface RuntimeStatus {
  auditDegraded: boolean
  version: string
  host: z.infer<typeof Host>
  binary: { path: string; version: string }
  services: string[]
  accounts: AccountStatus[]
}
