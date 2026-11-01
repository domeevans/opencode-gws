#!/usr/bin/env node
/**
 * Build the per-platform packages @joe-broadhead/opencode-gws-bin-<target>
 * from the pinned, unmodified upstream gws release.
 *
 *   node scripts/build-bin-packages.mjs [--target <target> | --all] [--out <dir>] [--record]
 *
 * Without --target or --all it builds this machine's target. Each package is
 * written to <out>/opencode-gws-bin-<target>/ (default out: .cache/gws-bin).
 *
 * For each target: download the release archive named in native/provenance.json
 * into .cache/gws-archives/ (HTTPS only, following redirects; curl honours
 * HTTPS_PROXY), verify its pinned sha256, extract only the `gws` executable
 * with the system tar into a fresh directory, and verify the binary sha256.
 * A cached archive that verifies is reused without network access. With
 * --record, a binary digest missing from native/provenance.json is written
 * there instead; a recorded digest is never replaced.
 */
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const PROVENANCE = join(ROOT, "native", "provenance.json")
const TEMPLATE = join(ROOT, "packages", "gws-bin")
const ARCHIVES = join(ROOT, ".cache", "gws-archives")
export const PACKAGE_SCOPE = "@joe-broadhead"

export function readProvenance() {
  return JSON.parse(readFileSync(PROVENANCE, "utf8"))
}

export function packageName(target) {
  return `${PACKAGE_SCOPE}/opencode-gws-bin-${target}`
}

/** This machine's target, or undefined when no package serves it (Windows, musl, other CPUs). */
export function hostTarget(provenance = readProvenance()) {
  const glibc = process.platform === "linux" ? Boolean(process.report.getReport().header.glibcVersionRuntime) : false
  return Object.keys(provenance.targets).find((target) => {
    const entry = provenance.targets[target]
    return entry.os === process.platform && entry.cpu === process.arch && (entry.libc === undefined || (entry.libc === "glibc" && glibc))
  })
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex")
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", shell: false })
  if (result.error) throw new Error(`${command} failed to start: ${result.error.message}`)
  if (result.status !== 0) throw new Error(`${command} ${args[0]} failed (exit ${result.status}): ${result.stderr.trim()}`)
  return result.stdout
}

function archive(target, entry) {
  mkdirSync(ARCHIVES, { recursive: true })
  const path = join(ARCHIVES, new URL(entry.archive.url).pathname.split("/").at(-1))
  if (existsSync(path)) {
    if (sha256(path) === entry.archive.sha256) return path
    rmSync(path)
  }
  const partial = `${path}.partial`
  rmSync(partial, { force: true })
  console.log(`downloading ${entry.archive.url}`)
  run("curl", ["--fail", "--location", "--silent", "--show-error", "--proto", "=https", "--proto-redir", "=https", "--retry", "2", "--output", partial, entry.archive.url])
  const digest = sha256(partial)
  if (digest !== entry.archive.sha256) {
    rmSync(partial)
    throw new Error(`${target}: archive sha256 ${digest} does not match the pinned ${entry.archive.sha256}`)
  }
  renameSync(partial, path)
  return path
}

/**
 * Extract only the `gws` executable and the upstream LICENSE into a fresh
 * directory; the caller removes it.
 */
function extract(target, archivePath) {
  const listing = run("tar", ["-tzf", archivePath]).split("\n")
  const member = (name) => {
    const found = listing.filter((entry) => entry.split("/").at(-1) === name)
    if (found.length !== 1) throw new Error(`${target}: expected one ${name} entry in the archive, found ${found.length}`)
    if (found[0].startsWith("/") || found[0].split("/").includes("..")) throw new Error(`${target}: unsafe archive entry ${found[0]}`)
    return found[0]
  }
  const members = { binary: member("gws"), license: member("LICENSE") }
  const dir = mkdtempSync(join(ARCHIVES, `extract-${target}-`))
  run("tar", ["-xzf", archivePath, "-C", dir, "--", members.binary, members.license])
  const files = Object.fromEntries(Object.entries(members).map(([key, name]) => [key, join(dir, name)]))
  for (const [key, path] of Object.entries(files)) {
    if (!lstatSync(path).isFile()) throw new Error(`${target}: archive entry ${members[key]} is not a regular file`)
  }
  return { dir, binary: files.binary, license: files.license, bytes: lstatSync(files.binary).size }
}

/** Build one package directory; returns its path. Mutates `provenance` when recording. */
export function buildPackage(target, outDir, { record = false, provenance = readProvenance() } = {}) {
  const entry = provenance.targets[target]
  if (!entry) throw new Error(`unknown target ${target}; known: ${Object.keys(provenance.targets).join(", ")}`)
  const root = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"))
  const version = root.version
  const extracted = extract(target, archive(target, entry))
  try {
    const digest = sha256(extracted.binary)
    if (!entry.binary) {
      if (!record) throw new Error(`${target}: no binary sha256 in native/provenance.json; run with --record after verifying the archive`)
      entry.binary = { sha256: digest, bytes: extracted.bytes }
    }
    if (digest !== entry.binary.sha256 || extracted.bytes !== entry.binary.bytes) {
      throw new Error(`${target}: binary sha256 ${digest} (${extracted.bytes} bytes) does not match native/provenance.json`)
    }
    if (sha256(extracted.license) !== sha256(join(TEMPLATE, "LICENSE"))) {
      throw new Error(`${target}: the archive LICENSE differs from packages/gws-bin/LICENSE`)
    }

    const dir = join(resolve(outDir), `opencode-gws-bin-${target}`)
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(join(dir, "bin"), { recursive: true })
    const template = JSON.parse(readFileSync(join(TEMPLATE, "package.template.json"), "utf8"))
    // A gws package is private exactly when the main package is, so the release commit's one change covers both.
    const manifest = {
      name: packageName(target),
      version,
      ...(root.private === undefined ? {} : { private: root.private }),
      ...template,
      os: [entry.os],
      cpu: [entry.cpu],
      ...(entry.libc ? { libc: [entry.libc] } : {}),
    }
    writeFileSync(join(dir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`)
    copyFileSync(extracted.binary, join(dir, "bin", "gws"))
    chmodSync(join(dir, "bin", "gws"), 0o755)
    copyFileSync(join(TEMPLATE, "LICENSE"), join(dir, "LICENSE"))
    writeFileSync(join(dir, "NOTICE"), readFileSync(join(TEMPLATE, "NOTICE"), "utf8").replaceAll("<target>", target).replaceAll("<triple>", entry.triple))
    const { targets: _all, ...shared } = provenance
    writeFileSync(join(dir, "provenance.json"), `${JSON.stringify({ ...shared, target, ...entry }, null, 2)}\n`)
    return dir
  } finally {
    rmSync(extracted.dir, { recursive: true, force: true })
  }
}

function main(argv) {
  const options = { targets: [], out: join(ROOT, ".cache", "gws-bin"), record: false }
  const provenance = readProvenance()
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === "--all") options.targets = Object.keys(provenance.targets)
    else if (arg === "--target") options.targets = [argv[++index]]
    else if (arg === "--out") options.out = argv[++index]
    else if (arg === "--record") options.record = true
    else throw new Error(`unknown argument ${arg}`)
  }
  if (options.targets.length === 0) {
    const target = hostTarget(provenance)
    if (!target) throw new Error(`no gws package for ${process.platform}-${process.arch}; pass --target or --all`)
    options.targets = [target]
  }
  for (const target of options.targets) console.log(`built ${buildPackage(target, options.out, { record: options.record, provenance })}`)
  if (options.record) writeFileSync(PROVENANCE, `${JSON.stringify(provenance, null, 2)}\n`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2))
