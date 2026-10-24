import { Effect } from "effect"
import { HttpEffect, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder, HttpApiSchema } from "effect/unstable/httpapi"
import { Api } from "@organization/protocol/api"
import { NotFoundError } from "@organization/protocol/errors"
import { Caller, cookie } from "@organization/protocol/middleware"
import { ServerConfig } from "../config"
import { RequestContext } from "../request"
import { Store } from "../store"

const day = 24 * 60 * 60 * 1000

export const AccountHandler = HttpApiBuilder.group(Api, "organization.account", (handlers) =>
  Effect.gen(function* () {
    const store = yield* Store.Service
    const config = yield* ServerConfig.Service

    // Account-level events (tokens, logout) are recorded in the org the caller's token belongs to.
    const record = Effect.fn(function* (action: string, details?: Record<string, unknown>) {
      const caller = yield* Caller
      yield* store.audit.record({
        org: caller.token.org,
        action,
        actor: { id: caller.user.id, email: caller.user.email },
        target: caller.user.id,
        details,
        ip: yield* RequestContext.address(config),
      })
    })

    return handlers
      .handle(
        "me.get",
        // The caller's identity and the orgs this token reaches: its own org plus sub-orgs it can manage.
        Effect.fn(function* () {
          const caller = yield* Caller
          const home = (yield* store.org.get(caller.token.org))!
          const reachable = [home, ...(yield* store.org.children(home.id))]
          const orgs = yield* Effect.forEach(reachable, (org) =>
            store.member.role(org.id, caller.user.id).pipe(
              Effect.map((access) =>
                access
                  ? [
                      {
                        id: org.id,
                        slug: org.slug,
                        name: org.name,
                        parent: org.parent,
                        role: access.role,
                        inherited: access.inherited,
                      },
                    ]
                  : [],
              ),
            ),
          )
          return { user: caller.user, orgs: orgs.flat() }
        }),
      )
      .handle(
        "tokens.list",
        Effect.fn(function* () {
          const caller = yield* Caller
          return { tokens: yield* store.token.list({ org: caller.token.org, user: caller.user.id, kind: "user" }) }
        }),
      )
      .handle(
        "tokens.create",
        Effect.fn(function* (ctx) {
          const caller = yield* Caller
          const days = ctx.payload.days ?? 90
          const issued = yield* store.token.issue({
            kind: "user",
            user: caller.user.id,
            org: caller.token.org,
            name: ctx.payload.name,
            ttl: days * day,
          })
          yield* record("token.create", { token: issued.id, name: ctx.payload.name, days })
          return { id: issued.id, token: issued.value }
        }),
      )
      .handle(
        "tokens.revoke",
        Effect.fn(function* (ctx) {
          const caller = yield* Caller
          const row = yield* store.token.get(ctx.params.id)
          if (!row || row.user !== caller.user.id || row.org !== caller.token.org)
            return yield* new NotFoundError({ message: "token not found" })
          yield* store.token.revoke(row.id)
          yield* record("token.revoke", { token: row.id, name: row.name })
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "logout",
        Effect.fn(function* () {
          const caller = yield* Caller
          yield* store.token.revoke(caller.token.id)
          yield* record("user.logout")
          yield* HttpEffect.appendPreResponseHandler((_request, response) =>
            Effect.succeed(HttpServerResponse.expireCookieUnsafe(response, cookie, { path: "/" })),
          )
          return HttpApiSchema.NoContent.make()
        }),
      )
  }),
)
