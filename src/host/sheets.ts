import { GwsError } from "../domain/errors.js"
import type { CallContext } from "../runtime/accounts.js"
import type { Runtime } from "../runtime/index.js"

/**
 * `gws.sheets`, the source contract's snapshot of one range of one spreadsheet, read with
 * `sheets.spreadsheets.values.get` and nothing else. A spreadsheet is a document its author chooses to read, not the
 * account's own mail or calendar, so the source is declared `private: false`: a consumer such as Artifacts may let an app
 * read it through the account of the person who chose it.
 *
 * - The input is `{ spreadsheetId, range }`: a spreadsheet id (the part of its link after `/spreadsheets/d/`) and an A1
 *   range, such as `Sheet1!A1:D50`, or a sheet's name for all of it. Anything else is INPUT_INVALID before any read.
 * - The answer is `{ range, sheet, rows }`: the range Google resolved (`'My sheet'!A1:D50`), the sheet's title from it,
 *   and the cells row by row, as the spreadsheet shows them (formatted strings). Google leaves out trailing empty rows
 *   and trailing empty cells in a row, so rows may differ in length.
 * - Google's 404 (no such spreadsheet) and 400 (a range it cannot read) are INPUT_INVALID, and its 403 (the account
 *   cannot open the spreadsheet) is PERMISSION_DENIED, the contract's codes: trying again with the same input will not
 *   help. An answer whose JSON is over `SHEETS_MAX_BYTES` is TOO_LARGE, never cut short.
 */

/** The method, its action, and the `source` value that names it. */
export const SHEETS_READ = { method: "sheets_read", action: "gws.sheets_read", source: "sheets" } as const
/** The one operation it runs. */
export const SHEETS_OPERATION = "sheets.spreadsheets.values.get"
/** The declaration's `maxBytes`: the contract's ceiling, 1 MB. */
export const SHEETS_MAX_BYTES = 1_048_576
/** A spreadsheet id: the letters, digits, `-` and `_` of the id in its link. */
export const SPREADSHEET_ID = /^[A-Za-z0-9_-]{10,128}$/
/** The longest range taken: a sheet title is at most 100 characters, and a range adds little to it. */
export const RANGE_MAX = 256

/** The source's `x-gws/sheet` output, inline in the declaration (`package.json` `sources`, test/sheets.test.ts). */
export const SHEET_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["range", "sheet", "rows"],
  properties: {
    range: { type: "string" },
    sheet: { type: "string" },
    rows: { type: "array", items: { type: "array", items: { type: ["string", "number", "boolean"] } } },
  },
} as const

export type Cell = string | number | boolean
export interface SheetValues {
  readonly range: string
  readonly sheet: string
  readonly rows: Cell[][]
}

/** The checked input: a spreadsheet id and an A1 range. Each problem is one sentence of INPUT_INVALID. */
export function sheetsParams(value: Readonly<Record<string, unknown>>): { spreadsheetId: string; range: string } {
  const problems: string[] = []
  const { spreadsheetId, range } = value
  if (typeof spreadsheetId !== "string" || !SPREADSHEET_ID.test(spreadsheetId)) {
    problems.push(`"spreadsheetId" must be a spreadsheet's id, the part of its link after /spreadsheets/d/`)
  }
  // A1 notation has no control characters; a sheet title may hold any other character, quoted.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the control characters are what it refuses
  if (typeof range !== "string" || range.trim().length === 0 || range.length > RANGE_MAX || /[\u0000-\u001f\u007f]/.test(range)) {
    problems.push(`"range" must be an A1 range, such as Sheet1!A1:D50, or a sheet's name, of at most ${RANGE_MAX} characters`)
  }
  if (problems.length > 0) throw new GwsError("INPUT_INVALID", problems.join("; "))
  return { spreadsheetId: spreadsheetId as string, range: range as string }
}

/** The sheet's title from a range Google resolved: `'It''s'!A1:B2` is `It's`, `Sheet1!A1` is `Sheet1`. */
export function sheetTitle(range: string): string {
  const bang = range.lastIndexOf("!")
  const name = bang === -1 ? range : range.slice(0, bang)
  return name.startsWith("'") && name.endsWith("'") && name.length >= 2 ? name.slice(1, -1).replaceAll("''", "'") : name
}

/** Google's refusal of this read as the contract's code, with its own next step; any other error unchanged. */
function refusal(error: unknown): unknown {
  const known = GwsError.from(error)
  if (known?.code !== "GWS_API_ERROR") return error
  if (known.status === 404 || known.status === 400) {
    return new GwsError("INPUT_INVALID", `Google has no spreadsheet with this id, or cannot read this range in it (${known.detail.slice(0, 200)})`, {
      next: "Check the spreadsheet id from its link, and the sheet's name and the range, then retry.",
    })
  }
  if (known.status === 403) {
    return new GwsError("PERMISSION_DENIED", `the account cannot open this spreadsheet (${known.detail.slice(0, 200)})`, {
      next: "Share the spreadsheet with the account, or read it as an account that can open it.",
    })
  }
  return error
}

/** Reads `range` of `spreadsheetId` as `account`: the answer the module describes, or its refusal. */
export async function readSheet(runtime: Pick<Runtime, "read">, account: string, params: { spreadsheetId: string; range: string }, ctx: CallContext): Promise<SheetValues> {
  let data: unknown
  try {
    data = (await runtime.read({ account, operation: SHEETS_OPERATION, params: { spreadsheetId: params.spreadsheetId, range: params.range, majorDimension: "ROWS" } }, ctx)).data
  } catch (error) {
    throw refusal(error)
  }
  const { range, values } = (data ?? {}) as { range?: unknown; values?: unknown }
  if (typeof range !== "string" || (values !== undefined && !Array.isArray(values))) {
    throw new GwsError("GWS_API_ERROR", "Google's answer for the range named no range or held no rows")
  }
  const rows = ((values ?? []) as unknown[]).map((row) =>
    (Array.isArray(row) ? row : []).map((cell): Cell => (typeof cell === "string" || typeof cell === "number" || typeof cell === "boolean" ? cell : "")),
  )
  return { range, sheet: sheetTitle(range), rows }
}
