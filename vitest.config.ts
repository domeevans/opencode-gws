import { readFileSync } from "node:fs"
import { defineConfig } from "vitest/config"

const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string }

export default defineConfig({
  // scripts/bundle.mjs sets the same constant from package.json.
  define: { __PLUGIN_VERSION__: JSON.stringify(version) },
  // src/tui.tsx ships compiled by babel-preset-solid, then bundled (scripts/bundle.mjs).
  // Tests only need its logic, so JSX goes through the automatic runtime,
  // which test/tui.test.ts mocks.
  oxc: { jsx: { runtime: "automatic", importSource: "@opentui/solid" } },
  test: {
    include: ["test/**/*.test.ts"],
    // The embedded-host suite has its own config and dependencies: npm run test:host.
    exclude: ["test/host/**", "**/node_modules/**"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
