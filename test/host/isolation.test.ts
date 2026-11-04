import { createServer, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { expect, it } from "vitest"
import { network } from "./setup.js"

async function listener(reply: (response: ServerResponse) => void) {
  let hits = 0
  const server = createServer((_request, response) => { hits++; reply(response) })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    get hits() { return hits },
    async close() {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

it("scrubs inherited environment before host modules load", () => {
  expect(Object.keys(process.env).filter((key) => ![
    "PATH", "HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME",
    "TMPDIR", "TMP", "TEMP", "LANG", "TZ", "NODE_ENV", "HOST_SDK_DIR",
  ].includes(key))).toEqual([])
  expect(process.env.HOME).toContain("plugin-host-worker-")
  // Outside the real home, where OpenCode's upward search would find .opencode/ folders.
  expect(process.env.HOME).toMatch(/^\/(?:private\/)?tmp\/plugin-host-worker-/)
})

it("blocks a reachable unregistered loopback listener with zero dispatch", async () => {
  const target = await listener((response) => response.end("fixture"))
  try {
    const revoke = network.allow(target.url)
    expect(await (await fetch(target.url)).text()).toBe("fixture")
    expect(target.hits).toBe(1) // Positive instrument control: reachable.
    revoke()
    const denied = network.denied
    await expect(fetch(target.url)).rejects.toThrow("HOST_FIXTURE_NETWORK_DENIED")
    await expect(fetch("https://example.invalid/")).rejects.toThrow("HOST_FIXTURE_NETWORK_DENIED")
    expect(network.denied).toBe(denied + 2)
    expect(target.hits).toBe(1)
  } finally { await target.close() }
})

it("blocks redirect hops even when Request and options request follow", async () => {
  const target = await listener((response) => response.end("destination"))
  const redirect = await listener((response) => { response.writeHead(302, { location: target.url }); response.end() })
  const revoke = network.allow(redirect.url)
  try {
    const revokeTarget = network.allow(target.url)
    await (await fetch(target.url)).text()
    revokeTarget()
    await expect(fetch(redirect.url, { redirect: "follow" })).rejects.toThrow()
    await expect(fetch(new Request(redirect.url, { redirect: "follow" }))).rejects.toThrow()
    expect(redirect.hits).toBe(2)
    expect(target.hits).toBe(1)
  } finally {
    revoke()
    await redirect.close()
    await target.close()
  }
})
