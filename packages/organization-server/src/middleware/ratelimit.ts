import { Effect, Layer } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { scimBody, scimMedia } from "@organization/protocol/errors"
import { cookie, RateLimit as Declared } from "@organization/protocol/middleware"
import { ServerConfig } from "../config"
import { failure } from "../pages"
import { RateLimit } from "../ratelimit"
import { RequestContext } from "../request"

const minute = 60_000

// Health checks, the console's files, and the gateway, whose per-member limits the policy sets.
const exempt = (path: string) =>
  path === "/healthz" ||
  path === "/readyz" ||
  path === "/admin" ||
  path.startsWith("/admin/") ||
  path.startsWith("/gateway/")

const credential = (request: HttpServerRequest.HttpServerRequest) =>
  request.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1] ?? request.cookies[cookie]

// Said the way each kind of client reads it: API clients, identity providers' SCIM clients, and
// people in a browser.
export function refusal(path: string, wait: number) {
  const message = `Too many requests. Try again in ${wait} ${wait === 1 ? "second" : "seconds"}.`
  const headers = { "retry-after": String(wait) }
  if (path.startsWith("/scim/"))
    return HttpServerResponse.jsonUnsafe(scimBody(429, message), { status: 429, contentType: scimMedia, headers })
  if (path.startsWith("/api/"))
    return HttpServerResponse.jsonUnsafe({ _tag: "RateLimitError", message }, { status: 429, headers })
  return HttpServerResponse.setHeaders(failure("Too many requests", message, 429), headers)
}

// Every other request is counted before it is routed: against its token when it carries one (by a
// hash, so tokens aren't kept in memory), otherwise against the client's address.
export const rateLimitLayer = HttpRouter.middleware(
  Effect.gen(function* () {
    const config = yield* ServerConfig.Service
    const limiter = yield* RateLimit.Service
    const address = RequestContext.address(config)
    return (effect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const path = new URL(request.url, "http://localhost").pathname
        if (exempt(path)) return yield* effect
        const token = credential(request)
        const limit = token ? config.limits.token : config.limits.anonymous
        if (limit <= 0) return yield* effect
        const key = token ? `token:${Bun.hash(token)}` : `address:${yield* address}`
        const wait = yield* limiter.take(key, { limit, window: minute })
        return wait > 0 ? refusal(path, wait) : yield* effect
      })
  }),
  { global: true },
)

// The API declares the refusal for its clients; the limits themselves apply above, to every route.
export const rateLimitApiLayer = Layer.succeed(
  Declared,
  Declared.of((effect) => effect),
)
