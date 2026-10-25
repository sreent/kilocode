export * as Bedrock from "./bedrock"

import { EventStream } from "./eventstream"

// Claude on Amazon Bedrock. Clients send the gateway Anthropic Messages requests; Bedrock takes the
// same body with the model in the path, the API version in the body, and answers streams in its
// binary event stream, each event carrying one Anthropic stream event. The gateway converts both
// ways, so clients see the Anthropic API they sent.

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export function request(input: {
  readonly base: string
  readonly model: string
  readonly payload: Record<string, unknown>
  // The client's anthropic-beta header; Bedrock takes the flags in the body.
  readonly beta: string | undefined
}) {
  const { model: _, stream, ...rest } = input.payload
  const beta = input.beta
    ?.split(",")
    .map((item) => item.trim())
    .filter(Boolean)
  const body = {
    ...rest,
    anthropic_version: rest.anthropic_version ?? "bedrock-2023-05-31",
    ...(beta?.length ? { anthropic_beta: beta } : {}),
  }
  const streaming = stream === true
  return {
    url: `${input.base}/model/${encodeURIComponent(input.model)}/${streaming ? "invoke-with-response-stream" : "invoke"}`,
    body: encoder.encode(JSON.stringify(body)),
    accept: streaming ? "application/vnd.amazon.eventstream" : "application/json",
  }
}

// Bedrock's exception names, as Anthropic error types.
const errors: Record<string, string> = {
  throttlingException: "rate_limit_error",
  serviceUnavailableException: "overloaded_error",
  modelNotReadyException: "overloaded_error",
  validationException: "invalid_request_error",
  accessDeniedException: "permission_error",
  resourceNotFoundException: "not_found_error",
}

const event = (type: string, data: string) => encoder.encode(`event: ${type}\ndata: ${data}\n\n`)

const failure = (type: string, message: string) =>
  event("error", JSON.stringify({ type: "error", error: { type, message } }))

// Turns Bedrock's event stream into Anthropic server-sent events, one chunk of bytes at a time.
export function events() {
  const decode = EventStream.decoder()
  return (chunk: Uint8Array): Uint8Array[] => {
    const out: Uint8Array[] = []
    for (const message of decode(chunk)) {
      const type = message.headers[":message-type"]
      const body = (() => {
        try {
          return JSON.parse(decoder.decode(message.payload)) as Record<string, unknown>
        } catch {
          return {}
        }
      })()
      if (type === "event" && message.headers[":event-type"] === "chunk" && typeof body.bytes === "string") {
        const data = Buffer.from(body.bytes, "base64").toString("utf8")
        const parsed = (() => {
          try {
            return JSON.parse(data) as { type?: unknown }
          } catch {
            return undefined
          }
        })()
        if (typeof parsed?.type === "string") out.push(event(parsed.type, data))
        continue
      }
      if (type === "exception" || type === "error") {
        const name = message.headers[":exception-type"] ?? message.headers[":error-code"] ?? ""
        const text = typeof body.message === "string" ? body.message : name || "Bedrock failed the request"
        out.push(failure(errors[name] ?? "api_error", text))
      }
    }
    return out
  }
}

// Bedrock answers failures with {"message": "..."}; clients expect Anthropic's error body.
export function error(status: number, body: Uint8Array) {
  const parsed = (() => {
    try {
      return JSON.parse(decoder.decode(body)) as { message?: unknown; Message?: unknown }
    } catch {
      return undefined
    }
  })()
  const message =
    typeof parsed?.message === "string"
      ? parsed.message
      : typeof parsed?.Message === "string"
        ? parsed.Message
        : `Bedrock answered ${status}`
  const type =
    status === 429
      ? "rate_limit_error"
      : status === 403
        ? "permission_error"
        : status === 404
          ? "not_found_error"
          : status < 500
            ? "invalid_request_error"
            : "api_error"
  return encoder.encode(JSON.stringify({ type: "error", error: { type, message } }))
}
