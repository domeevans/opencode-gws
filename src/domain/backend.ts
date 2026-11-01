/**
 * The pinned upstream gws release and the per-platform npm packages that
 * carry its unmodified binary. Mirrors native/provenance.json, which
 * test/backend.test.ts keeps identical.
 */

export const GWS_VERSION = "gws 0.22.5"

interface GwsTarget {
  os: string
  cpu: string
  libc?: "glibc"
  /** SHA-256 of the unmodified upstream binary. */
  sha256: string
}

export const GWS_TARGETS: Readonly<Record<string, GwsTarget>> = {
  "darwin-arm64": { os: "darwin", cpu: "arm64", sha256: "0f27b8b0815bf09cdf95da48d3c604f05ceb8f16bf5c9f0ba355b1f957cdd47e" },
  "darwin-x64": { os: "darwin", cpu: "x64", sha256: "cfaf3c184ffe4ed4609cc6fbd75cc64ffa97b4cb7a71ceb7302ab8e89cd3f163" },
  "linux-arm64-gnu": { os: "linux", cpu: "arm64", libc: "glibc", sha256: "b68337faf1436fb2b3a287207cd57fef784a20fb4ab4f2429e51c4e0cfa0b50b" },
  "linux-x64-gnu": { os: "linux", cpu: "x64", libc: "glibc", sha256: "ab59c4bab4e7848740ba8cc3ef186152dab90121c45835b49bd1bf2a5c259b86" },
}

export interface Platform {
  os: string
  cpu: string
  /** True when the C library is glibc; only meaningful on Linux. */
  glibc: boolean
}

/** The target whose package serves `platform`, or undefined. */
export function gwsTarget(platform: Platform): string | undefined {
  return Object.keys(GWS_TARGETS).find((target) => {
    const entry = GWS_TARGETS[target]!
    return entry.os === platform.os && entry.cpu === platform.cpu && (entry.libc === undefined || platform.glibc)
  })
}

/** The npm package that carries gws for `target`. */
export function gwsPackage(target: string): string {
  return `@joe-broadhead/opencode-gws-bin-${target}`
}
