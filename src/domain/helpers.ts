import { isAbsolute } from "node:path"
import * as z from "zod"
import { inputFiles, type FileSpecs } from "./files.js"
import type { Category, Request } from "./types.js"

/**
 * Helper adapters for the gws `+helper` commands. Helpers are distinct
 * from Discovery methods: they have their own flags and compose multiple
 * API calls. Only helpers with an explicit adapter are executable; the
 * manifest still lists every helper so coverage is honest.
 */

interface HelperCommand {
  id: string
  category: Category
  argv: string[]
  /** Local files argv refers to by staged relative path. */
  files?: FileSpecs
  preview: {
    method: string
    params: Record<string, unknown>
    bodySummary?: string
    recipients?: string[]
    uploads?: string[]
    account: string
    category: Category
  }
}

export interface HelperAdapter {
  id: string
  service: string
  /** The manifest category; categoryOf refines it for one input. */
  category: Category
  /** The category of this input, when it differs from the manifest's, such as a draft. */
  categoryOf?(input: unknown): Category
  inputSchema: z.ZodType<unknown>
  build(input: unknown, request: Request): HelperCommand
}

/** The category a helper call commits as. */
export function helperCategory(adapter: HelperAdapter, input: unknown): Category {
  return adapter.categoryOf?.(input) ?? adapter.category
}

/** A mail helper with draft: true only saves a draft, which reaches no one, so it is a write; gmail.users.drafts.send is the send. */
function mailCategory(input: unknown): "send" | "write" {
  return typeof input === "object" && input !== null && (input as { draft?: unknown }).draft === true ? "write" : "send"
}

/** A mail preview: a send lists who it reaches, a draft only who it is addressed to. */
function mailPreview<T extends { recipients: string[] }>(category: "send" | "write", preview: T): Omit<T, "recipients"> | T {
  if (category === "send") return preview
  const { recipients: _none, ...draft } = preview
  return draft
}

function emails(value: string | string[] | undefined): string[] {
  if (!value) return []
  return (Array.isArray(value) ? value : [value]).flatMap((item) => item.split(",")).map((item) => item.trim()).filter(Boolean)
}

function addRepeated(argv: string[], flag: string, values: string[] | undefined): void {
  for (const value of values ?? []) argv.push(flag, value)
}

function bytes(value: string): string {
  return `${Buffer.byteLength(value)} bytes`
}

const outputFormat = z.enum(["json", "table", "yaml", "csv"])

const absolutePath = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => isAbsolute(value), "path must be absolute")

/** Attachments are staged: argv carries `-a <staged path>` (gws rejects paths outside its cwd). */
function attach(argv: string[], attachments: string[] | undefined): FileSpecs {
  const files: FileSpecs = { inputs: inputFiles(attachments) }
  addRepeated(argv, "-a", files.inputs.map((file) => file.rel))
  return files
}

const sendBase = {
  to: z.union([z.string(), z.array(z.string())]),
  subject: z.string().min(1).max(500),
  body: z.string().min(1).max(100_000),
  cc: z.union([z.string(), z.array(z.string())]).optional(),
  bcc: z.union([z.string(), z.array(z.string())]).optional(),
  from: z.string().email().optional(),
  html: z.boolean().optional(),
  draft: z.boolean().optional(),
  attachments: z.array(absolutePath).max(20).optional(),
}

function sendArgv(name: string, input: z.infer<z.ZodObject<typeof sendBase>>): { argv: string[]; files: FileSpecs } {
  const argv = ["gmail", name, "--to", emails(input.to).join(","), "--subject", input.subject, "--body", input.body]
  if (input.cc) argv.push("--cc", emails(input.cc).join(","))
  if (input.bcc) argv.push("--bcc", emails(input.bcc).join(","))
  if (input.from) argv.push("--from", input.from)
  if (input.html) argv.push("--html")
  if (input.draft) argv.push("--draft")
  const files = attach(argv, input.attachments)
  return { argv, files }
}

const gmailSend: HelperAdapter = {
  id: "gmail.send",
  service: "gmail",
  category: "send",
  categoryOf: mailCategory,
  inputSchema: z.strictObject(sendBase),
  build(input, request) {
    const parsed = this.inputSchema.parse(input) as z.infer<z.ZodObject<typeof sendBase>>
    const { argv, files } = sendArgv("+send", parsed)
    const category = mailCategory(parsed)
    return {
      id: this.id,
      category,
      argv,
      files,
      preview: mailPreview(category, {
        method: "gmail +send",
        params: { to: emails(parsed.to), cc: emails(parsed.cc), bcc: emails(parsed.bcc), subject: parsed.subject, draft: parsed.draft ?? false },
        bodySummary: bytes(parsed.body),
        recipients: [...emails(parsed.to), ...emails(parsed.cc), ...emails(parsed.bcc)],
        uploads: parsed.attachments,
        account: request.account,
        category,
      }),
    }
  },
}

const gmailRead: HelperAdapter = {
  id: "gmail.read",
  service: "gmail",
  category: "read",
  inputSchema: z.strictObject({
    id: z.string().min(1),
    headers: z.boolean().optional(),
    html: z.boolean().optional(),
    format: z.enum(["text", "json"]).optional(),
  }),
  build(input, request) {
    const parsed = this.inputSchema.parse(input) as { id: string; headers?: boolean; html?: boolean; format?: "text" | "json" }
    const argv = ["gmail", "+read", "--id", parsed.id]
    if (parsed.headers) argv.push("--headers")
    if (parsed.html) argv.push("--html")
    if (parsed.format) argv.push("--format", parsed.format)
    return {
      id: this.id,
      category: "read",
      argv,
      preview: { method: "gmail +read", params: { id: parsed.id }, account: request.account, category: "read" },
    }
  },
}

const replyBase = {
  messageId: z.string().min(1),
  body: z.string().min(1).max(100_000),
  from: z.string().email().optional(),
  to: z.union([z.string(), z.array(z.string())]).optional().describe("Extra To recipients, besides the ones the reply goes to"),
  cc: z.union([z.string(), z.array(z.string())]).optional(),
  bcc: z.union([z.string(), z.array(z.string())]).optional(),
  html: z.boolean().optional(),
  draft: z.boolean().optional(),
  attachments: z.array(absolutePath).max(20).optional(),
}

const replyAllBase = {
  ...replyBase,
  remove: z.union([z.string(), z.array(z.string())]).optional().describe("Addresses to leave out of the reply-all, the sender's included"),
}

function replyAdapter(id: string, name: string, all: boolean): HelperAdapter {
  return {
    id,
    service: "gmail",
    category: "send",
    categoryOf: mailCategory,
    inputSchema: z.strictObject(all ? replyAllBase : replyBase),
    build(input, request) {
      const parsed = this.inputSchema.parse(input) as z.infer<z.ZodObject<typeof replyAllBase>>
      const argv = ["gmail", name, "--message-id", parsed.messageId, "--body", parsed.body]
      if (parsed.from) argv.push("--from", parsed.from)
      if (parsed.to) argv.push("--to", emails(parsed.to).join(","))
      if (parsed.remove) argv.push("--remove", emails(parsed.remove).join(","))
      if (parsed.cc) argv.push("--cc", emails(parsed.cc).join(","))
      if (parsed.bcc) argv.push("--bcc", emails(parsed.bcc).join(","))
      if (parsed.html) argv.push("--html")
      if (parsed.draft) argv.push("--draft")
      const files = attach(argv, parsed.attachments)
      const category = mailCategory(parsed)
      return {
        id: this.id,
        category,
        argv,
        files,
        preview: mailPreview(category, {
          method: `gmail ${name}`,
          params: { messageId: parsed.messageId, to: emails(parsed.to), cc: emails(parsed.cc), bcc: emails(parsed.bcc), ...(all ? { remove: emails(parsed.remove) } : {}), draft: parsed.draft ?? false },
          bodySummary: bytes(parsed.body),
          recipients: [...emails(parsed.to), ...emails(parsed.cc), ...emails(parsed.bcc)],
          uploads: parsed.attachments,
          account: request.account,
          category,
        }),
      }
    },
  }
}

const forwardSchema = z.strictObject({
  messageId: z.string().min(1),
  to: z.union([z.string(), z.array(z.string())]),
  cc: z.union([z.string(), z.array(z.string())]).optional(),
  bcc: z.union([z.string(), z.array(z.string())]).optional(),
  from: z.string().email().optional(),
  body: z.string().max(100_000).optional().describe("A note above the forwarded message"),
  html: z.boolean().optional(),
  draft: z.boolean().optional(),
  attachments: z.array(absolutePath).max(20).optional(),
  noOriginalAttachments: z.boolean().optional().describe("Leave out the original message's attachments"),
})

const gmailForward: HelperAdapter = {
  id: "gmail.forward",
  service: "gmail",
  category: "send",
  categoryOf: mailCategory,
  inputSchema: forwardSchema,
  build(input, request) {
    const parsed = this.inputSchema.parse(input) as z.infer<typeof forwardSchema>
    const argv = ["gmail", "+forward", "--message-id", parsed.messageId, "--to", emails(parsed.to).join(",")]
    if (parsed.cc) argv.push("--cc", emails(parsed.cc).join(","))
    if (parsed.bcc) argv.push("--bcc", emails(parsed.bcc).join(","))
    if (parsed.from) argv.push("--from", parsed.from)
    if (parsed.body) argv.push("--body", parsed.body)
    if (parsed.html) argv.push("--html")
    if (parsed.draft) argv.push("--draft")
    if (parsed.noOriginalAttachments) argv.push("--no-original-attachments")
    const files = attach(argv, parsed.attachments)
    const category = mailCategory(parsed)
    return {
      id: this.id,
      category,
      argv,
      files,
      preview: mailPreview(category, {
        method: "gmail +forward",
        params: { messageId: parsed.messageId, to: emails(parsed.to), cc: emails(parsed.cc), bcc: emails(parsed.bcc), draft: parsed.draft ?? false },
        bodySummary: parsed.body ? bytes(parsed.body) : undefined,
        recipients: [...emails(parsed.to), ...emails(parsed.cc), ...emails(parsed.bcc)],
        uploads: parsed.attachments,
        account: request.account,
        category,
      }),
    }
  },
}

const gmailTriage: HelperAdapter = {
  id: "gmail.triage",
  service: "gmail",
  category: "read",
  inputSchema: z.strictObject({
    max: z.number().int().positive().max(200).optional(),
    query: z.string().max(2000).optional(),
    labels: z.boolean().optional(),
    format: outputFormat.optional(),
  }),
  build(input, request) {
    const parsed = this.inputSchema.parse(input) as { max?: number; query?: string; labels?: boolean; format?: z.infer<typeof outputFormat> }
    const argv = ["gmail", "+triage"]
    if (parsed.max) argv.push("--max", String(parsed.max))
    if (parsed.query) argv.push("--query", parsed.query)
    if (parsed.labels) argv.push("--labels")
    if (parsed.format) argv.push("--format", parsed.format)
    return {
      id: this.id,
      category: "read",
      argv,
      preview: { method: "gmail +triage", params: parsed, account: request.account, category: "read" },
    }
  },
}

const calendarAgendaSchema = z.strictObject({
  today: z.boolean().optional(),
  tomorrow: z.boolean().optional(),
  week: z.boolean().optional(),
  days: z.number().int().positive().max(365).optional(),
  calendar: z.string().min(1).max(500).optional(),
  timezone: z.string().min(1).max(100).optional(),
  format: outputFormat.optional(),
})

const calendarAgenda: HelperAdapter = {
  id: "calendar.agenda",
  service: "calendar",
  category: "read",
  inputSchema: calendarAgendaSchema,
  build(input, request) {
    const parsed = this.inputSchema.parse(input) as z.infer<typeof calendarAgendaSchema>
    const argv = ["calendar", "+agenda"]
    if (parsed.today) argv.push("--today")
    if (parsed.tomorrow) argv.push("--tomorrow")
    if (parsed.week) argv.push("--week")
    if (parsed.days) argv.push("--days", String(parsed.days))
    if (parsed.calendar) argv.push("--calendar", parsed.calendar)
    if (parsed.timezone) argv.push("--timezone", parsed.timezone)
    if (parsed.format) argv.push("--format", parsed.format)
    return {
      id: this.id,
      category: "read",
      argv,
      preview: {
        method: "calendar +agenda",
        params: {
          today: parsed.today ?? false,
          tomorrow: parsed.tomorrow ?? false,
          week: parsed.week ?? false,
          days: parsed.days ?? null,
          calendar: parsed.calendar ?? null,
          timezone: parsed.timezone ?? null,
          format: parsed.format ?? "json",
        },
        account: request.account,
        category: "read",
      },
    }
  },
}

const sheetsReadSchema = z.strictObject({
  spreadsheet: z.string().min(1).max(500),
  range: z.string().min(1).max(500),
  format: outputFormat.optional(),
})

const sheetsRead: HelperAdapter = {
  id: "sheets.read",
  service: "sheets",
  category: "read",
  inputSchema: sheetsReadSchema,
  build(input, request) {
    const parsed = this.inputSchema.parse(input) as z.infer<typeof sheetsReadSchema>
    const argv = ["sheets", "+read", "--spreadsheet", parsed.spreadsheet, "--range", parsed.range]
    if (parsed.format) argv.push("--format", parsed.format)
    return {
      id: this.id,
      category: "read",
      argv,
      preview: {
        method: "sheets +read",
        params: { spreadsheet: parsed.spreadsheet, range: parsed.range },
        account: request.account,
        category: "read",
      },
    }
  },
}

const meetingPrepSchema = z.strictObject({
  calendar: z.string().min(1).max(500).optional(),
  format: outputFormat.optional(),
})

const meetingPrep: HelperAdapter = {
  id: "workflow.meeting-prep",
  service: "workflow",
  category: "read",
  inputSchema: meetingPrepSchema,
  build(input, request) {
    const parsed = this.inputSchema.parse(input) as z.infer<typeof meetingPrepSchema>
    const argv = ["workflow", "+meeting-prep"]
    if (parsed.calendar) argv.push("--calendar", parsed.calendar)
    if (parsed.format) argv.push("--format", parsed.format)
    return {
      id: this.id,
      category: "read",
      argv,
      preview: {
        method: "workflow +meeting-prep",
        params: { calendar: parsed.calendar ?? "primary" },
        account: request.account,
        category: "read",
      },
    }
  },
}

const standupReportSchema = z.strictObject({
  format: outputFormat.optional(),
})

const standupReport: HelperAdapter = {
  id: "workflow.standup-report",
  service: "workflow",
  category: "read",
  inputSchema: standupReportSchema,
  build(input, request) {
    const parsed = this.inputSchema.parse(input) as z.infer<typeof standupReportSchema>
    const argv = ["workflow", "+standup-report"]
    if (parsed.format) argv.push("--format", parsed.format)
    return {
      id: this.id,
      category: "read",
      argv,
      preview: {
        method: "workflow +standup-report",
        params: { format: parsed.format ?? "json" },
        account: request.account,
        category: "read",
      },
    }
  },
}

const weeklyDigestSchema = z.strictObject({
  format: outputFormat.optional(),
})

const weeklyDigest: HelperAdapter = {
  id: "workflow.weekly-digest",
  service: "workflow",
  category: "read",
  inputSchema: weeklyDigestSchema,
  build(input, request) {
    const parsed = this.inputSchema.parse(input) as z.infer<typeof weeklyDigestSchema>
    const argv = ["workflow", "+weekly-digest"]
    if (parsed.format) argv.push("--format", parsed.format)
    return {
      id: this.id,
      category: "read",
      argv,
      preview: {
        method: "workflow +weekly-digest",
        params: { format: parsed.format ?? "json" },
        account: request.account,
        category: "read",
      },
    }
  },
}

const ADAPTERS = new Map<string, HelperAdapter>([
  [gmailSend.id, gmailSend],
  [gmailRead.id, gmailRead],
  ["gmail.reply", replyAdapter("gmail.reply", "+reply", false)],
  ["gmail.reply-all", replyAdapter("gmail.reply-all", "+reply-all", true)],
  [gmailForward.id, gmailForward],
  [gmailTriage.id, gmailTriage],
  [calendarAgenda.id, calendarAgenda],
  [sheetsRead.id, sheetsRead],
  [meetingPrep.id, meetingPrep],
  [standupReport.id, standupReport],
  [weeklyDigest.id, weeklyDigest],
])

export function helperAdapter(id: string): HelperAdapter | undefined {
  return ADAPTERS.get(id)
}
