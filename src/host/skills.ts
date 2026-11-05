import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { Skill } from "@opencode/plugin"
import type { PluginConfig } from "../domain/types.js"
import type { PluginContext, SkillDraft } from "./context.js"
import { GwsError } from "../domain/errors.js"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..")

/**
 * The two hand-written skills. Service detail comes from gws_catalog and
 * gws_schema at runtime, not from a generated skill per service. Each
 * file's frontmatter is the one place its name and description live.
 */
const SKILL_IDS = ["opencode-gws", "opencode-gws-recipes"] as const

/** A skill file's frontmatter name and description, and its body; SKILLS_INVALID when either field is missing. */
export function parseSkill(raw: string, file: string): { name: string; description: string; content: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw)
  const front = match?.[1] ?? ""
  const name = /^name:\s*(.+)$/m.exec(front)?.[1]?.trim()
  const description = /^description:\s*(.+)$/m.exec(front)?.[1]?.trim()
  if (!match || !name || !description) throw new GwsError("SKILLS_INVALID", `The skill file ${file} has no name and description frontmatter`)
  return { name, description, content: (match[2] ?? "").trimStart() }
}

export async function registerSkills(ctx: PluginContext, config: PluginConfig): Promise<number> {
  if (!config.skills.enabled) return 0
  let registered = 0

  await ctx.skill.transform((draft: SkillDraft) => {
    for (const id of SKILL_IDS) {
      const file = `skills/${id}/SKILL.md`
      const path = join(ROOT, file)
      if (!existsSync(path)) throw new GwsError("SKILLS_INVALID", `The skill file ${file} is missing from the package`)
      const parsed = parseSkill(readFileSync(path, "utf8"), file)
      draft.add({
        id: Skill.ID.make(id),
        name: Skill.Name.make(parsed.name),
        description: parsed.description,
        path: Skill.Info.fields.path.make(path),
        content: parsed.content,
        autoinvoke: true,
      })
      registered += 1
    }
  })

  return registered
}
