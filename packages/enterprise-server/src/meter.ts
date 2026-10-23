export * as Meter from "./meter"

import type { Pricing } from "./pricing"

// Reads token usage from upstream responses, whole JSON bodies or server-sent event streams, and
// normalizes it the way clients record it: input and output exclude cache and reasoning tokens.

// The APIs the gateway meters: Anthropic Messages, OpenAI Responses, (OpenAI-style) Chat Completions.
export type Api = "messages" | "responses" | "chat"

// `cost` is set when the upstream reports the call's price itself (OpenRouter does).
export type Usage = Pricing.Tokens & { readonly cost?: number }

type Totals = { input: number; output: number; reasoning: number; read: number; write: number; cost?: number }

const count = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined
const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined

// Anthropic reports input without cache tokens, and later stream events repeat counts cumulatively,
// so the last value seen for each count wins. Thinking tokens are part of output.
function messages(totals: Totals, usage: Record<string, unknown>) {
  totals.input = count(usage.input_tokens) ?? totals.input
  totals.output = count(usage.output_tokens) ?? totals.output
  totals.read = count(usage.cache_read_input_tokens) ?? totals.read
  totals.write = count(usage.cache_creation_input_tokens) ?? totals.write
}

function responses(totals: Totals, usage: Record<string, unknown>) {
  const read = count(record(usage.input_tokens_details)?.cached_tokens) ?? 0
  const reasoning = count(record(usage.output_tokens_details)?.reasoning_tokens) ?? 0
  totals.input = Math.max(0, (count(usage.input_tokens) ?? 0) - read)
  totals.read = read
  totals.write = 0
  totals.reasoning = reasoning
  totals.output = Math.max(0, (count(usage.output_tokens) ?? 0) - reasoning)
}

function chat(totals: Totals, usage: Record<string, unknown>) {
  const prompt = record(usage.prompt_tokens_details)
  const read = count(prompt?.cached_tokens) ?? count(usage.prompt_cache_hit_tokens) ?? 0
  const write = count(prompt?.cache_write_tokens) ?? 0
  const reasoning = count(record(usage.completion_tokens_details)?.reasoning_tokens) ?? 0
  totals.input = Math.max(0, (count(usage.prompt_tokens) ?? 0) - read - write)
  totals.read = read
  totals.write = write
  totals.reasoning = reasoning
  totals.output = Math.max(0, (count(usage.completion_tokens) ?? 0) - reasoning)
  totals.cost = count(usage.cost) ?? totals.cost
}

// Server-sent events are parsed incrementally as the stream is relayed. A line longer than this is
// not a usage event and is dropped rather than buffered without bound.
const longest = 8 * 1024 * 1024

export function make(api: Api) {
  const totals: Totals = { input: 0, output: 0, reasoning: 0, read: 0, write: 0 }
  let seen = false
  const decoder = new TextDecoder()
  let buffer = ""
  let data: string[] = []

  // One event, or a whole JSON body.
  const apply = (value: unknown) => {
    const payload = record(value)
    if (!payload) return
    const usage = (() => {
      if (api === "messages")
        return record(payload.type === "message_start" ? record(payload.message)?.usage : payload.usage)
      // Stream events wrap the response object ("response.completed"); a JSON body is the response itself.
      if (api === "responses")
        return record(String(payload.type).startsWith("response.") ? record(payload.response)?.usage : payload.usage)
      return record(payload.usage)
    })()
    if (!usage) return
    seen = true
    if (api === "messages") messages(totals, usage)
    else if (api === "responses") responses(totals, usage)
    else chat(totals, usage)
  }

  const dispatch = () => {
    const text = data.join("\n")
    data = []
    if (!text || text === "[DONE]") return
    try {
      apply(JSON.parse(text))
    } catch {
      // Not JSON; nothing to meter in it.
    }
  }

  const line = (raw: string) => {
    const value = raw.endsWith("\r") ? raw.slice(0, -1) : raw
    if (value === "") return dispatch()
    if (value.startsWith("data:")) data.push(value.slice(value.startsWith("data: ") ? 6 : 5))
  }

  return {
    // A chunk of an event stream, exactly as relayed to the client.
    feed(chunk: Uint8Array) {
      buffer += decoder.decode(chunk, { stream: true })
      let start = 0
      for (let index = buffer.indexOf("\n"); index !== -1; index = buffer.indexOf("\n", start)) {
        line(buffer.slice(start, index))
        start = index + 1
      }
      buffer = buffer.slice(start)
      if (buffer.length > longest) buffer = ""
    },
    json(body: unknown) {
      apply(body)
    },
    // Usage seen so far; undefined when the response carried none.
    end(): Usage | undefined {
      buffer += decoder.decode()
      if (buffer) line(buffer)
      buffer = ""
      dispatch()
      return seen ? { ...totals } : undefined
    },
  }
}
