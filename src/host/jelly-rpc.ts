import { Rpc } from "@opencode/plugin/rpc"
import { GwsError } from "../domain/errors.js"
import { PACKAGE_NAME } from "../domain/version.js"
import type { Runtime } from "../runtime/index.js"
import { TODAY_INPUT, TODAY_OUTPUT, calendarToday } from "./calendar.js"
import { markCalendarTodayCalled } from "./deprecated.js"
import type { PluginContext } from "./context.js"
import { IMAGE_INPUT, IMAGE_OUTPUT, type ImagesOptions, imagesRead } from "./images.js"

/**
 * The RPC Jelly calls a plugin's declared methods on (`jelly.rpc`): its id is the package's own name, and the engine
 * lets one registration hold an id, so every method Jelly calls lives in this one definition: `calendar.today`
 * (`./calendar.ts`; deprecated until 0.1.0, for `calendar_today` on the tools RPC, `./deprecated.ts`) and
 * `images.read` (`./images.ts`). A failure is the declared error `failed`, with the plugin's code and next step.
 */

const FAILED = { type: "object", properties: { code: { type: "string" }, next: { type: "string" } }, required: ["code", "next"] } as const

export const JellyRpc = Rpc.define({
  id: PACKAGE_NAME,
  methods: {
    "calendar.today": { input: TODAY_INPUT, output: TODAY_OUTPUT, errors: { failed: FAILED } },
    "images.read": { input: IMAGE_INPUT, output: IMAGE_OUTPUT, errors: { failed: FAILED } },
  },
  events: {},
})

/** A failure as the declared error's message and data, or the thrown value when it is not a plugin error. */
function failed(error: unknown): { message: string; data: { code: string; next: string } } {
  const failure = GwsError.from(error)
  if (failure === undefined) throw error
  return { message: failure.message, data: { code: failure.code, next: failure.next } }
}

/** Register the methods on the RPC named after the package. */
export async function registerJellyRpc(ctx: Pick<PluginContext, "rpc">, runtime: Runtime, options: ImagesOptions = {}): Promise<() => Promise<void>> {
  const today = calendarToday(runtime)
  const image = imagesRead(runtime, options)
  const registration = await ctx.rpc.register(JellyRpc, {
    "calendar.today": async (_input, context) => {
      markCalendarTodayCalled()
      try {
        return await runtime.wait((settled) => today(settled), context.signal)
      } catch (error) {
        const { message, data } = failed(error)
        return context.error("failed", message, data)
      }
    },
    "images.read": async (input, context) => {
      try {
        return await runtime.wait((settled) => image((input as { url?: unknown }).url, settled), context.signal)
      } catch (error) {
        const { message, data } = failed(error)
        return context.error("failed", message, data)
      }
    },
  })
  return async () => {
    await registration.dispose().catch(() => undefined)
  }
}
