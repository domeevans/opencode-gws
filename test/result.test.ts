import { describe, expect, it } from "vitest"
import { disabledApi, errorFromProcess, parseResult, processError } from "../src/domain/result.js"
import type { ProcessResult } from "../src/domain/types.js"

function processResult(stdout: unknown, exitCode: number | null = 1, stderr = ""): ProcessResult {
  const text = typeof stdout === "string" ? stdout : JSON.stringify(stdout)
  return { exitCode, signal: null, stdout: Buffer.from(text), stderr: Buffer.from(stderr), durationMs: 5, timedOut: false, outputCapped: false }
}

const failure = (result: ProcessResult) => processError(result, parseResult(result, { maxInlineBytes: 64 * 1024 }), "drive")

const ENABLE = "https://console.developers.google.com/apis/api/gmail.googleapis.com/overview?project=123456789"

describe("gws exit codes", () => {
  it.each([
    [2, "AUTH_REQUIRED", "Access denied. No credentials provided."],
    [3, "GWS_VALIDATION_ERROR", "--params is not valid JSON"],
    [4, "GWS_DISCOVERY_ERROR", "Failed to fetch the Discovery document"],
    [5, "GWS_INTERNAL_ERROR", "unexpected failure"],
    [1, "GWS_API_ERROR", "Requested entity was not found."],
  ])("reads exit %s as %s", (exit, code, message) => {
    const error = failure(processResult({ error: { code: 400, message } }, exit))
    expect(error.code).toBe(code)
    expect(error.message).toMatch(new RegExp(`^${code}: .*${message.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.* Next step: `))
  })

  it("prefers what Google's error says about the sign-in over the exit code", () => {
    expect(failure(processResult({ error: { code: 401, message: "Request had invalid authentication credentials.", reason: "authError" } }, 1)).code).toBe("AUTH_REQUIRED")
    const scope = processResult({ error: { code: 403, message: "Request had insufficient authentication scopes.", details: [{ reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT" }] } }, 2)
    expect(failure(scope).code).toBe("AUTH_SCOPE_MISSING")
  })

  it("reads an auth exit with nothing on stdout as a sign-in problem", () => {
    expect(failure(processResult("", 2, "error[auth]: missing credentials")).code).toBe("AUTH_REQUIRED")
  })

  it("names timeouts and output caps before anything else", () => {
    expect(failure({ ...processResult("", null), timedOut: true }).code).toBe("TIMEOUT")
    expect(failure({ ...processResult("", null), outputCapped: true }).code).toBe("OUTPUT_LIMIT")
  })

  it("keeps the message form for callers that need text", () => {
    const result = processResult({ error: { code: 404, message: "Requested entity was not found." } }, 1)
    expect(errorFromProcess(result, parseResult(result, { maxInlineBytes: 1024 }), "drive")).toBe(failure(result).message)
  })
})

describe("disabled APIs", () => {
  const disabled = {
    error: {
      code: 403,
      message: `Gmail API has not been used in project 123456789 before or it is disabled. Enable it by visiting ${ENABLE} then retry.`,
      reason: "accessNotConfigured",
      enable_url: ENABLE,
    },
  }

  it("become API_DISABLED with gws's enable link and the project", () => {
    const error = failure(processResult(disabled, 1))
    expect(error.code).toBe("API_DISABLED")
    expect(error.enableUrl).toBe(ENABLE)
    expect(error.message).toMatch(/^API_DISABLED: Gmail API has not been used in project 123456789/)
    expect(error.next).toBe(`Ask the user to open ${ENABLE} and enable the API for project 123456789, then wait about a minute and retry.`)
  })

  it("take the link from Google's message or gws's stderr hint when there is no enable_url", () => {
    const fromMessage = processResult({ error: { code: 403, message: disabled.error.message, details: [{ reason: "SERVICE_DISABLED" }] } }, 1)
    expect(disabledApi(fromMessage)).toEqual({ enableUrl: ENABLE, project: "123456789" })
    const fromHint = processResult(
      { error: { code: 403, message: "Drive API is disabled.", reason: "accessNotConfigured" } },
      1,
      "hint: Visit https://console.cloud.google.com/apis/library/drive.googleapis.com?project=my-project to enable the required API.",
    )
    expect(disabledApi(fromHint)).toEqual({ enableUrl: "https://console.cloud.google.com/apis/library/drive.googleapis.com?project=my-project", project: "my-project" })
  })

  it("still say what to do without a link", () => {
    const error = failure(processResult({ error: { code: 403, message: "Sheets API has not been used in project 42 before or it is disabled." } }, 1))
    expect(error).toMatchObject({ code: "API_DISABLED", next: expect.stringMatching(/project 42 in the Google Cloud console/) })
    expect(error.enableUrl).toBeUndefined()
  })

  it("ignore a link that is not the Google Cloud console", () => {
    const result = processResult({ error: { ...disabled.error, enable_url: "https://example.com/enable" , message: "API is disabled." } }, 1)
    expect(disabledApi(result)?.enableUrl).toBeUndefined()
  })

  it("are not reported for other errors", () => {
    expect(disabledApi(processResult({ error: { code: 404, message: "Requested entity was not found." } }, 1))).toBeUndefined()
  })
})
