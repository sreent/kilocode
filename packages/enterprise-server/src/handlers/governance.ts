import { Effect } from "effect"
import { HttpEffect, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder, HttpApiSchema } from "effect/unstable/httpapi"
import { Api } from "@enterprise/protocol/api"
import { ConflictError, InvalidRequestError, NotFoundError } from "@enterprise/protocol/errors"
import { Caller, Membership } from "@enterprise/protocol/middleware"
import * as Crypto from "../crypto"
import { effective } from "../policy"
import { ServerConfig } from "../config"
import { RequestContext } from "../request"
import { Store } from "../store"
import { changed, delta } from "./shared"

export const GovernanceHandler = HttpApiBuilder.group(Api, "enterprise.governance", (handlers) =>
  Effect.gen(function* () {
    const store = yield* Store.Service
    const config = yield* ServerConfig.Service
    const audit = RequestContext.auditor(store, config)

    const headers = (values: Record<string, string>) =>
      HttpEffect.appendPreResponseHandler((_request, response) =>
        Effect.succeed(HttpServerResponse.setHeaders(response, values)),
      )

    return handlers
      .handle(
        "policy.get",
        Effect.fn(function* () {
          return yield* store.policy.get((yield* Membership).org.id)
        }),
      )
      .handle(
        "policy.update",
        Effect.fn(function* (ctx) {
          const scope = yield* Membership
          const caller = yield* Caller
          const before = (yield* store.policy.get(scope.org.id)).policy
          const after = yield* store.policy.set(scope.org.id, ctx.payload, caller.user.id)
          yield* audit("policy.update", scope.org.id, {
            version: after.version,
            changed: changed(before, after.policy),
            blocked: delta(before.models.blocked, after.policy.models.blocked),
          })
          return after
        }),
      )
      .handle(
        "policy.effective",
        // What a client enforces for the calling user. Clients poll it; the etag turns an unchanged
        // policy into an empty 304.
        Effect.fn(function* (ctx) {
          const scope = yield* Membership
          const caller = yield* Caller
          const policy = yield* effective(store, { org: scope.org, user: caller.user, role: scope.role })
          const etag = `"${Crypto.hash(JSON.stringify(policy)).slice(0, 32)}"`
          yield* headers({ etag, "cache-control": "private, no-cache" })
          if (ctx.headers["if-none-match"] === etag) return undefined
          return { ...policy, etag }
        }),
      )
      .handle(
        "modes.list",
        Effect.fn(function* () {
          return { modes: yield* store.mode.list((yield* Membership).org.id) }
        }),
      )
      .handle(
        "modes.create",
        Effect.fn(function* (ctx) {
          const scope = yield* Membership
          if (yield* store.mode.get(scope.org.id, ctx.payload.slug))
            return yield* new ConflictError({ message: "a mode with this slug exists" })
          const row = yield* store.mode.save(scope.org.id, ctx.payload)
          yield* audit("custom_mode.create", row.id, { slug: row.slug, name: row.name })
          return row
        }),
      )
      .handle(
        "modes.update",
        Effect.fn(function* (ctx) {
          const scope = yield* Membership
          const current = yield* store.mode.get(scope.org.id, ctx.params.id)
          if (!current) return yield* new NotFoundError({ message: "mode not found" })
          const clash = yield* store.mode.get(scope.org.id, ctx.payload.slug)
          if (clash && clash.id !== current.id)
            return yield* new ConflictError({ message: "a mode with this slug exists" })
          const row = yield* store.mode.save(scope.org.id, ctx.payload, current.id)
          yield* audit("custom_mode.update", row.id, { slug: row.slug, changed: changed(current, row) })
          return row
        }),
      )
      .handle(
        "modes.remove",
        Effect.fn(function* (ctx) {
          const scope = yield* Membership
          const current = yield* store.mode.get(scope.org.id, ctx.params.id)
          if (!current) return yield* new NotFoundError({ message: "mode not found" })
          yield* store.mode.remove(scope.org.id, current.id)
          yield* audit("custom_mode.delete", current.id, { slug: current.slug })
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "budgets.get",
        Effect.fn(function* () {
          return { budgets: yield* store.budget.list((yield* Membership).org.id) }
        }),
      )
      .handle(
        "budgets.update",
        Effect.fn(function* (ctx) {
          const scope = yield* Membership
          const rows = ctx.payload.budgets.map((row) => ({ ...row, target: row.scope === "user" ? row.target : "" }))
          // Two limits for the same people and period would be ambiguous (and collide in storage).
          if (new Set(rows.map((row) => `${row.scope}/${row.target}/${row.period}`)).size !== rows.length)
            return yield* new InvalidRequestError({ message: "budgets must differ in scope, target or period" })
          for (const row of rows)
            if (row.scope === "user" && !(yield* store.member.get(scope.org.id, row.target)))
              return yield* new InvalidRequestError({ message: `not a member: ${row.target}` })
          const before = yield* store.budget.list(scope.org.id)
          yield* store.budget.replace(scope.org.id, rows)
          yield* audit("budget.update", scope.org.id, { before, after: rows })
          return { budgets: yield* store.budget.list(scope.org.id) }
        }),
      )
  }),
)
