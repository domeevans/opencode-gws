import type { ResolvedSchema } from "../domain/contract.js"
import { parseSchemaOutput } from "../domain/schema.js"
import { runProcess } from "./run.js"

/**
 * Schema resolution through `gws schema`. Account-independent and cached per
 * method id. Cold calls fetch public Google Discovery into the owned cache.
 */
export class SchemaClient {
  private readonly cache = new Map<string, ResolvedSchema>()

  constructor(
    private readonly binary: string,
    private readonly cwd: string,
    private readonly env: Record<string, string>,
    private readonly timeoutMs = 15_000,
  ) {}

  async resolve(service: string, path: readonly string[], signal?: AbortSignal): Promise<ResolvedSchema> {
    const id = [service, ...path].join(".")
    const hit = this.cache.get(id)
    if (hit) return hit

    const result = await runProcess({
      binary: this.binary,
      argv: ["schema", id],
      cwd: this.cwd,
      env: this.env,
      timeoutMs: this.timeoutMs,
      maxStdoutBytes: 5 * 1024 * 1024,
      maxStderrBytes: 1 * 1024 * 1024,
      signal,
    })
    const resolved = parseSchemaOutput(id, result.stdout.toString("utf8"), result.stderr.toString("utf8"))
    this.cache.set(id, resolved)
    return resolved
  }
}
