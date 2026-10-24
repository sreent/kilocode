import { Clock, Effect } from "effect"
import { HttpEffect, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder, HttpApiSchema } from "effect/unstable/httpapi"
import { Api } from "@organization/protocol/api"
import { InvalidRequestError, NotFoundError } from "@organization/protocol/errors"
import { Caller, Membership } from "@organization/protocol/middleware"
import { can } from "@organization/protocol/roles"
import { instant, type StreamTarget } from "@organization/protocol/schema"
import * as Crypto from "../crypto"
import { ServerConfig } from "../config"
import { charge } from "../pricing"
import { RequestContext } from "../request"
import { Store, type Stream } from "../store"
import { Streams } from "../streams"
import { changed, csv } from "./shared"

const day = 24 * 60 * 60 * 1000

const stream = (row: Stream & { pending: number }) => ({
  id: row.id,
  name: row.name,
  target: row.target,
  headers: row.names,
  enabled: row.enabled,
  pending: row.pending,
  delivered: row.delivered,
  error: row.error,
  failing: row.failing,
  created: row.created,
})

// Collector URLs often carry their token in the path, so audit entries name only the host.
const destination = (target: StreamTarget) =>
  target.kind === "webhook" ? new URL(target.url).host : `${target.host}:${target.port}${target.tls ? " (TLS)" : ""}`

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
  "source",
]

export const InsightHandler = HttpApiBuilder.group(Api, "organization.insight", (handlers) =>
  Effect.gen(function* () {
    const store = yield* Store.Service
    const config = yield* ServerConfig.Service
    const streams = yield* Streams.Service
    const audit = RequestContext.auditor(store, config)

    // Webhook signing secrets and extra headers are sealed at rest, like SSO and gateway secrets.
    const seal = (value: string) =>
      config.secret
        ? Crypto.seal(config.secret, value)
        : Effect.fail(
            new InvalidRequestError({ message: "set ORGANIZATION_SECRET on the server before adding webhook streams" }),
          )
    const sealHeaders = (headers: Record<string, string> | undefined) =>
      headers && Object.keys(headers).length > 0 ? seal(JSON.stringify(headers)) : Effect.succeed(null)

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
        "streams.list",
        Effect.fn(function* () {
          return { streams: (yield* store.stream.list((yield* Membership).org.id)).map(stream) }
        }),
      )
      .handle(
        "streams.create",
        Effect.fn(function* (ctx) {
          const scope = yield* Membership
          const input = ctx.payload
          if (input.target.kind !== "webhook" && input.headers && Object.keys(input.headers).length > 0)
            return yield* new InvalidRequestError({ message: "headers apply to webhook streams only" })
          const secret = input.target.kind === "webhook" ? Crypto.secret(32) : null
          const row = yield* store.stream.create(scope.org.id, {
            name: input.name,
            target: input.target,
            secret: secret ? yield* seal(secret) : null,
            headers: yield* sealHeaders(input.headers),
            names: Object.keys(input.headers ?? {}),
            enabled: input.enabled,
          })
          yield* audit("audit.stream_create", row!.id, {
            name: row!.name,
            kind: row!.target.kind,
            destination: destination(row!.target),
          })
          return { stream: stream({ ...row!, pending: 0 }), secret }
        }),
      )
      .handle(
        "streams.update",
        Effect.fn(function* (ctx) {
          const scope = yield* Membership
          const current = yield* store.stream.get(scope.org.id, ctx.params.id)
          if (!current) return yield* new NotFoundError({ message: "stream not found" })
          const patch = ctx.payload
          const target = patch.target ?? current.target
          // A webhook's signing secret is issued once, at creation.
          if (target.kind !== current.target.kind)
            return yield* new InvalidRequestError({ message: "create a new stream to change its kind" })
          if (target.kind !== "webhook" && patch.headers && Object.keys(patch.headers).length > 0)
            return yield* new InvalidRequestError({ message: "headers apply to webhook streams only" })
          const row = yield* store.stream.update(scope.org.id, current.id, {
            ...(patch.name !== undefined && { name: patch.name }),
            ...(patch.target !== undefined && { target: patch.target }),
            ...(patch.enabled !== undefined && { enabled: patch.enabled }),
            ...(patch.headers !== undefined && {
              headers: yield* sealHeaders(patch.headers),
              names: Object.keys(patch.headers),
            }),
          })
          yield* audit("audit.stream_update", current.id, {
            changed: changed(
              { name: current.name, target: current.target, enabled: current.enabled, headers: current.names },
              { name: row!.name, target: row!.target, enabled: row!.enabled, headers: row!.names },
            ),
            destination: destination(row!.target),
            headers_replaced: patch.headers !== undefined,
          })
          return stream({ ...row!, pending: yield* store.stream.pending(row!) })
        }),
      )
      .handle(
        "streams.remove",
        Effect.fn(function* (ctx) {
          const scope = yield* Membership
          const current = yield* store.stream.get(scope.org.id, ctx.params.id)
          if (!current || !(yield* store.stream.remove(scope.org.id, current.id)))
            return yield* new NotFoundError({ message: "stream not found" })
          yield* audit("audit.stream_remove", current.id, {
            name: current.name,
            destination: destination(current.target),
          })
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "streams.test",
        Effect.fn(function* (ctx) {
          const scope = yield* Membership
          const current = yield* store.stream.get(scope.org.id, ctx.params.id)
          if (!current) return yield* new NotFoundError({ message: "stream not found" })
          return yield* streams.test(scope.org, current)
        }),
      )
      .handle(
        "usage.ingest",
        Effect.fn(function* (ctx) {
          const scope = yield* Membership
          const caller = yield* Caller
          // Never trust a client clock to push spend outside the current budget window.
          const limit = (yield* Clock.currentTimeMillis) + day
          // The gateway meters its providers' calls itself; a client's own report of them would count twice.
          const routed = new Set((yield* store.gateway.list(scope.org.id)).map((row) => row.id))
          // Clients price calls at catalog rates; the org's own prices replace them.
          const prices = yield* store.price.list(scope.org.id)
          const rule = (provider: string, model: string) =>
            prices.find((item) => item.provider === provider && item.model === model) ??
            prices.find((item) => item.provider === provider && item.model === "*")
          const accepted = yield* store.usage.record(
            scope.org.id,
            caller.user.id,
            ctx.payload.records
              .filter((row) => !routed.has(row.provider))
              .map((row) => {
                const tokens = {
                  input: row.tokens.input,
                  output: row.tokens.output,
                  reasoning: row.tokens.reasoning,
                  read: row.tokens.cache.read,
                  write: row.tokens.cache.write,
                }
                return {
                  id: row.id,
                  at: Math.min(row.at, limit),
                  session: row.session,
                  project: row.project,
                  provider: row.provider,
                  model: row.model,
                  ...tokens,
                  cost: charge({ rule: rule(row.provider, row.model), listed: row.cost, tokens }),
                }
              }),
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
