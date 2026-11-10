#!/usr/bin/env node
/**
 * Fetches the pinned, unmodified upstream gws binary and checks it against native/provenance.json. Two uses:
 *
 *   node scripts/build-native.mjs [--all] [--target <target>]
 *       Development (`npm run fetch:gws`): puts each verified binary at .cache/gws/<target>/gws. Tests and a checkout
 *       name that path with binary.path, since a checkout has no release manifest.
 *
 *   node scripts/build-native.mjs --release <dir> --tag <tag> --repository <owner/repo> --commit <sha> --run <id>
 *       Release (the `native` workflow): for every target, writes <dir>/gws-<target>.gz (the gzip of the executable)
 *       and <dir>/native-manifest.json, the candidate manifest/native.json that the release commit pins. The commit and
 *       the workflow run are the build's own, so the release can check them.
 *
 * Each archive is downloaded once into .cache/gws-archives/ (HTTPS only), its sha256 checked against the pin, and only
 * `gws` and its LICENSE are extracted. The executable's size and sha256 are checked against the pin before anything
 * is written, so a wrong file never reaches a manifest.
 */
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { gzipSync } from "node:zlib"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const PROVENANCE = join(ROOT, "native", "provenance.json")
const ARCHIVES = join(ROOT, ".cache", "gws-archives")
const MODULE = "gws"

const readProvenance = () => JSON.parse(readFileSync(PROVENANCE, "utf8"))
const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex")

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", shell: false })
  if (result.error) throw new Error(`${command} failed to start: ${result.error.message}`)
  if (result.status !== 0) throw new Error(`${command} ${args[0]} failed (exit ${result.status}): ${result.stderr.trim()}`)
  return result.stdout
}

/** The pinned archive, downloaded once and checked on every use. */
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

/** Extracts only the `gws` executable and the upstream LICENSE into a fresh folder; the caller removes it. */
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
  const binary = join(dir, members.binary)
  const license = join(dir, members.license)
  if (!lstatSync(binary).isFile() || !lstatSync(license).isFile()) throw new Error(`${target}: the archive entries are not regular files`)
  return { dir, binary, license }
}

/** The executable for `target`, verified against the pin: its size and sha256 as the pin records them. */
function verifiedExecutable(target, provenance) {
  const entry = provenance.targets[target]
  if (!entry) throw new Error(`unknown target ${target}; known: ${Object.keys(provenance.targets).join(", ")}`)
  if (!entry.binary) throw new Error(`${target}: no binary digest in native/provenance.json; verify the archive, then run with --record`)
  const extracted = extract(target, archive(target, entry))
  try {
    const bytes = lstatSync(extracted.binary).size
    const digest = sha256(extracted.binary)
    if (digest !== entry.binary.sha256 || bytes !== entry.binary.bytes) {
      throw new Error(`${target}: binary sha256 ${digest} (${bytes} bytes) does not match native/provenance.json`)
    }
    return { binary: readFileSync(extracted.binary), bytes, sha256: digest }
  } finally {
    rmSync(extracted.dir, { recursive: true, force: true })
  }
}

/** Development: each target's executable at .cache/gws/<target>/gws, mode 0755. */
function fetchDevelopment(targets, provenance) {
  for (const target of targets) {
    const folder = join(ROOT, ".cache", MODULE, target)
    const path = join(folder, MODULE)
    const { binary, sha256: digest } = verifiedExecutable(target, provenance)
    mkdirSync(folder, { recursive: true })
    writeFileSync(path, binary)
    chmodSync(path, 0o755)
    console.log(`fetch:gws: ${path} (${digest.slice(0, 12)})`)
  }
}

/** Release: <dir>/gws-<target>.gz for every target, and the candidate manifest that pins them. */
function buildRelease(dir, { tag, repository, commit, run }, provenance, pkgName) {
  mkdirSync(dir, { recursive: true })
  const modules = {}
  for (const target of Object.keys(provenance.targets)) {
    const { binary, bytes, sha256: digest } = verifiedExecutable(target, provenance)
    const gz = gzipSync(binary, { level: 9 })
    const name = `${MODULE}-${target}.gz`
    writeFileSync(join(dir, name), gz)
    modules[target] = {
      name,
      url: `https://github.com/${repository}/releases/download/${tag}/${name}`,
      bytes: gz.length,
      sha256: createHash("sha256").update(gz).digest("hex"),
      executable: { name: MODULE, bytes, sha256: digest },
    }
    console.log(`release: ${name} ${gz.length} bytes (executable ${bytes})`)
  }
  const manifest = { schema: 1, plugin: pkgName, repository, tag, built: { commit, run: Number(run), workflow: "native" }, modules: { [MODULE]: modules } }
  writeFileSync(join(dir, "native-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`)
  console.log(`release: ${join(dir, "native-manifest.json")}`)
}

function main(argv) {
  const provenance = readProvenance()
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"))
  const flags = { all: false, target: undefined, release: undefined, tag: undefined, repository: undefined, commit: undefined, run: undefined }
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === "--all") flags.all = true
    else if (arg === "--target") flags.target = argv[++index]
    else if (arg === "--release") flags.release = argv[++index]
    else if (arg === "--tag") flags.tag = argv[++index]
    else if (arg === "--repository") flags.repository = argv[++index]
    else if (arg === "--commit") flags.commit = argv[++index]
    else if (arg === "--run") flags.run = argv[++index]
    else throw new Error(`unknown argument ${arg}`)
  }
  if (flags.release !== undefined) {
    if (!flags.tag || !flags.repository || !/^[a-f0-9]{40}$/.test(flags.commit ?? "") || !/^\d+$/.test(flags.run ?? "")) {
      throw new Error("--release needs --tag, --repository, --commit (the 40-hex commit built) and --run (the workflow run id)")
    }
    buildRelease(resolve(flags.release), flags, provenance, pkg.name.replace(/^@[^/]+\//, ""))
    return
  }
  const all = Object.keys(provenance.targets)
  const targets = flags.all ? all : [flags.target ?? hostTarget(provenance)]
  if (targets.some((target) => target === undefined)) throw new Error(`no gws binary for ${process.platform}-${process.arch}; pass --target or --all`)
  fetchDevelopment(targets, provenance)
}

/** The provenance target this machine runs, or undefined (Windows, musl, other CPUs). */
export function hostTarget(provenance) {
  const glibc = process.platform === "linux" ? Boolean(process.report.getReport().header.glibcVersionRuntime) : false
  return Object.keys(provenance.targets).find((target) => {
    const entry = provenance.targets[target]
    return entry.os === process.platform && entry.cpu === process.arch && (entry.libc === undefined || (entry.libc === "glibc" && glibc))
  })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2))
