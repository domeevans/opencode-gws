import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterAll } from "vitest"
import { installNetworkGuard } from "./network.js"

// Runs before tests import plugin contracts or the SDK. Remove provider keys,
// proxy settings and credential paths, not just OPENCODE-prefixed variables.
const sdkOverride = process.env.HOST_SDK_DIR
const root = realpathSync(mkdtempSync(join(tmpdir(), "plugin-host-worker-")))
for (const key of Object.keys(process.env)) delete process.env[key]
Object.assign(process.env, {
  PATH: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
  HOME: join(root, "home"),
  XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"),
  XDG_STATE_HOME: join(root, "state"), XDG_CACHE_HOME: join(root, "cache"),
  TMPDIR: join(root, "tmp"), TMP: join(root, "tmp"), TEMP: join(root, "tmp"),
  LANG: "en_US.UTF-8", TZ: "UTC", NODE_ENV: "test",
  ...(sdkOverride ? { HOST_SDK_DIR: sdkOverride } : {}),
})
for (const name of ["home", "config", "data", "state", "cache", "tmp"]) mkdirSync(join(root, name))
export const network = installNetworkGuard()
afterAll(() => {
  network.restore()
  rmSync(root, { recursive: true, force: true })
})
