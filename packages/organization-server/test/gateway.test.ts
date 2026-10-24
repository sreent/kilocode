import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Meter } from "../src/meter"
import { price } from "../src/pricing"
import { setup, type Env } from "./fixture"

// A stand-in for the providers: it records what the gateway sent and answers in each API's shape,
// streaming events in small, unaligned chunks so the gateway's parser sees split lines.

type Seen = { path: string; headers: Record<string, string>; body: Record<string, unknown> | undefined }

const events = {
  messages: [
    {
      type: "message_start",
      message: {
        id: "msg_1",
        model: "claude-sonnet-4",
        usage: { input_tokens: 100, cache_read_input_tokens: 20, cache_creation_input_tokens: 10, output_tokens: 1 },
      },
    },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 50 } },
    { type: "message_stop" },
  ],
  responses: [
    { type: "response.created", response: { id: "resp_1", usage: null } },
    { type: "response.output_text.delta", delta: "Hi" },
    {
      type: "response.completed",
      response: {
        id: "resp_1",
        usage: {
          input_tokens: 1000,
          input_tokens_details: { cached_tokens: 400 },
          output_tokens: 300,
          output_tokens_details: { reasoning_tokens: 200 },
        },
      },
    },
  ],
  chat: [
    { id: "c1", choices: [{ index: 0, delta: { content: "Hi" } }] },
    {
      id: "c1",
      choices: [],
      usage: { prompt_tokens: 500, completion_tokens: 100, prompt_tokens_details: { cached_tokens: 100 } },
    },
  ],
}

function sse(items: ReadonlyArray<Record<string, unknown>>, named: boolean, done: boolean) {
  const text =
    items.map((item) => `${named ? `event: ${item.type}\n` : ""}data: ${JSON.stringify(item)}\n\n`).join("") +
    (done ? "data: [DONE]\n\n" : "")
  const bytes = new TextEncoder().encode(text)
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      for (let at = 0; at < bytes.length; at += 7) {
        controller.enqueue(bytes.slice(at, at + 7))
        await Bun.sleep(0)
      }
      controller.close()
    },
  })
}

const upstream = (() => {
  const seen: Seen[] = []
  const state = { cancelled: false, reply: undefined as Response | undefined }
  const bun = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      const text = request.method === "POST" ? await request.text() : ""
      const body = text ? (JSON.parse(text) as Record<string, unknown>) : undefined
      seen.push({ path: `${url.pathname}${url.search}`, headers: Object.fromEntries(request.headers), body })
      if (state.reply) return state.reply.clone()
      const stream = body?.stream === true
      const headers = { "x-request-id": "req_upstream", "set-cookie": "tracker=1", "x-ratelimit-remaining": "99" }
      if (url.pathname === "/hang/v1/messages")
        // Sends the opening event, then waits for a client that goes away.
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(events.messages[0])}\n\n`))
            },
            cancel() {
              state.cancelled = true
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        )
      if (url.pathname.endsWith("/messages"))
        return stream
          ? new Response(sse(events.messages, true, false), {
              headers: { ...headers, "content-type": "text/event-stream" },
            })
          : Response.json({ id: "msg_1", type: "message", usage: { input_tokens: 10, output_tokens: 5 } }, { headers })
      if (url.pathname.endsWith("/responses"))
        return stream
          ? new Response(sse(events.responses, true, false), { headers: { "content-type": "text/event-stream" } })
          : Response.json({ id: "resp_1", object: "response", usage: events.responses[2].response!.usage })
      if (url.pathname.endsWith("/chat/completions"))
        return stream
          ? new Response(sse(events.chat, false, true), { headers: { "content-type": "text/event-stream" } })
          : Response.json({ id: "c1", usage: { prompt_tokens: 40, completion_tokens: 2, cost: 0.0123 } })
      if (url.pathname.endsWith("/models")) return Response.json({ data: [{ id: "claude-sonnet-4" }] })
      return new Response("not found", { status: 404 })
    },
  })
  return { url: `http://localhost:${bun.port}`, seen, state, stop: () => bun.stop(true) }
})()

afterAll(() => upstream.stop())

let env: Env
const keys = { anthropic: "sk-ant-org-key-000000000001", openai: "sk-org-openai-key-0000000002" }

async function provider(id: string, body: Record<string, unknown>, token = env.owner.token) {
  return env.call("PUT", `/api/v1/orgs/acme/gateway/providers/${id}`, { token, body })
}

beforeEach(async () => {
  env = await setup()
  upstream.seen.length = 0
  upstream.state.cancelled = false
  upstream.state.reply = undefined
  expect(
    (await provider("anthropic", { kind: "anthropic", base: `${upstream.url}/v1/`, key: keys.anthropic })).status,
  ).toBe(200)
  expect((await provider("openai", { kind: "openai", base: `${upstream.url}/v1`, key: keys.openai })).status).toBe(200)
  expect(
    (await provider("together", { kind: "openai-compatible", base: `${upstream.url}/v1`, key: "together-key" })).status,
  ).toBe(200)
})

afterEach(async () => {
  await env.runtime.dispose()
})

const relay = (route: string, init: { token?: string; body?: unknown; headers?: Record<string, string> } = {}) =>
  env.server.request(`/gateway/${route}`, {
    method: init.body === undefined ? "GET" : "POST",
    headers: {
      ...(init.token === undefined ? {} : { "x-api-key": init.token }),
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      ...init.headers,
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  })

const rows = async () =>
  (await env.store.usage.rows({ org: env.owner.org.id, from: 0, to: Date.now() + 60_000 })).filter(
    (row) => row.source === "gateway",
  )

// Recording happens as a stream ends, just after the client has read the last byte.
async function settle(count: number) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if ((await rows()).length >= count) return
    await Bun.sleep(10)
  }
}

describe("gateway administration", () => {
  test("lists providers with a key hint, never the key", async () => {
    const res = await env.call("GET", "/api/v1/orgs/acme/gateway", { token: env.owner.token })
    expect(res.status).toBe(200)
    expect(res.data.url).toBe("http://localhost:8787/gateway")
    expect(res.data.providers.map((row: { id: string }) => row.id)).toEqual(["anthropic", "openai", "together"])
    expect(res.data.providers[0]).toMatchObject({ kind: "anthropic", base: `${upstream.url}/v1`, hint: "0001" })
    expect(JSON.stringify(res.data)).not.toContain(keys.anthropic)
    // Too short for any characters to be shown safely.
    expect(res.data.providers[2].hint).toBe("")
  })

  test("requires a key for a new provider and keeps the current one on update", async () => {
    expect((await provider("groq", { kind: "openai-compatible", base: "https://api.groq.com/openai/v1" })).status).toBe(
      400,
    )
    const updated = await provider("anthropic", { kind: "anthropic", base: `${upstream.url}/v1` })
    expect(updated.status).toBe(200)
    expect(updated.data.hint).toBe("0001")
    await relay("anthropic/messages", { token: env.owner.token, body: { model: "claude-sonnet-4", max_tokens: 5 } })
    expect(upstream.seen.at(-1)?.headers["x-api-key"]).toBe(keys.anthropic)
  })

  test("only owners manage providers, admins can see them, members neither", async () => {
    const admin = await env.join("admin@acme.com", "admin")
    const member = await env.join("member@acme.com", "member")
    expect((await env.call("GET", "/api/v1/orgs/acme/gateway", { token: admin.token })).status).toBe(200)
    expect((await provider("openai", { kind: "openai", base: "https://api.openai.com/v1" }, admin.token)).status).toBe(
      403,
    )
    expect((await env.call("GET", "/api/v1/orgs/acme/gateway", { token: member.token })).status).toBe(403)
  })

  test("validates ids and upstream URLs", async () => {
    expect((await provider("Bad Id", { kind: "openai", base: "https://x.dev/v1", key: "k" })).status).toBe(400)
    expect((await provider("openai", { kind: "openai", base: "ftp://x.dev", key: "k" })).status).toBe(400)
    expect((await provider("openai", { kind: "bedrock", base: "https://x.dev", key: "k" })).status).toBe(400)
  })

  test("refuses to store keys without ORGANIZATION_SECRET", async () => {
    await env.runtime.dispose()
    env = await setup({ secret: undefined })
    const res = await provider("anthropic", { kind: "anthropic", base: "https://api.anthropic.com/v1", key: "k" })
    expect(res.status).toBe(400)
    expect(res.data.message).toContain("ORGANIZATION_SECRET")
  })

  test("audits changes without recording keys", async () => {
    await provider("anthropic", { kind: "anthropic", base: `${upstream.url}/v1`, key: "sk-ant-rotated-key-99999" })
    expect(
      (await env.call("DELETE", "/api/v1/orgs/acme/gateway/providers/together", { token: env.owner.token })).status,
    ).toBe(204)
    expect(
      (await env.call("DELETE", "/api/v1/orgs/acme/gateway/providers/together", { token: env.owner.token })).status,
    ).toBe(404)
    const audit = await env.call(
      "GET",
      "/api/v1/orgs/acme/audit?action=gateway.provider_create,gateway.provider_update,gateway.provider_remove",
      {
        token: env.owner.token,
      },
    )
    const actions = audit.data.events.map(
      (event: { action: string; target: string }) => `${event.action} ${event.target}`,
    )
    expect(actions).toEqual([
      "gateway.provider_remove together",
      "gateway.provider_update anthropic",
      "gateway.provider_create together",
      "gateway.provider_create openai",
      "gateway.provider_create anthropic",
    ])
    expect(audit.data.events[1].details).toMatchObject({ key_rotated: true })
    expect(JSON.stringify(audit.data)).not.toContain("sk-ant")
  })

  test("routes appear in the effective policy clients receive", async () => {
    const policy = await env.call("GET", "/api/v1/orgs/acme/policy/effective", { token: env.owner.token })
    expect(policy.data.gateway).toEqual({
      exclusive: false,
      providers: [
        { id: "anthropic", kind: "anthropic" },
        { id: "openai", kind: "openai" },
        { id: "together", kind: "openai-compatible" },
      ],
    })
  })
})

describe("gateway relay", () => {
  test("rejects calls without a valid organization token", async () => {
    const missing = await relay("anthropic/messages", { body: { model: "claude-sonnet-4" } })
    expect(missing.status).toBe(401)
    expect(await missing.json()).toMatchObject({ type: "error", error: { type: "authentication_error" } })
    expect((await relay("anthropic/messages", { token: "korg_nope", body: { model: "x" } })).status).toBe(401)
    const member = await env.join("gone@acme.com", "member")
    await env.store.user.update(member.user.id, { active: false })
    expect(
      (await relay("anthropic/messages", { token: member.token, body: { model: "claude-sonnet-4" } })).status,
    ).toBe(401)
    expect(upstream.seen).toHaveLength(0)
  })

  test("accepts the token in each SDK's key header", async () => {
    const body = JSON.stringify({ model: "gpt-5", input: "hi" })
    const variants: ReadonlyArray<Record<string, string>> = [
      { authorization: `Bearer ${env.owner.token}` },
      { "api-key": env.owner.token },
      { "x-goog-api-key": env.owner.token },
    ]
    for (const headers of variants) {
      const res = await env.server.request("/gateway/openai/responses", {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body,
      })
      expect(res.status).toBe(200)
    }
  })

  test("swaps in the org key and relays only safe headers", async () => {
    const res = await relay("anthropic/messages", {
      token: env.owner.token,
      body: { model: "claude-sonnet-4", max_tokens: 5 },
      headers: { "anthropic-version": "2023-06-01", cookie: "session=1", "x-org-session": "ses_1" },
    })
    expect(res.status).toBe(200)
    const sent = upstream.seen.at(-1)!
    expect(sent.path).toBe("/v1/messages")
    expect(sent.headers["x-api-key"]).toBe(keys.anthropic)
    expect(sent.headers["anthropic-version"]).toBe("2023-06-01")
    expect(sent.headers.authorization).toBeUndefined()
    expect(sent.headers.cookie).toBeUndefined()
    expect(sent.headers["x-org-session"]).toBeUndefined()
    expect(res.headers.get("x-request-id")).toBe("req_upstream")
    expect(res.headers.get("x-ratelimit-remaining")).toBe("99")
    expect(res.headers.get("set-cookie")).toBeNull()

    await relay("openai/responses", { token: env.owner.token, body: { model: "gpt-5", input: "hi" } })
    expect(upstream.seen.at(-1)!.headers.authorization).toBe(`Bearer ${keys.openai}`)
    expect(upstream.seen.at(-1)!.headers["x-api-key"]).toBeUndefined()
  })

  test("meters a JSON response and records who made the call", async () => {
    const res = await relay("anthropic/messages", {
      token: env.owner.token,
      body: { model: "claude-sonnet-4", max_tokens: 5 },
      headers: { "x-org-session": "ses_1", "x-org-project": "billing-api" },
    })
    expect(await res.json()).toMatchObject({ id: "msg_1" })
    const [row] = await rows()
    expect(row).toMatchObject({
      email: "owner@acme.com",
      provider: "anthropic",
      model: "claude-sonnet-4",
      session: "ses_1",
      project: "billing-api",
      input: 10,
      output: 5,
      source: "gateway",
    })
    expect(row!.cost).toBeCloseTo((10 * 3 + 5 * 15) / 1e6, 12)
  })

  test("relays an Anthropic event stream untouched and meters it", async () => {
    const res = await relay("anthropic/messages", {
      token: env.owner.token,
      body: { model: "claude-sonnet-4", max_tokens: 5, stream: true },
    })
    expect(res.headers.get("content-type")).toContain("text/event-stream")
    const text = await res.text()
    expect(text).toBe(await new Response(sse(events.messages, true, false)).text())
    await settle(1)
    const [row] = await rows()
    expect(row).toMatchObject({ input: 100, output: 50, cache_read: 20, cache_write: 10, reasoning: 0 })
    expect(row!.cost).toBeCloseTo((100 * 3 + 50 * 15 + 20 * 0.3 + 10 * 3.75) / 1e6, 12)
  })

  test("meters OpenAI Responses streams, separating cached and reasoning tokens", async () => {
    const res = await relay("openai/responses", { token: env.owner.token, body: { model: "gpt-5", stream: true } })
    await res.text()
    await settle(1)
    const [row] = await rows()
    expect(row).toMatchObject({ input: 600, cache_read: 400, output: 100, reasoning: 200 })
    expect(row!.cost).toBeCloseTo((600 * 1.25 + 300 * 10 + 400 * 0.125) / 1e6, 12)
  })

  test("asks streamed chat completions for usage and meters them", async () => {
    const res = await relay("together/chat/completions", {
      token: env.owner.token,
      body: { model: "llama-4", stream: true, messages: [] },
    })
    expect(await res.text()).toContain("data: [DONE]")
    expect(upstream.seen.at(-1)!.body).toMatchObject({ stream_options: { include_usage: true }, messages: [] })
    await settle(1)
    const [row] = await rows()
    expect(row).toMatchObject({ provider: "together", input: 400, cache_read: 100, output: 100 })
    expect(row!.cost).toBeCloseTo((400 * 0.2 + 100 * 0.6) / 1e6, 12)
  })

  test("uses a price the upstream reports itself", async () => {
    await relay("together/chat/completions", { token: env.owner.token, body: { model: "unpriced", messages: [] } })
    const [row] = await rows()
    expect(row).toMatchObject({ model: "unpriced", input: 40, output: 2, cost: 0.0123 })
  })

  test("refuses models the member's policy does not allow, before calling upstream", async () => {
    await env.call("PUT", "/api/v1/orgs/acme/policy", {
      token: env.owner.token,
      body: { models: { blocked: ["anthropic/claude-opus-*"] } },
    })
    const res = await relay("anthropic/messages", { token: env.owner.token, body: { model: "claude-opus-4" } })
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ error: { type: "permission_error", code: "model_not_allowed" } })
    expect(upstream.seen).toHaveLength(0)
  })

  test("refuses calls once a budget is spent", async () => {
    await env.call("PUT", "/api/v1/orgs/acme/budgets", {
      token: env.owner.token,
      body: { budgets: [{ scope: "org", period: "month", amount: 0 }] },
    })
    const res = await relay("anthropic/messages", { token: env.owner.token, body: { model: "claude-sonnet-4" } })
    expect(res.status).toBe(402)
    const body = await res.json()
    expect(body.error.code).toBe("budget_exceeded")
    expect(body.error.message).toContain("monthly organization AI budget")
    // Listing models costs nothing, so it stays available.
    expect((await relay("anthropic/models", { token: env.owner.token })).status).toBe(200)
    expect(upstream.seen).toHaveLength(1)
  })

  test("relays only the endpoints each API needs", async () => {
    expect((await relay("anthropic/complete", { token: env.owner.token, body: { model: "x" } })).status).toBe(404)
    expect((await relay("together/responses", { token: env.owner.token, body: { model: "x" } })).status).toBe(404)
    expect((await relay("openai/files", { token: env.owner.token })).status).toBe(404)
    expect((await relay("mistral/chat/completions", { token: env.owner.token, body: { model: "x" } })).status).toBe(404)
    expect(upstream.seen).toHaveLength(0)
  })

  test("rejects bodies without a model", async () => {
    const res = await env.server.request("/gateway/anthropic/messages", {
      method: "POST",
      headers: { "x-api-key": env.owner.token, "content-type": "application/json" },
      body: "not json",
    })
    expect(res.status).toBe(400)
    expect((await relay("anthropic/messages", { token: env.owner.token, body: { max_tokens: 5 } })).status).toBe(400)
  })

  test("relays upstream errors as they are and meters nothing", async () => {
    upstream.state.reply = Response.json(
      { type: "error", error: { type: "rate_limit_error", message: "slow down" } },
      { status: 429, headers: { "retry-after": "7" } },
    )
    const res = await relay("anthropic/messages", { token: env.owner.token, body: { model: "claude-sonnet-4" } })
    expect(res.status).toBe(429)
    expect(res.headers.get("retry-after")).toBe("7")
    expect(await res.json()).toMatchObject({ error: { message: "slow down" } })
    expect(await rows()).toHaveLength(0)
  })

  test("answers 502 when the upstream cannot be reached", async () => {
    await provider("anthropic", { kind: "anthropic", base: "http://127.0.0.1:9/v1" })
    const res = await relay("anthropic/messages", { token: env.owner.token, body: { model: "claude-sonnet-4" } })
    expect(res.status).toBe(502)
    expect(await res.json()).toMatchObject({ error: { type: "api_error", code: "upstream_unreachable" } })
  })

  test("a key sealed under another ORGANIZATION_SECRET asks for the key again instead of failing obscurely", async () => {
    await env.exec(
      `update gateway_providers set secret = 'v1.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA' where id = 'anthropic'`,
    )
    const res = await relay("anthropic/messages", { token: env.owner.token, body: { model: "claude-sonnet-4" } })
    expect(res.status).toBe(503)
    expect((await res.json()).error.message).toContain("needs to enter them again")
    expect(upstream.seen).toHaveLength(0)
  })

  test("a client that hangs up stops the upstream call and is still metered", async () => {
    await provider("anthropic", { kind: "anthropic", base: `${upstream.url}/hang/v1` })
    const res = await relay("anthropic/messages", {
      token: env.owner.token,
      body: { model: "claude-sonnet-4", stream: true },
    })
    const reader = res.body!.getReader()
    await reader.read()
    await reader.cancel()
    for (let attempt = 0; attempt < 100 && !upstream.state.cancelled; attempt++) await Bun.sleep(10)
    expect(upstream.state.cancelled).toBe(true)
    await settle(1)
    expect(await rows()).toMatchObject([{ input: 100, output: 1 }])
  })
})

describe("gateway accounting", () => {
  test("client reports for gateway providers are dropped, so calls count once", async () => {
    const res = await env.call("POST", "/api/v1/orgs/acme/usage", {
      token: env.owner.token,
      body: {
        records: [
          { id: "a", at: Date.now(), provider: "anthropic", model: "claude-sonnet-4", cost: 1 },
          { id: "b", at: Date.now(), provider: "kilo", model: "auto", cost: 2 },
        ],
      },
    })
    expect(res.data.accepted).toBe(1)
    await relay("anthropic/messages", { token: env.owner.token, body: { model: "claude-sonnet-4", max_tokens: 5 } })
    const summary = await env.call("GET", "/api/v1/orgs/acme/usage?by=source", { token: env.owner.token })
    expect(summary.data.rows.map((row: { key: string; requests: number }) => [row.key, row.requests])).toEqual([
      ["client", 1],
      ["gateway", 1],
    ])
  })

  test("an exclusive gateway is part of the policy clients enforce", async () => {
    await env.call("PUT", "/api/v1/orgs/acme/policy", {
      token: env.owner.token,
      body: { gateway: { exclusive: true } },
    })
    const policy = await env.call("GET", "/api/v1/orgs/acme/policy/effective", { token: env.owner.token })
    expect(policy.data.gateway.exclusive).toBe(true)
  })
})

describe("metering", () => {
  test("parses events split across chunks and lines ending in CRLF", () => {
    const meter = Meter.make("chat")
    const text = `data: ${JSON.stringify({ usage: { prompt_tokens: 7, completion_tokens: 3 } })}\r\n\r\ndata: [DONE]\r\n\r\n`
    const bytes = new TextEncoder().encode(text)
    for (let at = 0; at < bytes.length; at += 3) meter.feed(bytes.slice(at, at + 3))
    expect(meter.end()).toEqual({ input: 7, output: 3, reasoning: 0, read: 0, write: 0 })
  })

  test("reports nothing when a response carries no usage", () => {
    const meter = Meter.make("messages")
    meter.feed(new TextEncoder().encode('event: ping\ndata: {"type":"ping"}\n\n'))
    expect(meter.end()).toBeUndefined()
  })

  test("prices long prompts at the context tier, like clients do", () => {
    const cost = {
      input: 3,
      output: 15,
      cache_read: 0.3,
      context_over_200k: { input: 6, output: 22.5, cache_read: 0.6 },
    }
    expect(price(cost, { input: 1000, output: 100, reasoning: 0, read: 0, write: 0 })).toBeCloseTo(0.0045, 12)
    expect(price(cost, { input: 150_000, output: 100, reasoning: 0, read: 60_000, write: 0 })).toBeCloseTo(
      (150_000 * 6 + 100 * 22.5 + 60_000 * 0.6) / 1e6,
      12,
    )
    expect(price(undefined, { input: 1, output: 1, reasoning: 0, read: 0, write: 0 })).toBe(0)
  })
})
