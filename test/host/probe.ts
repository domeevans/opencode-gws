import { Plugin } from "@opencode/plugin"

/**
 * Test-only SDK plugin that captures its plugin context so a test can read
 * host registries the HTTP API does not expose, such as `ctx.tool.list()`.
 */

type ProbeContext = Parameters<ReturnType<typeof Plugin.define>["setup"]>[0]

export interface Probe {
  plugin: ReturnType<typeof Plugin.define>
  context(directory: string): ProbeContext
}

export function createProbe(): Probe {
  const contexts = new Map<string, ProbeContext>()
  return {
    plugin: Plugin.define({
      id: "opencode-gws.test.probe",
      setup(ctx) {
        if (ctx.location?.directory) contexts.set(ctx.location.directory, ctx)
      },
    }),
    context(directory) {
      const ctx = contexts.get(directory)
      if (!ctx) throw new Error(`probe plugin was not set up for ${directory}`)
      return ctx
    },
  }
}
