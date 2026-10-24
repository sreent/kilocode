import { Cause, Clock, Effect, Stream } from "effect"
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http"
import { allows, overBudget, preferences, withheld } from "@organization/protocol/match"
import type { GatewayKind } from "@organization/protocol/schema"
import { Bedrock } from "../bedrock"
import * as Crypto from "../crypto"
import { ServerConfig } from "../config"
import { Google } from "../google"
import { Meter } from "../meter"
import { effective } from "../policy"
import { charge, price, Pricing } from "../pricing"
import { RequestContext } from "../request"
import { Store, type GatewayProvider } from "../store"
import { Upstream } from "../upstream"
import { Vertex } from "../vertex"

// The LLM gateway. Clients send a provider's API requests to /gateway/<provider>/... with their
// organization token as the API key. The gateway checks the token, the member's model policy,
// budgets and rate limits, signs in to the upstream with the org's own credentials, relays the call,
// meters usage from the response and logs the call. Clients never hold the upstream credentials, so
// policy and budgets hold even for a client that ignores them.

type Route = {
  readonly method: string
  readonly path: string
  readonly meter?: Meter.Api
  // Answered here from the provider's model list, for upstreams that have no listing of their own.
  readonly listing?: true
}

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
  bedrock: [
    { method: "POST", path: "/messages", meter: "messages" },
    { method: "GET", path: "/models", listing: true },
  ],
  vertex: [
    { method: "POST", path: "/messages", meter: "messages" },
    { method: "POST", path: "/messages/count_tokens" },
    { method: "GET", path: "/models", listing: true },
  ],
}

// Request headers relayed upstream. Client credentials, cookies and everything else stay here.
// Bedrock and Vertex take the API version in the body, and Bedrock the beta flags too.
const forwarded: Record<GatewayKind, ReadonlyArray<string>> = (() => {
  const common = ["content-type", "accept", "user-agent"]
  const anthropic = [...common, "anthropic-version", "anthropic-beta"]
  return {
    anthropic,
    openai: [...common, "openai-beta", "http-referer", "x-title"],
    "openai-compatible": [...common, "openai-beta", "http-referer", "x-title"],
    bedrock: ["content-type", "user-agent"],
    vertex: [...common, "anthropic-beta"],
  }
})()

// Response headers relayed back: the body's type, request ids and rate limits, which clients use
// to back off. Upstream cookies and account details are not.
const returned = (name: string) =>
  name === "content-type" ||
  name === "retry-after" ||
  name === "request-id" ||
  name === "x-request-id" ||
  name === "x-amzn-requestid" ||
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
  429: "rate_limit_error",
  502: "api_error",
  503: "api_error",
}

function failure(status: number, code: string, message: string, headers?: Record<string, string>) {
  return HttpServerResponse.jsonUnsafe(
    { type: "error", error: { type: kinds[status] ?? "api_error", code, message } },
    { status, headers },
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

// A JSON object's fields, or none for anything else.
const fields = (value: unknown) => (value && typeof value === "object" && !Array.isArray(value) ? value : {})

function label(value: string | undefined, max: number) {
  const text = value?.trim()
  return text ? text.slice(0, max) : undefined
}

// Logged bodies are cut to this many characters.
const kept = 64 * 1024
const clip = (text: string) => (text.length > kept ? `${text.slice(0, kept)}\n[cut at ${kept} characters]` : text)

const minute = 60_000
const encoder = new TextEncoder()
const decoder = new TextDecoder()

// LiteLLM reports what a call cost in a header; metered usage that lacks a price takes it.
function reported(headers: Readonly<Record<string, string>>) {
  const value = Number(headers["x-litellm-response-cost"])
  return Number.isFinite(value) && value >= 0 ? value : undefined
}

export const gatewayRoutes = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const store = yield* Store.Service
    const config = yield* ServerConfig.Service
    const pricing = yield* Pricing.Service
    const http = yield* HttpClient.HttpClient
    const token = Google.tokens(http)

    // What a call cost: the org's own price when it set one, else the provider's model list, the
    // upstream's own figure, or the models.dev catalog.
    const cost = Effect.fn("Gateway.cost")(function* (
      org: string,
      provider: GatewayProvider,
      model: string,
      usage: Meter.Usage,
    ) {
      const rule = yield* store.price.rule(org, provider.id, model)
      const listed =
        usage.cost ??
        price(
          provider.models.find((item) => item.id === model)?.cost ?? (yield* pricing.rates(provider.id, model)),
          usage,
        )
      return charge({ rule, listed, tokens: usage })
    })

    const relay = Effect.fn("Gateway.relay")(function* (request: HttpServerRequest.HttpServerRequest) {
      const started = yield* Clock.currentTimeMillis
      const url = new URL(request.url, "http://localhost")
      const [id = "", ...rest] = url.pathname.slice("/gateway/".length).split("/")
      const path = `/${rest.join("/")}`

      const value = credential(request)
      if (!value) return failure(401, "missing_api_key", "Use your organization token as the API key.")
      const verified = yield* store.token.verify(value)
      const user = verified?.kind === "user" && verified.user ? yield* store.user.get(verified.user) : undefined
      if (!verified || !user || !user.active)
        return failure(401, "invalid_api_key", "Invalid or expired organization token.")
      const org = yield* store.org.get(verified.org)
      const access = org ? yield* store.member.role(org.id, user.id) : undefined
      if (!org || !access) return failure(403, "not_a_member", "You are not a member of this organization.")

      // From here on, every call is logged in the org's gateway log.
      const settings = (yield* store.policy.get(org.id)).policy.gateway
      const ip = yield* RequestContext.address(config)
      const session = label(request.headers[attribution.session], 200)
      const project = label(request.headers[attribution.project], 500)
      const record = (input: {
        readonly status: number
        readonly code?: string
        readonly model?: string
        readonly usage?: Meter.Usage
        readonly cost?: number
        readonly request?: string
        readonly response?: string
      }) =>
        Effect.gen(function* () {
          const ended = yield* Clock.currentTimeMillis
          yield* store.call.record({
            org: org.id,
            user: user.id,
            at: started,
            provider: id,
            model: input.model ?? null,
            method: request.method,
            path,
            status: input.status,
            code: input.code ?? null,
            latency: Math.max(0, ended - started),
            input: input.usage?.input ?? 0,
            output: input.usage?.output ?? 0,
            reasoning: input.usage?.reasoning ?? 0,
            cache_read: input.usage?.read ?? 0,
            cache_write: input.usage?.write ?? 0,
            cost: input.cost ?? 0,
            session: session ?? null,
            project: project ?? null,
            ip,
            request: settings.log.bodies && input.request !== undefined ? clip(input.request) : null,
            response: settings.log.bodies && input.response !== undefined ? clip(input.response) : null,
          })
        }).pipe(
          // Logging must never fail the call it logs.
          Effect.catchCause((cause) =>
            Effect.logError("could not log a gateway call").pipe(Effect.annotateLogs({ cause: Cause.pretty(cause) })),
          ),
        )
      const refuse = (
        status: number,
        code: string,
        message: string,
        extra: { readonly model?: string; readonly request?: string; readonly headers?: Record<string, string> } = {},
      ) => {
        const response = failure(status, code, message, extra.headers)
        return record({ status, code, model: extra.model, request: extra.request, response: message }).pipe(
          Effect.as(response),
        )
      }

      const provider = yield* store.gateway.get(org.id, id)
      if (!provider)
        return yield* refuse(404, "unknown_provider", `${org.name} does not route "${id}" through the gateway.`)
      const route = routes[provider.kind].find((item) => item.method === request.method && item.path === path)
      if (!route)
        return yield* refuse(
          404,
          "unsupported_endpoint",
          `${request.method} ${path} is not available through the gateway.`,
        )
      if (route.listing) {
        const listing = {
          data: provider.models.map((item) => ({ type: "model", id: item.id, display_name: item.name ?? item.id })),
          has_more: false,
          first_id: provider.models.at(0)?.id ?? null,
          last_id: provider.models.at(-1)?.id ?? null,
        }
        yield* record({ status: 200 })
        return HttpServerResponse.jsonUnsafe(listing)
      }
      if (!config.secret)
        return yield* refuse(
          503,
          "gateway_unavailable",
          "The gateway is not configured: ORGANIZATION_SECRET is not set.",
        )

      const body =
        request.method === "POST"
          ? yield* request.arrayBuffer.pipe(
              Effect.map((buffer) => new Uint8Array(buffer)),
              Effect.orElseSucceed(() => undefined),
            )
          : undefined
      if (request.method === "POST" && !body)
        return yield* refuse(400, "invalid_body", "Could not read the request body.")
      const sent = body ? decoder.decode(body) : undefined
      const payload = (() => {
        if (sent === undefined) return undefined
        try {
          const parsed: unknown = JSON.parse(sent)
          return parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : undefined
        } catch {
          return undefined
        }
      })()
      if (body && !payload)
        return yield* refuse(400, "invalid_body", "The request body must be a JSON object.", { request: sent })
      const model = typeof payload?.model === "string" ? payload.model : undefined
      if (
        (route.meter || provider.kind === "bedrock" || provider.kind === "vertex") &&
        request.method === "POST" &&
        !model
      )
        return yield* refuse(400, "missing_model", "The request must name a model.", { request: sent })

      // Bedrock and Vertex take the model in the URL path.
      if ((provider.kind === "bedrock" || provider.kind === "vertex") && model && !/^[\w.@:-]{1,200}$/.test(model))
        return yield* refuse(400, "invalid_model", "The model id has characters no model id has.", {
          model,
          request: sent,
        })

      const policy = yield* effective(store, { org, user, role: access.role })
      const reason = withheld(policy, provider.id)
      if (reason) return yield* refuse(403, "data_policy", reason, { model, request: sent })
      if (model && !allows(policy, provider.id, model))
        return yield* refuse(
          403,
          "model_not_allowed",
          `The model ${provider.id}/${model} is not allowed by your organization's policy.`,
          { model, request: sent },
        )
      if (route.meter && policy.budget.exceeded)
        return yield* refuse(
          402,
          "budget_exceeded",
          overBudget(policy) ?? "Your organization's AI budget has been reached. Contact your administrator.",
          { model, request: sent },
        )

      // Fixed one-minute windows; a call counts against the window it started in.
      const window = started - (started % minute)
      const limits = settings.limits
      if (route.meter && (limits.requests !== undefined || limits.tokens !== undefined)) {
        const counted = yield* store.rate.hit(org.id, user.id, window)
        const requests = limits.requests !== undefined && counted.requests > limits.requests
        const tokens = limits.tokens !== undefined && counted.tokens >= limits.tokens
        if (requests || tokens)
          return yield* refuse(
            429,
            "rate_limited",
            requests
              ? `Your organization allows ${limits.requests} model requests per minute. Try again shortly.`
              : `Your organization allows ${limits.tokens} tokens per minute. Try again shortly.`,
            {
              model,
              request: sent,
              headers: { "retry-after": String(Math.max(1, Math.ceil((window + minute - started) / 1000))) },
            },
          )
      }

      // A key sealed under an earlier ORGANIZATION_SECRET cannot be opened; an owner has to enter it again.
      const unsealed = yield* Effect.gen(function* () {
        const key = yield* Crypto.unseal(config.secret!, provider.secret)
        const headers = provider.headers
          ? (JSON.parse(yield* Crypto.unseal(config.secret!, provider.headers)) as Record<string, string>)
          : {}
        return { key, headers }
      }).pipe(Effect.exit)
      if (unsealed._tag === "Failure") {
        yield* Effect.logError("cannot decrypt a gateway credential; was ORGANIZATION_SECRET changed?").pipe(
          Effect.annotateLogs({ org: org.slug, provider: provider.id }),
        )
        return yield* refuse(
          503,
          "gateway_unavailable",
          `The gateway cannot use ${org.name}'s credentials for ${provider.id}. An owner needs to enter them again.`,
          { model, request: sent },
        )
      }

      // Streamed chat completions only carry usage when asked to, and an OpenRouter-compatible upstream
      // holds a request to the data policy only when it carries the policy's routing preferences.
      const options = payload?.stream_options
      const include =
        route.meter === "chat" &&
        payload?.stream === true &&
        (options as { include_usage?: unknown } | undefined)?.include_usage !== true
      const routing =
        route.meter === "chat" || route.meter === "responses" ? preferences(policy, provider.id) : undefined
      const outgoing = (() => {
        if (provider.kind === "bedrock")
          return Bedrock.request({
            base: provider.base,
            model: model!,
            payload: payload!,
            beta: request.headers["anthropic-beta"],
          })
        if (provider.kind === "vertex")
          return Vertex.request({
            base: provider.base,
            path: path as "/messages" | "/messages/count_tokens",
            model: model!,
            payload: payload!,
          })
        const relayed =
          include || routing
            ? encoder.encode(
                JSON.stringify({
                  ...payload,
                  ...(include ? { stream_options: { ...(options as object), include_usage: true } } : {}),
                  ...(routing ? { provider: { ...fields(payload?.provider), ...routing } } : {}),
                }),
              )
            : body
        return { url: `${provider.base}${path}${url.search}`, body: relayed }
      })()
      const headers: Record<string, string> = {}
      for (const name of forwarded[provider.kind]) {
        const header = request.headers[name]
        if (header) headers[name] = header
      }
      if ("accept" in outgoing && outgoing.accept) headers.accept = outgoing.accept
      if (outgoing.body && !headers["content-type"]) headers["content-type"] = "application/json"
      const method = request.method === "POST" ? "POST" : "GET"
      const prepared = yield* Upstream.prepare({
        provider,
        secrets: unsealed.value,
        method,
        url: outgoing.url,
        headers,
        body: outgoing.body,
        token,
      }).pipe(Effect.exit)
      if (prepared._tag === "Failure") {
        const reason = Cause.squash(prepared.cause)
        yield* Effect.logWarning("could not sign in to a gateway upstream").pipe(
          Effect.annotateLogs({ provider: provider.id, error: String(reason) }),
        )
        return yield* refuse(
          502,
          "upstream_sign_in_failed",
          `The gateway could not sign in to ${provider.id}: ${reason instanceof Error ? reason.message : String(reason)}`,
          { model, request: sent },
        )
      }

      // Redirects are relayed rather than followed, so credentials never travel to another host.
      const call = HttpClientRequest.make(method)(prepared.value.url).pipe(
        HttpClientRequest.setHeaders(prepared.value.headers),
        (call) =>
          outgoing.body
            ? HttpClientRequest.bodyUint8Array(
                call,
                outgoing.body,
                prepared.value.headers["content-type"] ?? "application/json",
              )
            : call,
      )
      const exit = yield* http
        .execute(call)
        .pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }), Effect.exit)
      if (exit._tag === "Failure") {
        yield* Effect.logWarning("gateway upstream unreachable").pipe(
          Effect.annotateLogs({ provider: provider.id, cause: Cause.pretty(exit.cause) }),
        )
        return yield* refuse(502, "upstream_unreachable", `Could not reach ${provider.id}. Try again later.`, {
          model,
          request: sent,
        })
      }
      const response = exit.value
      const reply = {
        status: response.status,
        headers: Object.fromEntries(Object.entries(response.headers).filter(([name]) => returned(name))),
      }

      // Failures and unmetered answers are small: read them whole, so they can be logged, and so
      // Bedrock's and Vertex's failures can be put in the Anthropic shape clients expect.
      if (!route.meter || response.status >= 300) {
        const raw = new Uint8Array(yield* response.arrayBuffer.pipe(Effect.orElseSucceed(() => new ArrayBuffer(0))))
        const bytes =
          response.status >= 300 && provider.kind === "bedrock"
            ? Bedrock.error(response.status, raw)
            : response.status >= 300 && provider.kind === "vertex"
              ? Vertex.error(response.status, raw)
              : raw
        yield* record({ status: response.status, model, request: sent, response: decoder.decode(bytes) })
        const type = bytes === raw ? {} : { "content-type": "application/json" }
        return HttpServerResponse.uint8Array(bytes, { ...reply, headers: { ...reply.headers, ...type } })
      }

      const meter = Meter.make(route.meter)
      const upstreamCost = reported(response.headers)
      let captured = ""
      const keep = (chunk: Uint8Array) => {
        if (settings.log.bodies && captured.length <= kept) captured += decoder.decode(chunk, { stream: true })
      }
      // Reads the meter when it runs, after the response has passed through it. Recording usage or
      // the log must never fail the call they describe.
      const settle = Effect.suspend(() =>
        Effect.gen(function* () {
          const metered = meter.end()
          const usage =
            metered && metered.cost === undefined && upstreamCost !== undefined
              ? { ...metered, cost: upstreamCost }
              : metered
          const spent = usage ? yield* cost(org.id, provider, model!, usage) : 0
          if (usage) {
            yield* store.usage.record(org.id, user.id, [
              {
                id: Crypto.id("gw"),
                at: started,
                session,
                project,
                provider: provider.id,
                model: model!,
                input: usage.input,
                output: usage.output,
                reasoning: usage.reasoning,
                read: usage.read,
                write: usage.write,
                cost: spent,
                source: "gateway",
              },
            ])
            if (limits.tokens !== undefined)
              yield* store.rate.spend(
                org.id,
                user.id,
                window,
                usage.input + usage.output + usage.reasoning + usage.read + usage.write,
              )
          }
          yield* record({ status: response.status, model, usage, cost: spent, request: sent, response: captured })
        }),
      ).pipe(
        Effect.catchCause((cause) =>
          Effect.logError("could not record gateway usage").pipe(Effect.annotateLogs({ cause: Cause.pretty(cause) })),
        ),
      )

      const type = response.headers["content-type"] ?? ""
      if (provider.kind === "bedrock" && type.includes("application/vnd.amazon.eventstream")) {
        const convert = Bedrock.events()
        // Recorded however the stream ends: completed, failed upstream, or cut off by the client.
        return HttpServerResponse.stream(
          response.stream.pipe(
            Stream.flatMap((chunk) => Stream.fromIterable(convert(chunk))),
            Stream.tap((chunk) => Effect.sync(() => (meter.feed(chunk), keep(chunk)))),
            Stream.onExit(() => settle),
          ),
          { ...reply, headers: { ...reply.headers, "content-type": "text/event-stream" } },
        )
      }
      if (type.includes("text/event-stream"))
        return HttpServerResponse.stream(
          response.stream.pipe(
            Stream.tap((chunk) => Effect.sync(() => (meter.feed(chunk), keep(chunk)))),
            Stream.onExit(() => settle),
          ),
          reply,
        )
      const bytes = new Uint8Array(yield* response.arrayBuffer.pipe(Effect.orElseSucceed(() => new ArrayBuffer(0))))
      try {
        meter.json(JSON.parse(decoder.decode(bytes)))
      } catch {
        // Not JSON; nothing to meter.
      }
      keep(bytes)
      yield* settle
      return HttpServerResponse.uint8Array(bytes, reply)
    })

    yield* router.add("*", "/gateway/*", relay)
  }),
)
