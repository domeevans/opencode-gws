import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"

/**
 * A deterministic, OpenAI-compatible chat completions endpoint on
 * 127.0.0.1. OpenCode drives it exactly like a real provider: it streams
 * the system prompt, the tool definitions, and the transcript, and gets
 * back either text or one `execute` (Code Mode) tool call per turn.
 *
 * Requests without tools (title generation) get a fixed title and do not
 * consume a scripted turn.
 */

/** A Code Mode program, a direct call of one tool by its name (such as gws_send), or text. */
type Turn = { code: string } | { tool: string; input: unknown } | { text: string }

interface ModelRequest {
  /** Tool names offered to the model on this request. */
  tools: string[]
  /** All system and developer text concatenated. */
  system: string
  /** Content of the most recent `tool` message: what the last tool call returned to the model. */
  lastToolResult?: string
}

interface ChatMessage {
  role: string
  content?: unknown
}

interface ChatBody {
  messages?: ChatMessage[]
  tools?: Array<{ function?: { name?: string } }>
}

function text(content: unknown): string {
  if (typeof content === "string") return content
  if (Array.isArray(content)) return content.map((part) => (typeof part === "string" ? part : String((part as { text?: unknown }).text ?? ""))).join("")
  return content === undefined ? "" : JSON.stringify(content)
}

export class ScriptedModel {
  readonly requests: ModelRequest[] = []
  private readonly queue: Turn[] = []
  private server?: Server
  private calls = 0

  /** Queue turns for the next prompt. An empty queue answers "done". */
  script(...turns: Turn[]): void {
    this.queue.push(...turns)
  }

  get pending(): number {
    return this.queue.length
  }

  /** The tool result the model received after the most recent tool call. */
  lastToolResult(): string | undefined {
    for (let index = this.requests.length - 1; index >= 0; index -= 1) {
      const result = this.requests[index]?.lastToolResult
      if (result !== undefined) return result
    }
    return undefined
  }

  async start(): Promise<string> {
    this.server = createServer((request, response) => void this.handle(request, response))
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve))
    const { port } = this.server.address() as AddressInfo
    return `http://127.0.0.1:${port}/v1`
  }

  async stop(): Promise<void> {
    const server = this.server
    if (!server) return
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    let raw = ""
    for await (const chunk of request) raw += chunk
    if (request.method !== "POST" || !request.url?.endsWith("/chat/completions")) {
      response.writeHead(404).end()
      return
    }
    const body = JSON.parse(raw) as ChatBody
    const tools = (body.tools ?? []).map((tool) => tool.function?.name ?? "")
    if (tools.length === 0) return this.stream(response, { text: "Host integration test" })

    const messages = body.messages ?? []
    const last = messages.at(-1)
    this.requests.push({
      tools,
      system: messages.filter((message) => message.role === "system" || message.role === "developer").map((message) => text(message.content)).join("\n"),
      lastToolResult: last?.role === "tool" ? text(last.content) : undefined,
    })
    this.stream(response, this.queue.shift() ?? { text: "done" })
  }

  private stream(response: ServerResponse, turn: Turn): void {
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
    const send = (delta: Record<string, unknown>, finish: string | null = null) =>
      response.write(
        `data: ${JSON.stringify({ id: "chatcmpl-host", object: "chat.completion.chunk", created: 0, model: "scripted", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
      )
    if ("code" in turn) {
      this.calls += 1
      send({
        role: "assistant",
        tool_calls: [{ index: 0, id: `call_host_${this.calls}`, type: "function", function: { name: "execute", arguments: JSON.stringify({ code: turn.code }) } }],
      })
      send({}, "tool_calls")
    } else if ("tool" in turn) {
      this.calls += 1
      send({
        role: "assistant",
        tool_calls: [{ index: 0, id: `call_host_${this.calls}`, type: "function", function: { name: turn.tool, arguments: JSON.stringify(turn.input) } }],
      })
      send({}, "tool_calls")
    } else {
      send({ role: "assistant", content: turn.text })
      send({}, "stop")
    }
    response.end("data: [DONE]\n\n")
  }
}
