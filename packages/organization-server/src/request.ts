export * as RequestContext from "./request"

import { Context, Effect, Option } from "effect"
import { HttpServerRequest } from "effect/unstable/http"
import { Caller, Membership } from "@organization/protocol/middleware"
import type { ServerConfig } from "./config"
import type { Store } from "./store"

// The TCP peer of the connection. The entrypoint passes Bun's requestIP into each request's context.
export class Peer extends Context.Service<Peer, string>()("@organization/Peer") {}

// The client's address, for audit events and rate limits. Behind proxies, each appends the address
// it saw to X-Forwarded-For, so the client's is as many entries from the end as there are proxies.
// Entries before it are whatever the client sent, so none of them is trusted.
export const address = (config: ServerConfig.Info) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    if (config.proxy > 0) {
      const entries = (request.headers["x-forwarded-for"] ?? "")
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean)
      // Fewer entries than proxies: the request skipped the outer ones, and the first is the client.
      const forwarded = entries.at(-config.proxy) ?? entries.at(0)
      if (forwarded) return forwarded
    }
    const peer = yield* Effect.serviceOption(Peer)
    return Option.getOrElse(Option.filter(peer, Boolean), () => Option.getOrNull(request.remoteAddress))
  })

// Records an event in the org a request is scoped to, attributed to the caller.
export const auditor = (store: Store.Interface, config: ServerConfig.Info) =>
  Effect.fn("audit")(function* (action: string, target?: string | null, details?: Record<string, unknown>) {
    const caller = yield* Caller
    const scope = yield* Membership
    yield* store.audit.record({
      org: scope.org.id,
      action,
      actor: { id: caller.user.id, email: caller.user.email },
      target,
      details,
      ip: yield* address(config),
    })
  })
