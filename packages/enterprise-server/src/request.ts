export * as RequestContext from "./request"

import { Context, Effect, Option } from "effect"
import { HttpServerRequest } from "effect/unstable/http"
import { Caller, Membership } from "@enterprise/protocol/middleware"
import type { ServerConfig } from "./config"
import type { Store } from "./store"

// The TCP peer of the connection. The entrypoint passes Bun's requestIP into each request's context.
export class Peer extends Context.Service<Peer, string>()("@enterprise/Peer") {}

// The client address recorded in audit events. Forwarded headers are trusted only behind a proxy.
export const address = (config: ServerConfig.Info) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    if (config.proxy) {
      const forwarded = request.headers["x-forwarded-for"]?.split(",").at(0)?.trim()
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
