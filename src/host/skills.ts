import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { Skill } from "@opencode/plugin"
import type { PluginConfig } from "../domain/types.js"
import type { PluginContext, SkillDraft } from "./context.js"
import { GwsError } from "../domain/errors.js"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..")

/**
 * The three hand-written skills. Service detail comes from gws_catalog and
 * gws_schema at runtime, not from a generated skill per service.
 * `opencode-gws-admin` is not auto-invoked.
 */
const ENTRIES = [
  {
    id: "opencode-gws",
    file: "opencode-gws/SKILL.md",
    description: "Use when working with Google Workspace accounts, reads, plans, commits, approvals, or errors.",
    autoinvoke: true,
  },
  {
    id: "opencode-gws-recipes",
    file: "opencode-gws-recipes/SKILL.md",
    description: "Use when building a Gmail, Drive, Calendar, Docs, or Sheets request for gws_read or gws_plan.",
    autoinvoke: true,
  },
  {
    id: "opencode-gws-admin",
    file: "opencode-gws-admin/SKILL.md",
    description: "Load only when the user asks for admin reports, Apps Script, Workspace Events, Model Armor, or a workflow helper.",
    autoinvoke: false,
  },
] as const

function parse(raw: string, fallbackName: string, fallbackDescription: string): { name: string; description: string; content: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw)
  if (!match) return { name: fallbackName, description: fallbackDescription, content: raw }
  const front = match[1] ?? ""
  return {
    name: /^name:\s*(.+)$/m.exec(front)?.[1]?.trim() ?? fallbackName,
    description: /^description:\s*(.+)$/m.exec(front)?.[1]?.trim() ?? fallbackDescription,
    content: (match[2] ?? "").trimStart(),
  }
}

export async function registerSkills(
  ctx: PluginContext,
  config: PluginConfig,
  visibleServices: ReadonlySet<string>,
): Promise<number> {
  void visibleServices
  if (!config.skills.enabled) return 0
  const include = new Set(config.skills.include)
  const exclude = new Set(config.skills.exclude)
  let registered = 0

  await ctx.skill.transform((draft: SkillDraft) => {
    for (const entry of ENTRIES) {
      if (exclude.has(entry.id)) continue
      if (include.size > 0 && !include.has(entry.id)) continue
      const path = join(ROOT, "skills", entry.file)
      if (!existsSync(path)) throw new GwsError("SKILLS_INVALID", `The skill file skills/${entry.file} is missing from the package`)
      const parsed = parse(readFileSync(path, "utf8"), entry.id, entry.description)
      draft.add({
        id: Skill.ID.make(entry.id),
        name: Skill.Name.make(parsed.name),
        description: parsed.description,
        path: Skill.Info.fields.path.make(path),
        content: parsed.content,
        autoinvoke: entry.autoinvoke,
      })
      registered += 1
    }
  })

  return registered
}
