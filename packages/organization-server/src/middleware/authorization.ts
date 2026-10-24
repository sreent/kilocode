import { Context, Effect, Layer, Option } from "effect"
import { HttpRouter, HttpServerRequest } from "effect/unstable/http"
import {
  ForbiddenError,
  NotFoundError,
  ScimUnauthorized,
  scimBody,
  UnauthorizedError,
} from "@organization/protocol/errors"
import {
  Authorization,
  Caller,
  cookie,
  Membership,
  OrgScope,
  Provisioner,
  ScimAuthorization,
} from "@organization/protocol/middleware"
import { can, Requires } from "@organization/protocol/roles"
import { ServerConfig } from "../config"
import { Store } from "../store"

const bearer = (request: HttpServerRequest.HttpServerRequest) =>
  request.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1]

export const authorizationLayer = Layer.effect(
  Authorization,
  Effect.gen(function* () {
    const store = yield* Store.Service
    const config = yield* ServerConfig.Service
    const origin = new URL(config.base).origin
    return Authorization.of((effect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const header = bearer(request)
        const value = header ?? request.cookies[cookie]
        if (!value) return yield* new UnauthorizedError({ message: "missing bearer token" })
        const token = yield* store.token.verify(value)
        if (!token || token.kind !== "user" || !token.user)
          return yield* new UnauthorizedError({ message: "invalid or expired token" })
        const user = yield* store.user.get(token.user)
        if (!user || !user.active) return yield* new UnauthorizedError({ message: "user is deactivated" })
        // Browser sessions ride on an ambient cookie, so writes must prove they come from our own origin (CSRF).
        if (!header && request.method !== "GET" && request.method !== "HEAD" && request.headers.origin !== origin)
          return yield* new ForbiddenError({ message: "cross-origin request rejected" })
        return yield* Effect.provideService(effect, Caller, {
          user: { id: user.id, email: user.email, name: user.name },
          token: { id: token.id, org: token.org },
          cookie: !header,
        })
      }),
    )
  }),
)

export const orgScopeLayer = Layer.effect(
  OrgScope,
  Effect.gen(function* () {
    const store = yield* Store.Service
    return OrgScope.of((effect, { endpoint }) =>
      Effect.gen(function* () {
        const caller = yield* Caller
        const route = yield* HttpRouter.RouteContext
        const org = yield* store.org.get(route.params.org ?? "")
        // 404 rather than 403 so tokens can't probe which orgs exist.
        if (!org || !(yield* store.token.reaches(caller.token, org.id)))
          return yield* new NotFoundError({ message: "organization not found" })
        const access = yield* store.member.role(org.id, caller.user.id)
        if (!access) return yield* new NotFoundError({ message: "organization not found" })
        const needed = Context.getOption(endpoint.annotations, Requires)
        if (Option.isSome(needed) && !can(access.role, needed.value))
          return yield* new ForbiddenError({ message: `your role (${access.role}) cannot perform ${needed.value}` })
        return yield* Effect.provideService(effect, Membership, { org, role: access.role, inherited: access.inherited })
      }),
    )
  }),
)

// The bearer token decides the org, so one SCIM base URL serves every org on the server.
export const scimAuthorizationLayer = Layer.effect(
  ScimAuthorization,
  Effect.gen(function* () {
    const store = yield* Store.Service
    return ScimAuthorization.of((effect) =>
      Effect.gen(function* () {
        const value = bearer(yield* HttpServerRequest.HttpServerRequest)
        const token = value ? yield* store.token.verify(value) : undefined
        const org = token?.kind === "scim" ? yield* store.org.get(token.org) : undefined
        if (!token || !org) return yield* new ScimUnauthorized(scimBody(401, "invalid SCIM bearer token"))
        return yield* Effect.provideService(effect, Provisioner, { org, token: { id: token.id, name: token.name } })
      }),
    )
  }),
)
