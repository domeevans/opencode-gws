import { basename, isAbsolute, relative } from "node:path"

/**
 * Local files a gws call reads or writes. gws accepts `--upload`,
 * `--output`, and `--attach` paths only inside its working directory, so
 * argv never carries a user path: it names a fixed relative path inside a
 * per-call staging directory (the gws cwd), and the process layer copies
 * inputs in before the spawn and delivers the output after it. The relative
 * paths are deterministic, so a plan's stored argv stays valid at commit.
 */

export interface InputFile {
  /** Absolute user path, as requested (checked against read roots). */
  source: string
  /** Path inside the staging directory, as passed on argv. */
  rel: string
}

export interface OutputFile {
  /** Absolute user path, as requested (checked against write roots). */
  destination: string
  rel: string
  overwrite: boolean
}

export interface FileSpecs {
  inputs: InputFile[]
  output?: OutputFile
}

/** An input staged and fingerprinted at plan time; the commit must stage the same bytes. */
export interface StagedInput extends InputFile {
  bytes: number
  sha256: string
}

/** Limits that the process layer re-checks on resolved paths. */
export interface FileLimits {
  maxUploadBytes: number
  maxDownloadBytes: number
  /** Every set applies; an empty list means unrestricted. */
  readRoots: string[][]
  writeRoots: string[][]
}

/** A plan's files: what the commit must re-stage and where it must deliver. */
export interface PlannedFiles {
  inputs: StagedInput[]
  output?: OutputFile
  limits: FileLimits
}

function inputRel(index: number, source: string): string {
  return `in/${index}/${basename(source)}`
}

export function outputRel(destination: string): string {
  return `out/${basename(destination)}`
}

export function inputFiles(sources: readonly string[] | undefined, offset = 0): InputFile[] {
  return (sources ?? []).map((source, index) => ({ source, rel: inputRel(offset + index, source) }))
}

export function hasFiles(files: FileSpecs | undefined): files is FileSpecs {
  return files !== undefined && (files.inputs.length > 0 || files.output !== undefined)
}

/** True when `path` is `root` or below it. Both must be absolute. */
export function underRoot(path: string, root: string): boolean {
  if (!isAbsolute(path) || !isAbsolute(root)) return false
  const rel = relative(root, path)
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))
}

/** True when `path` is inside at least one root of every set. */
export function withinRootSets(path: string, sets: readonly (readonly string[])[]): boolean {
  return sets.every((roots) => roots.some((root) => underRoot(path, root)))
}
