import { Clock, Effect } from "effect"
import { HttpEffect, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "@enterprise/protocol/api"
import { Caller, Membership } from "@enterprise/protocol/middleware"
import { can } from "@enterprise/protocol/roles"
import { instant } from "@enterprise/protocol/schema"
import { Store } from "../store"
import { csv } from "./shared"

const day = 24 * 60 * 60 * 1000

const actions = (value: string | undefined) =>
  value
    ?.split(",")
    .map((item) => item.trim())
    .filter(Boolean)

const attachment = (name: string) =>
  HttpEffect.appendPreResponseHandler((_request, response) =>
    Effect.succeed(HttpServerResponse.setHeader(response, "content-disposition", `attachment; filename="${name}"`)),
  )

const usageColumns = [
  "id",
  "at",
  "email",
  "session",
  "project",
  "provider",
  "model",
  "input",
  "output",
  "reasoning",
  "cache_read",
  "cache_write",
  "cost",
]

export const InsightHandler = HttpApiBuilder.group(Api, "enterprise.insight", (handlers) =>
  Effect.gen(function* () {
    const store = yield* Store.Service

    const range = Effect.fn(function* (query: { from?: string; to?: string }) {
      const now = yield* Clock.currentTimeMillis
      return { from: instant(query.from, now - 30 * day), to: instant(query.to, now + 1) }
    })

    return handlers
      .handle(
        "audit.list",
        Effect.fn(function* (ctx) {
          const scope = yield* Membership
          const events = yield* store.audit.query({
            org: scope.org.id,
            actions: actions(ctx.query.action),
            actor: ctx.query.actor,
            from: ctx.query.from ? instant(ctx.query.from, 0) : undefined,
            to: ctx.query.to ? instant(ctx.query.to, 0) : undefined,
            before: ctx.query.before,
            limit: Math.min(Math.max(ctx.query.limit || 100, 1), 1000),
          })
          return { events, next: events.at(-1)?.id ?? null }
        }),
      )
      .handle(
        "audit.export",
        Effect.fn(function* (ctx) {
          const scope = yield* Membership
          const events = yield* store.audit.query({
            org: scope.org.id,
            actions: actions(ctx.query.action),
            actor: ctx.query.actor,
            from: ctx.query.from ? instant(ctx.query.from, 0) : undefined,
            to: ctx.query.to ? instant(ctx.query.to, 0) : undefined,
            limit: 100_000,
          })
          yield* attachment(`audit-${scope.org.slug}.csv`)
          return csv(
            events.map((row) => ({ ...row, at: new Date(row.at).toISOString() })),
            ["id", "at", "action", "email", "target", "details", "ip"],
          )
        }),
      )
      .handle(
        "usage.ingest",
        Effect.fn(function* (ctx) {
          const scope = yield* Membership
          const caller = yield* Caller
          // Never trust a client clock to push spend outside the current budget window.
          const limit = (yield* Clock.currentTimeMillis) + day
          const accepted = yield* store.usage.record(
            scope.org.id,
            caller.user.id,
            ctx.payload.records.map((row) => ({
              id: row.id,
              at: Math.min(row.at, limit),
              session: row.session,
              project: row.project,
              provider: row.provider,
              model: row.model,
              input: row.tokens.input,
              output: row.tokens.output,
              reasoning: row.tokens.reasoning,
              read: row.tokens.cache.read,
              write: row.tokens.cache.write,
              cost: row.cost,
            })),
          )
          return { accepted }
        }),
      )
      .handle(
        "usage.summary",
        Effect.fn(function* (ctx) {
          const scope = yield* Membership
          const caller = yield* Caller
          const by = ctx.query.by ?? "user"
          // Without usage.read a member only ever sees their own usage.
          const user = can(scope.role, "usage.read") ? ctx.query.user : caller.user.id
          const window = yield* range(ctx.query)
          return { by, ...window, rows: yield* store.usage.summary({ org: scope.org.id, by, user, ...window }) }
        }),
      )
      .handle(
        "usage.export",
        Effect.fn(function* (ctx) {
          const scope = yield* Membership
          const rows = yield* store.usage.rows({ org: scope.org.id, ...(yield* range(ctx.query)) })
          yield* attachment(`usage-${scope.org.slug}.csv`)
          return csv(
            rows.map((row) => ({ ...row, at: new Date(Number(row.at)).toISOString() })),
            usageColumns,
          )
        }),
      )
  }),
)
