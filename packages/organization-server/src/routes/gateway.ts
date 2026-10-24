import { Cause, Clock, Effect, Stream } from "effect"
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http"
import { allows, overBudget } from "@organization/protocol/match"
import type { GatewayKind } from "@organization/protocol/schema"
import * as Crypto from "../crypto"
import { ServerConfig } from "../config"
import { Meter } from "../meter"
import { effective } from "../policy"
import { Pricing } from "../pricing"
import { Store, type GatewayProvider } from "../store"

// The LLM gateway. Clients send a provider's API requests to /gateway/<provider>/... with their
// organization token as the API key. The gateway checks the token, the member's model policy and
// budgets, swaps in the org's own key, relays the call, and meters usage from the response. Clients
// never hold the upstream key, so policy and budgets hold even for a client that ignores them.

type Route = { readonly method: string; readonly path: string; readonly meter?: Meter.Api }

// Only the endpoints clients use for chat are relayed; an org key can't be used for anything else.
const routes: Record<GatewayKind, ReadonlyArray<Route>> = {
  anthropic: [
    { method: "POST", path: "/messages", meter: "messages" },
    { method: "POST", path: "/messages/count_tokens" },
    { method: "GET", path: "/models" },
  ],
  openai: [
    { method: "POST", path: "/responses", meter: "responses" },
    { method: "POST", path: "/chat/completions", meter: "chat" },
    { method: "GET", path: "/models" },
  ],
  "openai-compatible": [
    { method: "POST", path: "/chat/completions", meter: "chat" },
    { method: "GET", path: "/models" },
  ],
}

// Request headers relayed upstream. Client credentials, cookies and everything else stay here.
const forwarded = [
  "content-type",
  "accept",
  "anthropic-version",
  "anthropic-beta",
  "openai-beta",
  "user-agent",
  "http-referer",
  "x-title",
]

// Response headers relayed back: the body's type, request ids and rate limits, which clients use
// to back off. Upstream cookies and account details are not.
const returned = (name: string) =>
  name === "content-type" ||
  name === "retry-after" ||
  name === "request-id" ||
  name === "x-request-id" ||
  name.startsWith("anthropic-ratelimit-") ||
  name.startsWith("x-ratelimit-")

// Clients attribute calls with these; they are recorded with usage, never relayed.
const attribution = { session: "x-org-session", project: "x-org-project" }

// One body both provider families' SDKs parse: Anthropic reads `type` and `error.type`/`error.message`,
// OpenAI-style clients read `error.message`/`error.code`.
const kinds: Record<number, string> = {
  400: "invalid_request_error",
  401: "authentication_error",
  402: "billing_error",
  403: "permission_error",
  404: "not_found_error",
  502: "api_error",
  503: "api_error",
}

function failure(status: number, code: string, message: string) {
  return HttpServerResponse.jsonUnsafe(
    { type: "error", error: { type: kinds[status] ?? "api_error", code, message } },
    { status },
  )
}

// Anthropic SDKs send the key as x-api-key, OpenAI-style ones as a bearer token; Azure and Google
// clients use their own headers.
function credential(request: HttpServerRequest.HttpServerRequest) {
  const headers = request.headers
  return (
    headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1] ??
    headers["x-api-key"] ??
    headers["api-key"] ??
    headers["x-goog-api-key"]
  )
}

function label(value: string | undefined, max: number) {
  const text = value?.trim()
  return text ? text.slice(0, max) : undefined
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export const gatewayRoutes = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const store = yield* Store.Service
    const config = yield* ServerConfig.Service
    const pricing = yield* Pricing.Service
    const http = yield* HttpClient.HttpClient

    const meter = Effect.fn("Gateway.meter")(function* (input: {
      org: string
      user: string
      provider: GatewayProvider
      model: string
      session?: string
      project?: string
      usage: Meter.Usage | undefined
    }) {
      const usage = input.usage
      if (!usage) return
      const cost = usage.cost ?? (yield* pricing.cost(input.provider.id, input.model, usage))
      yield* store.usage.record(input.org, input.user, [
        {
          id: Crypto.id("gw"),
          at: yield* Clock.currentTimeMillis,
          session: input.session,
          project: input.project,
          provider: input.provider.id,
          model: input.model,
          input: usage.input,
          output: usage.output,
          reasoning: usage.reasoning,
          read: usage.read,
          write: usage.write,
          cost,
          source: "gateway",
        },
      ])
    })

    const relay = Effect.fn("Gateway.relay")(function* (request: HttpServerRequest.HttpServerRequest) {
      const url = new URL(request.url, "http://localhost")
      const [id = "", ...rest] = url.pathname.slice("/gateway/".length).split("/")
      const path = `/${rest.join("/")}`

      const value = credential(request)
      if (!value) return failure(401, "missing_api_key", "Use your organization token as the API key.")
      const token = yield* store.token.verify(value)
      const user = token?.kind === "user" && token.user ? yield* store.user.get(token.user) : undefined
      if (!token || !user || !user.active)
        return failure(401, "invalid_api_key", "Invalid or expired organization token.")
      const org = yield* store.org.get(token.org)
      const access = org ? yield* store.member.role(org.id, user.id) : undefined
      if (!org || !access) return failure(403, "not_a_member", "You are not a member of this organization.")
      const provider = yield* store.gateway.get(org.id, id)
      if (!provider) return failure(404, "unknown_provider", `${org.name} does not route "${id}" through the gateway.`)
      const route = routes[provider.kind].find((item) => item.method === request.method && item.path === path)
      if (!route)
        return failure(404, "unsupported_endpoint", `${request.method} ${path} is not available through the gateway.`)
      if (!config.secret)
        return failure(503, "gateway_unavailable", "The gateway is not configured: ORGANIZATION_SECRET is not set.")

      const body =
        request.method === "POST"
          ? yield* request.arrayBuffer.pipe(
              Effect.map((buffer) => new Uint8Array(buffer)),
              Effect.orElseSucceed(() => undefined),
            )
          : undefined
      if (request.method === "POST" && !body) return failure(400, "invalid_body", "Could not read the request body.")
      const payload = (() => {
        if (!body) return undefined
        try {
          const parsed: unknown = JSON.parse(decoder.decode(body))
          return parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : undefined
        } catch {
          return undefined
        }
      })()
      if (body && !payload) return failure(400, "invalid_body", "The request body must be a JSON object.")
      const model = typeof payload?.model === "string" ? payload.model : undefined
      if (route.meter && !model) return failure(400, "missing_model", "The request must name a model.")

      const policy = yield* effective(store, { org, user, role: access.role })
      if (model && !allows(policy, provider.id, model))
        return failure(
          403,
          "model_not_allowed",
          `The model ${provider.id}/${model} is not allowed by your organization's policy.`,
        )
      if (route.meter && policy.budget.exceeded)
        return failure(
          402,
          "budget_exceeded",
          overBudget(policy) ?? "Your organization's AI budget has been reached. Contact your administrator.",
        )

      // Streamed chat completions only carry usage when asked to.
      const options = payload?.stream_options
      const upstreamBody =
        route.meter === "chat" &&
        payload?.stream === true &&
        (options as { include_usage?: unknown } | undefined)?.include_usage !== true
          ? encoder.encode(
              JSON.stringify({ ...payload, stream_options: { ...(options as object), include_usage: true } }),
            )
          : body

      // A key sealed under an earlier ORGANIZATION_SECRET cannot be opened; an owner has to enter it again.
      const unsealed = yield* Crypto.unseal(config.secret, provider.secret).pipe(Effect.exit)
      if (unsealed._tag === "Failure") {
        yield* Effect.logError("cannot decrypt a gateway key; was ORGANIZATION_SECRET changed?").pipe(
          Effect.annotateLogs({ org: org.slug, provider: provider.id }),
        )
        return failure(
          503,
          "gateway_unavailable",
          `The gateway cannot use ${org.name}'s key for ${provider.id}. An owner needs to enter it again.`,
        )
      }
      const key = unsealed.value
      const headers: Record<string, string> = {}
      for (const name of forwarded) {
        const header = request.headers[name]
        if (header) headers[name] = header
      }
      if (provider.kind === "anthropic") headers["x-api-key"] = key
      else headers.authorization = `Bearer ${key}`
      const outgoing = HttpClientRequest.make(request.method === "POST" ? "POST" : "GET")(
        `${provider.base}${path}${url.search}`,
      ).pipe(HttpClientRequest.setHeaders(headers), (outgoing) =>
        upstreamBody
          ? HttpClientRequest.bodyUint8Array(outgoing, upstreamBody, headers["content-type"] ?? "application/json")
          : outgoing,
      )

      // Redirects are relayed rather than followed, so the org key never travels to another host.
      const exit = yield* http
        .execute(outgoing)
        .pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }), Effect.exit)
      if (exit._tag === "Failure") {
        yield* Effect.logWarning("gateway upstream unreachable").pipe(
          Effect.annotateLogs({ provider: provider.id, cause: Cause.pretty(exit.cause) }),
        )
        return failure(502, "upstream_unreachable", `Could not reach ${provider.id}. Try again later.`)
      }
      const response = exit.value
      const reply = {
        status: response.status,
        headers: Object.fromEntries(Object.entries(response.headers).filter(([name]) => returned(name))),
      }
      if (!route.meter || !model || response.status >= 300) return HttpServerResponse.stream(response.stream, reply)

      const usage = {
        org: org.id,
        user: user.id,
        provider,
        model,
        session: label(request.headers[attribution.session], 200),
        project: label(request.headers[attribution.project], 500),
      }
      const usageMeter = Meter.make(route.meter)
      // Reads the meter when it runs, after the response has passed through it. A metering failure
      // must never fail the call it meters.
      const record = Effect.suspend(() => meter({ ...usage, usage: usageMeter.end() })).pipe(
        Effect.catchCause((cause) =>
          Effect.logError("could not record gateway usage").pipe(Effect.annotateLogs({ cause: Cause.pretty(cause) })),
        ),
      )
      if (response.headers["content-type"]?.includes("text/event-stream"))
        // Recorded however the stream ends: completed, failed upstream, or cut off by the client.
        return HttpServerResponse.stream(
          response.stream.pipe(
            Stream.tap((chunk) => Effect.sync(() => usageMeter.feed(chunk))),
            Stream.onExit(() => record),
          ),
          reply,
        )
      const bytes = new Uint8Array(yield* response.arrayBuffer.pipe(Effect.orElseSucceed(() => new ArrayBuffer(0))))
      try {
        usageMeter.json(JSON.parse(decoder.decode(bytes)))
      } catch {
        // Not JSON; nothing to meter.
      }
      yield* record
      return HttpServerResponse.uint8Array(bytes, reply)
    })

    yield* router.add("*", "/gateway/*", relay)
  }),
)
