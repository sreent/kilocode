import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Sha256 } from "@aws-crypto/sha256-js"
import { EventStreamCodec } from "@smithy/eventstream-codec"
import { SignatureV4 } from "@smithy/signature-v4"
import { fromUtf8, toUtf8 } from "@smithy/util-utf8"
import { EventStream } from "../src/eventstream"
import { setup, type Env } from "./fixture"

// The gateway's other upstreams: OpenAI-compatible gateways such as LiteLLM, with their own headers
// and model lists; Claude on Amazon Bedrock and Google Vertex AI; and the org's own prices, rate
// limits and call log. The stand-in upstreams check what the gateway sends: Bedrock's signatures
// against AWS's own SDK, Vertex's access tokens against a service account key made here.

const aws = { access: "AKIAIOSFODNN7EXAMPLE", secret: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", region: "us-east-1" }
const bedrockModel = "us.anthropic.claude-sonnet-4-5-20250929-v1:0"

const codec = new EventStreamCodec(toUtf8, fromUtf8)
const chunk = (event: Record<string, unknown>) =>
  codec.encode({
    headers: {
      ":message-type": { type: "string", value: "event" },
      ":event-type": { type: "string", value: "chunk" },
      ":content-type": { type: "string", value: "application/json" },
    },
    body: fromUtf8(JSON.stringify({ bytes: Buffer.from(JSON.stringify(event)).toString("base64"), p: "abcdefgh" })),
  })
const exception = (name: string, message: string) =>
  codec.encode({
    headers: {
      ":message-type": { type: "string", value: "exception" },
      ":exception-type": { type: "string", value: name },
    },
    body: fromUtf8(JSON.stringify({ message })),
  })

const claude = [
  {
    type: "message_start",
    message: { id: "msg_b", model: "claude", usage: { input_tokens: 200, output_tokens: 1 } },
  },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi" } },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 30 } },
  { type: "message_stop" },
]

// Bytes in odd-sized pieces, so frames and lines arrive split.
function pieces(bytes: Uint8Array, size = 7) {
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      for (let at = 0; at < bytes.length; at += size) {
        controller.enqueue(bytes.slice(at, at + size))
        await Bun.sleep(0)
      }
      controller.close()
    },
  })
}

const join = (parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0))
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

// A service account made for the test, and the public half that checks its assertions.
const keys = (await crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  true,
  ["sign", "verify"],
)) as CryptoKeyPair
const pem = `-----BEGIN PRIVATE KEY-----\n${Buffer.from(await crypto.subtle.exportKey("pkcs8", keys.privateKey))
  .toString("base64")
  .replace(/(.{64})/g, "$1\n")}\n-----END PRIVATE KEY-----\n`

type Seen = { path: string; headers: Record<string, string>; body: string }

const upstream = (() => {
  const seen: Seen[] = []
  const state = { exchanges: 0, verified: [] as boolean[], failBedrock: false }
  const signer = new SignatureV4({
    credentials: { accessKeyId: aws.access, secretAccessKey: aws.secret },
    region: aws.region,
    service: "bedrock",
    sha256: Sha256,
    // Bedrock doesn't take the payload hash as a header; only S3 needs it.
    applyChecksum: false,
  })
  const bun = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      const body = request.method === "POST" ? await request.text() : ""
      const headers = Object.fromEntries(request.headers)
      seen.push({ path: `${url.pathname}${url.search}`, headers, body })

      if (url.pathname === "/google/token") {
        state.exchanges++
        const form = new URLSearchParams(body)
        const [header, claims, signature] = (form.get("assertion") ?? "").split(".")
        const valid = await crypto.subtle.verify(
          "RSASSA-PKCS1-v1_5",
          keys.publicKey,
          Buffer.from(signature!, "base64url"),
          new TextEncoder().encode(`${header}.${claims}`),
        )
        const payload = JSON.parse(Buffer.from(claims!, "base64url").toString())
        if (
          !valid ||
          form.get("grant_type") !== "urn:ietf:params:oauth:grant-type:jwt-bearer" ||
          payload.iss !== "gateway@acme-ai.iam.gserviceaccount.com" ||
          payload.scope !== "https://www.googleapis.com/auth/cloud-platform" ||
          payload.aud !== `${url.origin}/google/token`
        )
          return Response.json({ error: "invalid_grant" }, { status: 400 })
        return Response.json({ access_token: "ya29.test-token", expires_in: 3600, token_type: "Bearer" })
      }

      if (url.pathname.startsWith("/bedrock/") && headers.authorization === "Bearer bedrock-api-key")
        return Response.json({ id: "msg_b", type: "message", usage: { input_tokens: 1, output_tokens: 1 } })
      if (url.pathname.startsWith("/bedrock/")) {
        // Recomputes the signature with AWS's own SDK, over the headers the gateway signed.
        const auth = headers.authorization ?? ""
        const signed = auth.match(/SignedHeaders=([^,]+)/)?.[1]?.split(";") ?? []
        const amz = headers["x-amz-date"] ?? ""
        const expected = await signer.sign(
          {
            method: request.method,
            protocol: url.protocol,
            hostname: url.hostname,
            port: Number(url.port),
            path: url.pathname,
            query: Object.fromEntries(url.searchParams),
            headers: Object.fromEntries(signed.map((name) => [name, name === "host" ? url.host : headers[name]!])),
            body,
          },
          {
            signingDate: new Date(
              `${amz.slice(0, 4)}-${amz.slice(4, 6)}-${amz.slice(6, 8)}T${amz.slice(9, 11)}:${amz.slice(11, 13)}:${amz.slice(13, 15)}Z`,
            ),
          },
        )
        const ok =
          auth.startsWith(`AWS4-HMAC-SHA256 Credential=${aws.access}/`) &&
          auth.split("Signature=")[1] === String(expected.headers.authorization).split("Signature=")[1]
        state.verified.push(ok)
        if (!ok)
          console.error("signature mismatch", { received: auth, expected: expected.headers.authorization, signed })
        if (!ok)
          return Response.json({ message: "The request signature we calculated does not match" }, { status: 403 })
        if (state.failBedrock)
          return Response.json(
            { message: "The provided model identifier is invalid." },
            { status: 400, headers: { "x-amzn-errortype": "ValidationException" } },
          )
        if (url.pathname.endsWith("/invoke-with-response-stream"))
          return new Response(
            pieces(
              join([...claude.slice(0, 2).map(chunk), exception("throttlingException", "Too many tokens, slow down")]),
            ),
            { headers: { "content-type": "application/vnd.amazon.eventstream", "x-amzn-requestid": "aws-1" } },
          )
        if (url.pathname.endsWith("/invoke"))
          return Response.json({
            id: "msg_b",
            type: "message",
            content: [{ type: "text", text: "Hi" }],
            usage: { input_tokens: 120, output_tokens: 8 },
          })
      }

      if (url.pathname.startsWith("/vertex/")) {
        if (headers.authorization !== "Bearer ya29.test-token")
          return Response.json(
            {
              error: {
                code: 401,
                message: "Request had invalid authentication credentials.",
                status: "UNAUTHENTICATED",
              },
            },
            { status: 401 },
          )
        if (url.pathname.endsWith(":streamRawPredict"))
          return new Response(
            pieces(
              new TextEncoder().encode(
                claude.map((item) => `event: ${item.type}\ndata: ${JSON.stringify(item)}\n\n`).join(""),
              ),
            ),
            { headers: { "content-type": "text/event-stream" } },
          )
        if (url.pathname.endsWith("count-tokens:rawPredict")) return Response.json({ input_tokens: 17 })
        if (url.pathname.endsWith(":rawPredict"))
          return Response.json(
            [{ error: { code: 404, message: "Publisher model was not found.", status: "NOT_FOUND" } }],
            { status: 404 },
          )
      }

      if (url.pathname.startsWith("/litellm/")) {
        if (headers.authorization !== "Bearer sk-litellm-virtual-key" || headers["x-team"] !== "platform")
          return Response.json({ error: { message: "Authentication Error" } }, { status: 401 })
        if (url.pathname.endsWith("/models"))
          return Response.json({ data: [{ id: "gpt-4o-mini" }, { id: "claude-sonnet", object: "model" }] })
        if (url.pathname.endsWith("/chat/completions"))
          return Response.json(
            { id: "c1", usage: { prompt_tokens: 1000, completion_tokens: 200 } },
            { headers: { "x-litellm-response-cost": "0.042" } },
          )
      }

      if (url.pathname.startsWith("/azure/openai/v1/")) {
        if (headers["api-key"] !== "azure-key-0000000000000000") return new Response("unauthorized", { status: 401 })
        return Response.json({ id: "resp", usage: { input_tokens: 10, output_tokens: 10 } })
      }

      if (url.pathname.startsWith("/open/"))
        return Response.json({ id: "c1", usage: { prompt_tokens: 40, completion_tokens: 2 } })
      return new Response("not found", { status: 404 })
    },
  })
  return { url: `http://localhost:${bun.port}`, seen, state, stop: () => bun.stop(true) }
})()

afterAll(() => upstream.stop())

const account = () =>
  JSON.stringify({
    type: "service_account",
    project_id: "acme-ai",
    client_email: "gateway@acme-ai.iam.gserviceaccount.com",
    private_key: pem,
    token_uri: `${upstream.url}/google/token`,
  })

let env: Env

const provider = (id: string, body: Record<string, unknown>, token = env.owner.token) =>
  env.call("PUT", `/api/v1/orgs/acme/gateway/providers/${id}`, { token, body })

const relay = (route: string, init: { token?: string; body?: unknown; headers?: Record<string, string> } = {}) =>
  env.server.request(`/gateway/${route}`, {
    method: init.body === undefined ? "GET" : "POST",
    headers: {
      "x-api-key": init.token ?? env.owner.token,
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      ...init.headers,
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  })

const usage = async () =>
  (await env.store.usage.rows({ org: env.owner.org.id, from: 0, to: Date.now() + 60_000 })).filter(
    (row) => row.source === "gateway",
  )

// Usage and the call log are written as a stream ends, just after the client read its last byte.
async function until(check: () => Promise<boolean>) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (await check()) return
    await Bun.sleep(10)
  }
  throw new Error("timed out")
}

const calls = async (query = "") =>
  (await env.call("GET", `/api/v1/orgs/acme/gateway/calls${query}`, { token: env.owner.token })).data.calls as Array<{
    id: number
    provider: string
    model: string | null
    status: number
    code: string | null
    cost: number
    tokens: { input: number; output: number }
    user: { email: string } | null
    bodies: boolean
  }>

async function policy(gateway: Record<string, unknown>) {
  const current = (await env.call("GET", "/api/v1/orgs/acme/policy", { token: env.owner.token })).data.policy
  const res = await env.call("PUT", "/api/v1/orgs/acme/policy", {
    token: env.owner.token,
    body: { ...current, gateway: { ...current.gateway, ...gateway } },
  })
  expect(res.status).toBe(200)
}

beforeEach(async () => {
  env = await setup()
  upstream.seen.length = 0
  upstream.state.verified.length = 0
  upstream.state.failBedrock = false
})

afterEach(async () => {
  await env.runtime.dispose()
})

describe("event stream decoding", () => {
  test("frames split anywhere decode to the messages AWS's own encoder wrote", () => {
    const bytes = join([chunk(claude[0]!), exception("throttlingException", "slow down")])
    for (const size of [1, 5, 12, 13, bytes.length]) {
      const decode = EventStream.decoder()
      const messages = []
      for (let at = 0; at < bytes.length; at += size) messages.push(...decode(bytes.slice(at, at + size)))
      expect(messages.map((message) => message.headers[":message-type"])).toEqual(["event", "exception"])
      expect(JSON.parse(new TextDecoder().decode(messages[1]!.payload))).toEqual({ message: "slow down" })
    }
  })

  test("a corrupted frame is an error, not garbage", () => {
    const bytes = chunk(claude[0]!)
    bytes[20] = bytes[20]! ^ 0xff
    expect(() => EventStream.decoder()(bytes)).toThrow(/checksum/)
  })
})

describe("OpenAI-compatible gateways such as LiteLLM", () => {
  const litellm = () =>
    provider("litellm", {
      kind: "openai-compatible",
      base: `${upstream.url}/litellm/v1`,
      key: "sk-litellm-virtual-key",
      headers: { "X-Team": "platform" },
      name: "LiteLLM",
      models: [
        { id: "claude-sonnet", name: "Claude Sonnet (LiteLLM)", context: 200000, output: 64000, reasoning: true },
        { id: "gpt-4o-mini", cost: { input: 0.15, output: 0.6 } },
      ],
    })

  test("relays with the extra headers, and charges what the upstream reports", async () => {
    expect((await litellm()).status).toBe(200)
    const res = await relay("litellm/chat/completions", { body: { model: "claude-sonnet", messages: [] } })
    expect(res.status).toBe(200)
    const sent = upstream.seen.at(-1)!
    expect(sent.path).toBe("/litellm/v1/chat/completions")
    expect(sent.headers["x-team"]).toBe("platform")
    expect(sent.headers.authorization).toBe("Bearer sk-litellm-virtual-key")
    // The client's own credential never leaves the server.
    expect(JSON.stringify(sent.headers)).not.toContain(env.owner.token)
    const [row] = await usage()
    expect(row).toMatchObject({ provider: "litellm", model: "claude-sonnet", input: 1000, output: 200, cost: 0.042 })
  })

  test("a model with no reported cost is priced from the provider's own model list", async () => {
    await litellm()
    // The same upstream, without LiteLLM's cost header.
    await provider("open", {
      kind: "openai-compatible",
      base: `${upstream.url}/open/v1`,
      auth: { type: "none" },
      models: [{ id: "gpt-4o-mini", cost: { input: 0.15, output: 0.6 } }],
    })
    await relay("open/chat/completions", { body: { model: "gpt-4o-mini", messages: [] } })
    const [row] = await usage()
    expect(row!.cost).toBeCloseTo((40 * 0.15 + 2 * 0.6) / 1e6, 12)
    // No credential was configured, so none is sent.
    expect(upstream.seen.at(-1)!.headers.authorization).toBeUndefined()
  })

  test("clients receive the provider's name and models, never its headers", async () => {
    await litellm()
    const listed = await env.call("GET", "/api/v1/orgs/acme/gateway", { token: env.owner.token })
    expect(listed.data.providers[0]).toMatchObject({
      id: "litellm",
      auth: { type: "bearer" },
      headers: ["x-team"],
      hint: "-key",
      name: "LiteLLM",
    })
    expect(JSON.stringify(listed.data)).not.toContain("platform")
    const effective = await env.call("GET", "/api/v1/orgs/acme/policy/effective", { token: env.owner.token })
    expect(effective.data.gateway.providers).toEqual([
      {
        id: "litellm",
        kind: "openai-compatible",
        name: "LiteLLM",
        models: [
          { id: "claude-sonnet", name: "Claude Sonnet (LiteLLM)", context: 200000, output: 64000, reasoning: true },
          { id: "gpt-4o-mini", cost: { input: 0.15, output: 0.6 } },
        ],
      },
    ])
  })

  test("models can be imported from the upstream's own list", async () => {
    await litellm()
    const res = await env.call("POST", "/api/v1/orgs/acme/gateway/providers/litellm/discover", {
      token: env.owner.token,
    })
    expect(res.status).toBe(200)
    expect(res.data.models).toEqual([{ id: "claude-sonnet" }, { id: "gpt-4o-mini" }])
    // Extra headers are kept when an update leaves them out, and replaced when it gives them.
    await provider("litellm", { kind: "openai-compatible", base: `${upstream.url}/litellm/v1`, headers: {} })
    const failed = await env.call("POST", "/api/v1/orgs/acme/gateway/providers/litellm/discover", {
      token: env.owner.token,
    })
    expect(failed.status).toBe(400)
    expect(failed.data.message).toContain("401")
  })

  test("Azure OpenAI takes its key in api-key and an api-version on every call", async () => {
    const res = await provider("azure-openai", {
      kind: "openai",
      base: `${upstream.url}/azure/openai/v1`,
      auth: { type: "header", name: "api-key" },
      key: "azure-key-0000000000000000",
      query: { "api-version": "preview" },
      models: [{ id: "gpt-5-deployment" }],
    })
    expect(res.status).toBe(200)
    expect((await relay("azure-openai/responses", { body: { model: "gpt-5-deployment", input: "hi" } })).status).toBe(
      200,
    )
    expect(upstream.seen.at(-1)!.path).toBe("/azure/openai/v1/responses?api-version=preview")
    // azure is the client's own Azure SDK provider; a gateway-defined one needs another id.
    const reserved = await provider("azure", {
      kind: "openai",
      base: `${upstream.url}/azure/openai/v1`,
      key: "k",
      models: [{ id: "x" }],
    })
    expect(reserved.status).toBe(400)
  })

  test("framing headers can't be set, and a changed credential type needs its secret", async () => {
    const bad = await provider("x", {
      kind: "openai-compatible",
      base: "https://x.dev/v1",
      key: "k",
      headers: { "content-length": "0" },
    })
    expect(bad.status).toBe(400)
    await litellm()
    // The same API key, sent in another header: no new key needed.
    const switched = await provider("litellm", {
      kind: "openai-compatible",
      base: `${upstream.url}/litellm/v1`,
      auth: { type: "header", name: "x-api-key" },
    })
    expect(switched.status).toBe(200)
    expect(switched.data).toMatchObject({ auth: { type: "header", name: "x-api-key" }, hint: "-key" })
    // A service account is another kind of credential, and needs its key.
    const google = await provider("litellm", {
      kind: "openai-compatible",
      base: `${upstream.url}/litellm/v1`,
      auth: { type: "google" },
    })
    expect(google.status).toBe(400)
  })
})

describe("Claude on Amazon Bedrock", () => {
  const bedrock = (
    auth: Record<string, unknown> = { type: "aws", region: aws.region, access_key: aws.access },
    key = aws.secret,
  ) =>
    provider("bedrock-claude", {
      kind: "bedrock",
      base: `${upstream.url}/bedrock`,
      auth,
      key,
      name: "Claude on Bedrock",
      models: [
        { id: bedrockModel, name: "Claude Sonnet 4.5", context: 200000, output: 64000, cost: { input: 3, output: 15 } },
      ],
    })

  test("a Messages request becomes a Bedrock call signed with SigV4, and the answer comes back as Anthropic's", async () => {
    const created = await bedrock()
    expect(created.status).toBe(200)
    expect(created.data).toMatchObject({ auth: { type: "aws", access_key: aws.access }, hint: "MPLE" })
    expect(JSON.stringify(created.data)).not.toContain(aws.secret)
    const res = await relay("bedrock-claude/messages", {
      body: { model: bedrockModel, max_tokens: 100, messages: [{ role: "user", content: "hi" }] },
      headers: { "anthropic-beta": "context-1m-2025-08-07", "anthropic-version": "2023-06-01" },
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ id: "msg_b", content: [{ text: "Hi" }] })
    expect(upstream.state.verified).toEqual([true])
    const sent = upstream.seen.at(-1)!
    expect(sent.path).toBe(`/bedrock/model/${encodeURIComponent(bedrockModel)}/invoke`)
    // The model moves to the path, the version and beta flags into the body.
    expect(JSON.parse(sent.body)).toEqual({
      max_tokens: 100,
      messages: [{ role: "user", content: "hi" }],
      anthropic_version: "bedrock-2023-05-31",
      anthropic_beta: ["context-1m-2025-08-07"],
    })
    expect(sent.headers["anthropic-beta"]).toBeUndefined()
    const [row] = await usage()
    expect(row).toMatchObject({ provider: "bedrock-claude", model: bedrockModel, input: 120, output: 8 })
    expect(row!.cost).toBeCloseTo((120 * 3 + 8 * 15) / 1e6, 12)
  })

  test("Bedrock's event stream is relayed as Anthropic's server-sent events, errors included", async () => {
    await bedrock()
    const res = await relay("bedrock-claude/messages", {
      body: { model: bedrockModel, max_tokens: 100, stream: true, messages: [] },
    })
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toBe("text/event-stream")
    const text = await res.text()
    expect(text).toBe(
      [
        `event: message_start\ndata: ${JSON.stringify(claude[0])}\n\n`,
        `event: content_block_delta\ndata: ${JSON.stringify(claude[1])}\n\n`,
        `event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "Too many tokens, slow down" } })}\n\n`,
      ].join(""),
    )
    expect(upstream.seen.at(-1)!.path).toBe(
      `/bedrock/model/${encodeURIComponent(bedrockModel)}/invoke-with-response-stream`,
    )
    expect(upstream.seen.at(-1)!.headers.accept).toBe("application/vnd.amazon.eventstream")
    await until(async () => (await usage()).length === 1)
    expect((await usage())[0]).toMatchObject({ input: 200, output: 1 })
  })

  test("Bedrock's failures reach clients as Anthropic errors", async () => {
    await bedrock()
    upstream.state.failBedrock = true
    const res = await relay("bedrock-claude/messages", { body: { model: bedrockModel, max_tokens: 1, messages: [] } })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({
      type: "error",
      error: { type: "invalid_request_error", message: "The provided model identifier is invalid." },
    })
  })

  test("a Bedrock API key works in place of an access key", async () => {
    expect((await bedrock({ type: "bearer" }, "bedrock-api-key")).status).toBe(200)
    expect(
      (await relay("bedrock-claude/messages", { body: { model: bedrockModel, max_tokens: 1, messages: [] } })).status,
    ).toBe(200)
    expect(upstream.seen.at(-1)!.headers.authorization).toBe("Bearer bedrock-api-key")
  })

  test("its models are listed from the configured list, and it needs one", async () => {
    await bedrock()
    const models = await relay("bedrock-claude/models")
    expect(await models.json()).toEqual({
      data: [{ type: "model", id: bedrockModel, display_name: "Claude Sonnet 4.5" }],
      has_more: false,
      first_id: bedrockModel,
      last_id: bedrockModel,
    })
    const effective = await env.call("GET", "/api/v1/orgs/acme/policy/effective", { token: env.owner.token })
    // Clients speak Anthropic's API to it.
    expect(effective.data.gateway.providers[0]).toMatchObject({
      id: "bedrock-claude",
      kind: "anthropic",
      name: "Claude on Bedrock",
    })
    const empty = await provider("bedrock-2", {
      kind: "bedrock",
      base: `${upstream.url}/bedrock`,
      auth: { type: "aws", region: aws.region, access_key: aws.access },
      key: aws.secret,
    })
    expect(empty.status).toBe(400)
    const vertexKey = await provider("bedrock-3", {
      kind: "bedrock",
      base: `${upstream.url}/bedrock`,
      auth: { type: "google" },
      key: account(),
      models: [{ id: "x" }],
    })
    expect(vertexKey.status).toBe(400)
  })
})

describe("Claude on Google Vertex AI", () => {
  const vertex = (key = account()) =>
    provider("vertex-claude", {
      kind: "vertex",
      base: `${upstream.url}/vertex/v1/projects/acme-ai/locations/us-east5`,
      key,
      models: [{ id: "claude-sonnet-4-5@20250929" }],
    })

  test("calls go out with an access token from the service account, exchanged once and reused", async () => {
    const created = await vertex()
    expect(created.status).toBe(200)
    expect(created.data).toMatchObject({ auth: { type: "google" }, hint: "gateway@acme-ai.iam.gserviceaccount.com" })
    expect(JSON.stringify(created.data)).not.toContain("PRIVATE KEY")
    for (let i = 0; i < 2; i++) {
      const res = await relay("vertex-claude/messages", {
        body: { model: "claude-sonnet-4-5@20250929", max_tokens: 10, stream: true, messages: [] },
        headers: { "anthropic-beta": "context-1m-2025-08-07" },
      })
      expect(res.status).toBe(200)
      expect(await res.text()).toContain("event: message_stop")
    }
    expect(upstream.state.exchanges).toBe(1)
    const sent = upstream.seen.at(-1)!
    expect(sent.path).toBe(
      "/vertex/v1/projects/acme-ai/locations/us-east5/publishers/anthropic/models/claude-sonnet-4-5@20250929:streamRawPredict",
    )
    expect(JSON.parse(sent.body)).toEqual({
      max_tokens: 10,
      stream: true,
      messages: [],
      anthropic_version: "vertex-2023-10-16",
    })
    expect(sent.headers["anthropic-beta"]).toBe("context-1m-2025-08-07")
    await until(async () => (await usage()).length === 2)
  })

  test("token counting and Google's errors keep Anthropic's shapes", async () => {
    await vertex()
    const counted = await relay("vertex-claude/messages/count_tokens", {
      body: { model: "claude-sonnet-4-5@20250929", messages: [] },
    })
    expect(await counted.json()).toEqual({ input_tokens: 17 })
    expect(JSON.parse(upstream.seen.at(-1)!.body)).toMatchObject({ model: "claude-sonnet-4-5@20250929" })
    const missing = await relay("vertex-claude/messages", {
      body: { model: "claude-sonnet-4-5@20250929", max_tokens: 10, messages: [] },
    })
    expect(missing.status).toBe(404)
    expect(await missing.json()).toEqual({
      type: "error",
      error: { type: "not_found_error", message: "Publisher model was not found." },
    })
  })

  test("a key that isn't a service account's is refused when saved", async () => {
    const res = await vertex(JSON.stringify({ type: "authorized_user", client_id: "x" }))
    expect(res.status).toBe(400)
    expect(res.data.message).toContain("service account")
  })
})

describe("the organization's own prices", () => {
  const set = (prices: unknown[], token = env.owner.token) =>
    env.call("PUT", "/api/v1/orgs/acme/prices", { token, body: { prices } })

  test("replace catalog prices for gateway calls and client reports alike", async () => {
    await provider("open", {
      kind: "openai-compatible",
      base: `${upstream.url}/open/v1`,
      auth: { type: "none" },
      models: [{ id: "llama", cost: { input: 1, output: 1 } }],
    })
    const res = await set([
      { provider: "open", model: "llama", rates: { input: 10, output: 20 } },
      { provider: "anthropic", model: "*", discount: 25 },
    ])
    expect(res.status).toBe(200)
    await relay("open/chat/completions", { body: { model: "llama", messages: [] } })
    expect((await usage())[0]!.cost).toBeCloseTo((40 * 10 + 2 * 20) / 1e6, 12)
    // A client's report, priced at catalog rates, gets the discount.
    await env.call("POST", "/api/v1/orgs/acme/usage", {
      token: env.owner.token,
      body: {
        records: [
          { id: "r1", at: Date.now(), provider: "anthropic", model: "claude-sonnet-4", tokens: { input: 1 }, cost: 2 },
        ],
      },
    })
    const reported = (await env.store.usage.rows({ org: env.owner.org.id, from: 0, to: Date.now() + 60_000 })).find(
      (row) => row.id === "r1",
    )
    expect(reported!.cost).toBeCloseTo(1.5, 10)
  })

  test("billing managers set them; members can't; each model has one", async () => {
    const billing = await env.join("billing@acme.com", "billing_manager")
    const member = await env.join("member@acme.com", "member")
    expect((await set([{ provider: "openai", model: "*", discount: 10 }], billing.token)).status).toBe(200)
    expect((await set([], member.token)).status).toBe(403)
    expect(
      (
        await set([
          { provider: "openai", model: "*", discount: 10 },
          { provider: "openai", model: "*", discount: 20 },
        ])
      ).status,
    ).toBe(400)
    const audit = await env.call("GET", "/api/v1/orgs/acme/audit?action=price.update", { token: env.owner.token })
    expect(audit.data.events).toHaveLength(1)
  })
})

describe("rate limits", () => {
  // The limits count per calendar minute; stay clear of a minute's end so a test doesn't straddle two.
  beforeEach(async () => {
    const into = Date.now() % 60_000
    if (into > 50_000) await Bun.sleep(60_000 - into + 100)
  })

  const open = () =>
    provider("open", {
      kind: "openai-compatible",
      base: `${upstream.url}/open/v1`,
      auth: { type: "none" },
      models: [{ id: "llama" }],
    })
  const ask = () => relay("open/chat/completions", { body: { model: "llama", messages: [] } })

  test("a member's requests per minute are capped, with a time to retry", async () => {
    await open()
    await policy({ limits: { requests: 2 } })
    expect((await ask()).status).toBe(200)
    expect((await ask()).status).toBe(200)
    const limited = await ask()
    expect(limited.status).toBe(429)
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0)
    expect((await limited.json()).error).toMatchObject({ type: "rate_limit_error", code: "rate_limited" })
    // Other members have their own allowance.
    const other = await env.join("other@acme.com", "member")
    expect(
      (await relay("open/chat/completions", { token: other.token, body: { model: "llama", messages: [] } })).status,
    ).toBe(200)
  })

  test("tokens per minute count what calls used", async () => {
    await open()
    // Each call uses 42 tokens.
    await policy({ limits: { tokens: 50 } })
    expect((await ask()).status).toBe(200)
    expect((await ask()).status).toBe(200)
    expect((await ask()).status).toBe(429)
  })
})

describe("the gateway call log", () => {
  test("records relayed and refused calls; bodies only when the policy asks", async () => {
    await provider("open", {
      kind: "openai-compatible",
      base: `${upstream.url}/open/v1`,
      auth: { type: "none" },
      models: [{ id: "llama" }],
    })
    await relay("open/chat/completions", { body: { model: "llama", messages: [{ role: "user", content: "secret" }] } })
    await relay("missing/chat/completions", { body: { model: "llama" } })
    let logged = await calls()
    expect(logged.map((row) => [row.provider, row.status, row.code])).toEqual([
      ["missing", 404, "unknown_provider"],
      ["open", 200, null],
    ])
    expect(logged[1]).toMatchObject({
      model: "llama",
      tokens: { input: 40, output: 2 },
      bodies: false,
      user: { email: "owner@acme.com" },
    })
    expect((await calls("?failed=true")).map((row) => row.provider)).toEqual(["missing"])

    await policy({ log: { bodies: true, retention: 7 } })
    await relay("open/chat/completions", { body: { model: "llama", messages: [{ role: "user", content: "secret" }] } })
    logged = await calls()
    expect(logged[0]!.bodies).toBe(true)
    const detail = await env.call("GET", `/api/v1/orgs/acme/gateway/calls/${logged[0]!.id}`, { token: env.owner.token })
    expect(detail.data.request).toContain("secret")
    expect(JSON.parse(detail.data.response)).toMatchObject({ usage: { prompt_tokens: 40 } })
    // Members can't read the log.
    const member = await env.join("member@acme.com", "member")
    expect((await env.call("GET", "/api/v1/orgs/acme/gateway/calls", { token: member.token })).status).toBe(403)
  })

  test("calls past the policy's retention are swept", async () => {
    await policy({ log: { bodies: false, retention: 1 } })
    await relay("missing/messages", { body: { model: "x" } })
    await env.exec(`update gateway_calls set at = at - ${2 * 24 * 60 * 60 * 1000}`)
    await env.store.sweep(undefined)
    expect(await calls("?from=0")).toEqual([])
  })
})
