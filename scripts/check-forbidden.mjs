#!/usr/bin/env node
// Fails when a forbidden word appears in a git-tracked file: the family's working folders, and the owner's private names.
// The rule is the kit's forbidden-words block, appended below. Wire this file into the repo's lint stage.

// The family's working folders and the owner's private names never reach a public file. This reads every git-tracked
// file, so a note in a doc, a skill or a fixture is caught as well as code. AGENTS.md and this script name them on
// purpose and are skipped. Case does not matter.
{
  const { realpathSync, existsSync, readFileSync } = await import("node:fs")
  const { execFileSync } = await import("node:child_process")
  const { join, dirname } = await import("node:path")
  const { fileURLToPath } = await import("node:url")
  const WORDS = /opencode-release\/|prosus|toqan/i
  const self = realpathSync(fileURLToPath(import.meta.url))
  if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === self) {
    const repo = join(dirname(self), "..")
    let listed = []
    try {
      listed = execFileSync("git", ["ls-files", "-z"], { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).split("\0").filter(Boolean)
    } catch {
      // Not a git checkout, such as a packed tarball: the scan above covers the shipped files.
    }
    const hits = []
    for (const path of listed) {
      if (path === "AGENTS.md" || path === "scripts/check-forbidden.mjs") continue
      const file = join(repo, path)
      if (!existsSync(file)) continue
      const buffer = readFileSync(file)
      if (buffer.includes(0)) continue
      buffer.toString("utf8").split(/\r?\n/).forEach((text, index) => {
        if (WORDS.test(text)) hits.push(`${path}:${index + 1}`)
      })
    }
    if (hits.length) {
      console.error(`forbidden-words: the family's working folders and the owner's private names must not appear in a public file:\n  ${hits.join("\n  ")}`)
      process.exitCode = 1
    }
  }
}
