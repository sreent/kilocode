import { Clock, Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "@organization/protocol/api"
import { ConflictError, InvalidRequestError } from "@organization/protocol/errors"
import { Caller, Membership } from "@organization/protocol/middleware"
import { ServerConfig } from "../config"
import { RequestContext } from "../request"
import { Store } from "../store"
import { changed, monthStart, view } from "./shared"

export const OrgHandler = HttpApiBuilder.group(Api, "organization.org", (handlers) =>
  Effect.gen(function* () {
    const store = yield* Store.Service
    const config = yield* ServerConfig.Service
    const audit = RequestContext.auditor(store, config)

    return handlers
      .handle(
        "org.get",
        Effect.fn(function* () {
          const scope = yield* Membership
          const seats = yield* store.seats.usage(scope.org.id)
          return {
            org: view(scope.org),
            role: scope.role,
            inherited: scope.inherited,
            seats: { limit: seats.limit, used: seats.used },
          }
        }),
      )
      .handle(
        "org.update",
        Effect.fn(function* (ctx) {
          const scope = yield* Membership
          if (ctx.payload.seats !== undefined && scope.org.parent)
            return yield* new InvalidRequestError({
              message: "seats are set on the parent organization, and cover its sub-organizations",
            })
          const after = view(yield* store.org.update(scope.org.id, ctx.payload))
          yield* audit("organization.settings_change", scope.org.id, { changed: changed(view(scope.org), after) })
          return { org: after }
        }),
      )
      .handle(
        "suborgs.list",
        Effect.fn(function* () {
          const scope = yield* Membership
          const month = monthStart(yield* Clock.currentTimeMillis)
          const children = yield* store.org.children(scope.org.id)
          const suborgs = yield* Effect.forEach(children, (org) =>
            Effect.all({
              members: store.member.list(org.id),
              spent: store.usage.spent({ orgs: [org.id], from: month }),
            }).pipe(Effect.map((stats) => ({ ...view(org), members: stats.members.length, spent: stats.spent }))),
          )
          return { suborgs }
        }),
      )
      .handle(
        "suborgs.create",
        // Sub-organizations are one level deep.
        Effect.fn(function* (ctx) {
          const scope = yield* Membership
          const caller = yield* Caller
          if (scope.org.parent)
            return yield* new InvalidRequestError({
              message: "sub-organizations cannot have their own sub-organizations",
            })
          if (yield* store.org.get(ctx.payload.slug)) return yield* new ConflictError({ message: "this slug is taken" })
          const child = yield* store.org.create({
            name: ctx.payload.name,
            slug: ctx.payload.slug,
            parent: scope.org.id,
          })
          const details = { name: child.name, slug: child.slug, parent: scope.org.id }
          yield* audit("organization.create", child.id, details)
          yield* store.audit.record({
            org: child.id,
            action: "organization.create",
            actor: { id: caller.user.id, email: caller.user.email },
            target: child.id,
            details,
          })
          return { org: view(child) }
        }),
      )
  }),
)
