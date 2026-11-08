// check-workflows.mjs -- lint the GitHub workflows with actionlint.
//
//   node scripts/check-workflows.mjs      every .github/workflows/*.yml
//
// actionlint is not a Node dependency: it is a Go binary. This script uses
// $ACTIONLINT_BIN when set, otherwise `actionlint` on PATH. Without either it
// prints a notice and exits 0, so a fresh clone still passes `npm run check`;
// CI runs actionlint in its own job, where a problem fails the run.

import { execFileSync, spawnSync } from "node:child_process"
import { existsSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = fileURLToPath(new URL("..", import.meta.url))
const DIR = join(ROOT, ".github", "workflows")

const files = existsSync(DIR) ? readdirSync(DIR).filter((name) => /\.ya?ml$/.test(name)).map((name) => join(DIR, name)) : []
if (files.length === 0) {
  console.log("check-workflows: no .github/workflows/*.yml to lint.")
  process.exit(0)
}

const binary = process.env.ACTIONLINT_BIN ?? "actionlint"
const found = spawnSync(binary, ["--version"], { encoding: "utf8" })
if (found.error || found.status !== 0) {
  console.log(
    `check-workflows: actionlint is not installed (${binary}), so the workflows were not linted. ` +
      "Install it from https://github.com/rhysd/actionlint or set ACTIONLINT_BIN; CI runs it for every pull request.",
  )
  process.exit(0)
}

try {
  // One call for every workflow, so actionlint treats them as the set they are.
  execFileSync(binary, files, { cwd: ROOT, stdio: "inherit" })
} catch {
  console.error(`check-workflows: actionlint reported a problem in ${files.length} workflow file(s).`)
  process.exit(1)
}

console.log(`check-workflows: ${files.length} workflow file(s) clean.`)
