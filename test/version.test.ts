import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { HOST_RANGE, TESTED_HOSTS, checkHost } from "../src/domain/host.js"
import { PLUGIN_VERSION } from "../src/domain/version.js"

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string
  opencode: { host: string }
}

describe("package versions", () => {
  it("keeps PLUGIN_VERSION equal to package.json", () => {
    expect(PLUGIN_VERSION).toBe(pkg.version)
  })

  it("keeps the host range equal to package.json opencode.host, the tested 2.2 line from 2.2.3", () => {
    expect(HOST_RANGE).toBe(pkg.opencode.host)
    expect(HOST_RANGE).toBe(">=2.2.3 <2.3.0")
  })
})

describe("checkHost", () => {
  it("accepts 2.2.3 and later 2.2 releases, and calls only the listed ones tested", () => {
    expect(TESTED_HOSTS).toEqual(["2.2.3", "2.2.4", "2.2.5"])
    for (const version of ["2.2.3", "2.2.4", "2.2.5", "v2.2.3", " 2.2.3 "]) {
      expect(checkHost(version, HOST_RANGE, false)).toEqual({ version: version.trim(), range: HOST_RANGE, tested: true })
    }
    for (const version of ["2.2.6", "2.2.10", "2.2.4+build.7"]) {
      expect(checkHost(version, HOST_RANGE, false)).toEqual({ version, range: HOST_RANGE, tested: false })
    }
  })

  it("refuses older, untested-minor, newer-major, prerelease, dev, malformed and missing versions with HOST_UNTESTED", () => {
    for (const version of ["2.1.9", "2.2.2", "2.3.0", "2.10.0", "3.0.0", "2.2.4-beta.1", "2.2.3-rc.1", "0.0.0-dev-1", "latest", "", undefined, 2]) {
      expect(() => checkHost(version, HOST_RANGE, false), String(version)).toThrow(/^HOST_UNTESTED: Supports OpenCode >=2\.2\.3 <2\.3\.0, found /)
    }
  })

  it("names the found version and the next step", () => {
    expect(() => checkHost("2.3.0", HOST_RANGE, false)).toThrow(
      'HOST_UNTESTED: Supports OpenCode >=2.2.3 <2.3.0, found 2.3.0. Next step: Use OpenCode 2.2.3 or a later 2.2.x release, or set "allowUntestedHost": true.',
    )
    expect(() => checkHost(undefined, HOST_RANGE, false)).toThrow("found unknown.")
  })

  it("continues, untested, when allowUntestedHost is set", () => {
    for (const version of ["2.2.2", "2.3.0", "3.0.0", "2.2.4-beta.1", "0.0.0-dev-1"]) {
      expect(checkHost(version, HOST_RANGE, true)).toEqual({ version, range: HOST_RANGE, tested: false })
    }
    expect(checkHost(undefined, HOST_RANGE, true)).toEqual({ version: null, range: HOST_RANGE, tested: false })
    expect(checkHost("2.2.3", HOST_RANGE, true)).toEqual({ version: "2.2.3", range: HOST_RANGE, tested: true })
  })

  it("rejects any range outside the one supported comparator form", () => {
    for (const range of ["^2.2.3", ">=2.2.3", "2.2.x", ">=2.2.3 <2.3.0 || >=3.0.0"]) {
      expect(() => checkHost("2.2.3", range, false), range).toThrow(`invalid host range ${range}`)
    }
  })
})
