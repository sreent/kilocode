import { Clock, Effect } from "effect"
import { HttpEffect, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder, HttpApiSchema } from "effect/unstable/httpapi"
import { Api } from "@organization/protocol/api"
import { InvalidRequestError, NotFoundError } from "@organization/protocol/errors"
import { Caller, Membership } from "@organization/protocol/middleware"
import { can } from "@organization/protocol/roles"
import { instant, type Activity, type Interval, type StreamTarget } from "@organization/protocol/schema"
import { Analytics } from "../analytics"
import * as Crypto from "../crypto"
import { ServerConfig } from "../config"
import { charge } from "../pricing"
import { RequestContext } from "../request"
import { Reports } from "../reports"
import { Store, type Report, type Stream } from "../store"
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

const report = (row: Report) => ({
  id: row.id,
  name: row.name,
  cadence: row.cadence,
  format: row.format,
  url: row.url,
  enabled: row.enabled,
  next: row.next,
  sent: row.sent,
  error: row.error,
  created: row.created,
})

const none: Activity = { active: 0, requests: 0, cost: 0, tokens: 0 }

// Charts stay legible: past this many intervals, a longer interval has to be asked for.
const intervals = 1000

// Collector URLs often carry their token in the path, so audit entries name only the host.
const destination = (target: StreamTarget) =>
  target.kind === "syslog" ? `${target.host}:${target.port}${target.tls ? " (TLS)" : ""}` : new URL(target.url).host

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
    const reports = yield* Reports.Service
    const audit = RequestContext.auditor(store, config)

    // Webhook signing secrets and extra headers are sealed at rest, like SSO and gateway secrets.
    const seal = (value: string) =>
      config.secret
        ? Crypto.seal(config.secret, value)
        : Effect.fail(
            new InvalidRequestError({
              message: "set ORGANIZATION_SECRET on the server before adding webhooks or stream headers",
            }),
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
          if (input.target.kind === "syslog" && input.headers && Object.keys(input.headers).length > 0)
            return yield* new InvalidRequestError({ message: "headers apply to webhook and OTLP streams only" })
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
          if (target.kind === "syslog" && patch.headers && Object.keys(patch.headers).length > 0)
            return yield* new InvalidRequestError({ message: "headers apply to webhook and OTLP streams only" })
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
        "audit.tools",
        Effect.fn(function* (ctx) {
          const scope = yield* Membership
          const caller = yield* Caller
          // The policy decides what is kept, whatever a client sends: nothing, or no inputs.
          const level = (yield* store.policy.get(scope.org.id)).policy.audit.tools
          if (level === "off") return { accepted: 0 }
          const accepted = yield* store.audit.runs({
            org: scope.org.id,
            actor: { id: caller.user.id, email: caller.user.email },
            ip: yield* RequestContext.address(config),
            runs: ctx.payload.runs.map((run) => ({
              id: run.id,
              at: run.at,
              tool: run.tool,
              details: {
                tool: run.tool,
                outcome: run.outcome,
                duration_ms: run.duration,
                ...(run.session ? { session: run.session } : {}),
                ...(run.project ? { project: run.project } : {}),
                ...(run.subject ? { subject: run.subject } : {}),
                ...(run.error ? { error: run.error } : {}),
                ...(level === "inputs" && run.input ? { input: run.input } : {}),
              },
            })),
          })
          return { accepted }
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
      .handle(
        "analytics.adoption",
        Effect.fn(function* (ctx) {
          const scope = yield* Membership
          const window = yield* range(ctx.query)
          const span = window.to - window.from
          const interval: Interval =
            ctx.query.interval ?? (span > 180 * day ? "month" : span > 45 * day ? "week" : "day")
          const starts = Analytics.buckets(interval, window.from, window.to)
          if (starts.length > intervals)
            return yield* new InvalidRequestError({
              message: `that is ${starts.length} ${interval}s; ask for a shorter range or a longer interval`,
            })
          const org = scope.org.id
          const points = new Map(
            (yield* store.analytics.series({ org, interval, ...window })).map((row) => [row.start, row]),
          )
          const totals = yield* store.analytics.totals({ org, ...window })
          const seats = yield* store.seats.usage(org)
          return {
            ...window,
            interval,
            members: yield* store.analytics.members(org),
            seats: { limit: seats.limit, used: seats.used },
            ...totals,
            series: starts.map(
              (start) => points.get(start) ?? { start, active: 0, new: 0, sessions: 0, requests: 0, cost: 0 },
            ),
            idle: yield* store.analytics.idle({ org, ...window }),
          }
        }),
      )
      .handle(
        "analytics.compare",
        Effect.fn(function* (ctx) {
          const scope = yield* Membership
          const window = yield* range(ctx.query)
          const previous = { from: window.from - (window.to - window.from), to: window.from }
          const input = { org: scope.org.id, by: ctx.query.by }
          const now = yield* store.analytics.compare({ ...input, ...window })
          const then = yield* store.analytics.compare({ ...input, ...previous })
          const key = (row: { id: string | null; key: string }) => row.id ?? row.key
          const earlier = new Map(then.map((row) => [key(row), row]))
          const later = new Map(now.map((row) => [key(row), row]))
          const activity = (row: Activity | undefined) =>
            row ? { active: row.active, requests: row.requests, cost: row.cost, tokens: row.tokens } : none
          // Rows from either range: a model nobody uses any more still shows what it used to cost.
          const rows = [...now, ...then.filter((row) => !later.has(key(row)))].map((row) => ({
            key: row.key,
            id: row.id,
            members: later.get(key(row))?.members ?? row.members,
            current: activity(later.get(key(row))),
            previous: activity(earlier.get(key(row))),
          }))
          return {
            by: ctx.query.by,
            ...window,
            previous,
            rows: rows.toSorted(
              (a, b) =>
                b.current.cost - a.current.cost || b.previous.cost - a.previous.cost || a.key.localeCompare(b.key),
            ),
          }
        }),
      )
      .handle(
        "reports.list",
        Effect.fn(function* () {
          return { reports: (yield* store.report.list((yield* Membership).org.id)).map(report) }
        }),
      )
      .handle(
        "reports.create",
        Effect.fn(function* (ctx) {
          const scope = yield* Membership
          const input = ctx.payload
          const secret = Crypto.secret(32)
          const row = yield* store.report.create(scope.org.id, {
            name: input.name,
            cadence: input.cadence,
            format: input.format,
            url: input.url,
            secret: yield* seal(secret),
            enabled: input.enabled,
            next: Reports.due(input.cadence, yield* Clock.currentTimeMillis),
          })
          yield* audit("report.create", row.id, {
            name: row.name,
            cadence: row.cadence,
            destination: new URL(row.url).host,
          })
          return { report: report(row), secret }
        }),
      )
      .handle(
        "reports.update",
        Effect.fn(function* (ctx) {
          const scope = yield* Membership
          const current = yield* store.report.get(scope.org.id, ctx.params.id)
          if (!current) return yield* new NotFoundError({ message: "report not found" })
          const patch = ctx.payload
          const cadence = patch.cadence ?? current.cadence
          const row = yield* store.report.update(scope.org.id, current.id, {
            ...(patch.name !== undefined && { name: patch.name }),
            ...(patch.format !== undefined && { format: patch.format }),
            ...(patch.url !== undefined && { url: patch.url }),
            ...(patch.enabled !== undefined && { enabled: patch.enabled }),
            // A new cadence, or a report turned back on, starts from the next period.
            ...((cadence !== current.cadence || (patch.enabled && !current.enabled)) && {
              next: Reports.due(cadence, yield* Clock.currentTimeMillis),
            }),
            ...(patch.cadence !== undefined && { cadence: patch.cadence }),
            ...(patch.url !== undefined && { error: null }),
          })
          yield* audit("report.update", current.id, {
            name: row!.name,
            changed: changed(report(current), report(row!)),
            destination: new URL(row!.url).host,
          })
          return report(row!)
        }),
      )
      .handle(
        "reports.remove",
        Effect.fn(function* (ctx) {
          const scope = yield* Membership
          const current = yield* store.report.get(scope.org.id, ctx.params.id)
          if (!current) return yield* new NotFoundError({ message: "report not found" })
          yield* store.report.remove(scope.org.id, current.id)
          yield* audit("report.delete", current.id, { name: current.name })
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "reports.send",
        Effect.fn(function* (ctx) {
          const scope = yield* Membership
          const current = yield* store.report.get(scope.org.id, ctx.params.id)
          if (!current) return yield* new NotFoundError({ message: "report not found" })
          return yield* reports.send(scope.org, current)
        }),
      )
  }),
)
