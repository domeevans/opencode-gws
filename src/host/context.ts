import type { Plugin } from "@opencode/plugin"

/**
 * Host types derived from the public `@opencode/plugin` API. Every module
 * under `src/host/` takes these instead of re-deriving them, so a host API
 * change surfaces in one file.
 */

type PluginDefinition = ReturnType<typeof Plugin.define>

export type PluginContext = Parameters<PluginDefinition["setup"]>[0]
export type ToolEditor = Parameters<Parameters<PluginContext["tool"]["transform"]>[0]>[0]
export type SkillDraft = Parameters<Parameters<PluginContext["skill"]["transform"]>[0]>[0]
export type IntegrationDraft = Parameters<Parameters<PluginContext["integration"]["transform"]>[0]>[0]
export type ToolInfo = Parameters<ToolEditor["add"]>[0]
export type ToolContext = Parameters<ToolInfo["execute"]>[1]
