export * as Vertex from "./vertex"

// Claude on Google Vertex AI. Clients send the gateway Anthropic Messages requests; Vertex takes
// the same body with the model in the path and the API version in the body, and streams
// Anthropic's own server-sent events back.
// https://cloud.google.com/vertex-ai/generative-ai/docs/partner-models/claude/use-claude

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export function request(input: {
  // https://<location>-aiplatform.googleapis.com/v1/projects/<project>/locations/<location>
  readonly base: string
  readonly path: "/messages" | "/messages/count_tokens"
  readonly model: string
  readonly payload: Record<string, unknown>
}) {
  const { model, ...rest } = input.payload
  const version = rest.anthropic_version ?? "vertex-2023-10-16"
  // Counting tokens takes the model in the body, at a fixed path.
  if (input.path === "/messages/count_tokens")
    return {
      url: `${input.base}/publishers/anthropic/models/count-tokens:rawPredict`,
      body: encoder.encode(JSON.stringify({ ...rest, model, anthropic_version: version })),
    }
  const method = rest.stream === true ? "streamRawPredict" : "rawPredict"
  // Vertex model ids carry their version after an @, which Google's own SDK sends as it is.
  return {
    url: `${input.base}/publishers/anthropic/models/${input.model}:${method}`,
    body: encoder.encode(JSON.stringify({ ...rest, anthropic_version: version })),
  }
}

// Google's failures look like {"error": {"code", "message", "status"}}, sometimes in an array;
// clients expect Anthropic's error body. Errors Claude itself raised already have that shape.
export function error(status: number, body: Uint8Array) {
  const parsed = (() => {
    try {
      const value = JSON.parse(decoder.decode(body)) as unknown
      return (Array.isArray(value) ? value[0] : value) as Record<string, unknown> | undefined
    } catch {
      return undefined
    }
  })()
  if (parsed?.type === "error") return body
  const inner = parsed?.error as { message?: unknown } | undefined
  const message = typeof inner?.message === "string" ? inner.message : `Vertex AI answered ${status}`
  const type =
    status === 429
      ? "rate_limit_error"
      : status === 401
        ? "authentication_error"
        : status === 403
          ? "permission_error"
          : status === 404
            ? "not_found_error"
            : status < 500
              ? "invalid_request_error"
              : "api_error"
  return encoder.encode(JSON.stringify({ type: "error", error: { type, message } }))
}
