export * as Reports from "./reports"

import { Clock, Context, Effect, Layer } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { dollars } from "@organization/protocol/match"
import { Analytics } from "./analytics"
import * as Crypto from "./crypto"
import { ServerConfig } from "./config"
import { httpClient } from "./oidc"
import { Store, type Org, type Report } from "./store"
import { DeliveryError, signature } from "./streams"

// Summaries of an org's AI use, posted after each week (Monday to Sunday) or month, in UTC. A report
// goes out an hour after its period ends, so usage that offline clients report late still counts.

type Cadence = Report["cadence"]

const day = 24 * 60 * 60 * 1000
const grace = 60 * 60 * 1000
const lease = 60_000
// A failed delivery is tried again this much later, until the next period's report replaces it.
const retry = 15 * 60_000

const interval = (cadence: Cadence) => (cadence === "weekly" ? "week" : "month")

// The last whole period before a time.
export function period(cadence: Cadence, time: number) {
  const to = Analytics.floor(interval(cadence), time)
  return { from: Analytics.floor(interval(cadence), to - 1), to }
}

// When the first report after a time is due.
export function due(cadence: Cadence, time: number) {
  const boundary = Analytics.floor(interval(cadence), time)
  return boundary + grace > time ? boundary + grace : Analytics.step(interval(cadence), boundary) + grace
}

// How a figure moved since the period before, when there is one to compare with.
const change = (now: number, before: number, unit: string) =>
  before === 0
    ? ""
    : ` (${now >= before ? "up" : "down"} ${Math.round((Math.abs(now - before) / before) * 100)}% on the ${unit} before)`

const label = (cadence: Cadence, range: { from: number; to: number }) => {
  if (cadence === "monthly")
    return new Intl.DateTimeFormat("en", { month: "long", year: "numeric", timeZone: "UTC" }).format(range.from)
  const date = (time: number) =>
    new Intl.DateTimeFormat("en", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(time)
  return `${date(range.from)} to ${date(range.to - day)}`
}

export type Summary = Effect.Success<ReturnType<Interface["summary"]>>

// The message chat tools show: Slack, Mattermost and Google Chat incoming webhooks take { text }.
export function text(summary: Summary) {
  const top = (items: ReadonlyArray<{ key: string; cost: number }>) =>
    items.map((item) => `${item.key} (${dollars(item.cost)})`).join(", ")
  const unit = summary.period.cadence === "weekly" ? "week" : "month"
  return [
    `*${summary.org.name}: AI use, ${label(summary.period.cadence, summary.period)}*`,
    `${dollars(summary.spend)} spent${change(summary.spend, summary.previous.spend, unit)}, ` +
      `${summary.requests.toLocaleString("en")} ${summary.requests === 1 ? "request" : "requests"}. ` +
      `${summary.people.active} of ${summary.people.members} members used Kilo` +
      (summary.people.new > 0 ? `, ${summary.people.new} for the first time.` : "."),
    ...(summary.models.length > 0 ? [`Top models: ${top(summary.models)}`] : []),
    ...(summary.spenders.length > 0 ? [`Top spenders: ${top(summary.spenders)}`] : []),
  ].join("\n")
}

export interface Interface {
  // What a report says about a period.
  readonly summary: (
    org: Pick<Org, "id" | "slug" | "name">,
    cadence: Cadence,
    range: { from: number; to: number },
  ) => Effect.Effect<{
    org: { id: string; slug: string; name: string }
    period: { cadence: Cadence; from: number; to: number }
    spend: number
    requests: number
    tokens: number
    people: { members: number; active: number; new: number }
    previous: { spend: number; requests: number; active: number }
    models: ReadonlyArray<{ key: string; requests: number; cost: number }>
    spenders: ReadonlyArray<{ key: string; requests: number; cost: number }>
  }>
  // Sends every due report once; the server runs it every few minutes.
  readonly run: () => Effect.Effect<void>
  // Sends a report for its last whole period now, without moving its schedule.
  readonly send: (org: Org, row: Report) => Effect.Effect<{ ok: boolean; error: string | null }>
}

export class Service extends Context.Service<Service, Interface>()("@organization/Reports") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const store = yield* Store.Service
    const config = yield* ServerConfig.Service
    const http = yield* HttpClient.HttpClient

    const summary: Interface["summary"] = Effect.fn("Reports.summary")(function* (org, cadence, range) {
      const before = { from: range.from - (range.to - range.from), to: range.from }
      const totals = yield* store.analytics.totals({ org: org.id, ...range })
      const earlier = yield* store.analytics.totals({ org: org.id, ...before })
      const models = yield* store.usage.summary({ org: org.id, by: "model", ...range })
      const people = yield* store.usage.summary({ org: org.id, by: "user", ...range })
      const top = (rows: typeof models) =>
        rows.slice(0, 5).map((row) => ({ key: row.key, requests: row.requests, cost: row.cost }))
      return {
        org: { id: org.id, slug: org.slug, name: org.name },
        period: { cadence, ...range },
        spend: totals.cost,
        requests: totals.requests,
        tokens: models.reduce(
          (sum, row) => sum + row.input + row.output + row.reasoning + row.cache_read + row.cache_write,
          0,
        ),
        people: { members: yield* store.analytics.members(org.id), active: totals.active, new: totals.new },
        previous: { spend: earlier.cost, requests: earlier.requests, active: earlier.active },
        models: top(models),
        spenders: top(people),
      }
    })

    const deliver = Effect.fn("Reports.deliver")(function* (
      org: Org,
      row: Report,
      range: { from: number; to: number },
    ) {
      if (!config.secret)
        return yield* new DeliveryError({
          message: "the signing secret cannot be read: ORGANIZATION_SECRET is not set",
        })
      const secret = yield* Crypto.unseal(config.secret, row.secret).pipe(
        Effect.mapError(() => new DeliveryError({ message: "the signing secret cannot be read; recreate the report" })),
      )
      const content = yield* summary(org, row.cadence, range)
      const body = JSON.stringify(row.format === "text" ? { text: text(content) } : content)
      const time = Math.floor((yield* Clock.currentTimeMillis) / 1000)
      const request = HttpClientRequest.post(row.url).pipe(
        HttpClientRequest.setHeaders({
          "user-agent": "kilo-organization",
          "x-org-delivery": crypto.randomUUID(),
          "x-org-signature": `t=${time},v1=${signature(secret, time, body)}`,
        }),
        HttpClientRequest.bodyText(body, "application/json"),
      )
      // Never follow redirects: the destination is what the admin configured, nothing else.
      const response = yield* http.execute(request).pipe(
        Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
        Effect.timeout("15 seconds"),
        Effect.mapError((error) => new DeliveryError({ message: `webhook: ${error.message}` })),
      )
      if (response.status < 200 || response.status >= 300)
        return yield* new DeliveryError({ message: `webhook: HTTP ${response.status}` })
    })

    const reason = (cause: unknown) => (cause instanceof DeliveryError ? cause.message : "delivery failed")

    const attempt = Effect.fn("Reports.attempt")(function* (row: Report) {
      const time = yield* Clock.currentTimeMillis
      const org = yield* store.org.get(row.org)
      if (!org) return
      const exit = yield* deliver(org, row, period(row.cadence, time)).pipe(Effect.exit)
      if (exit._tag === "Success") return yield* store.report.sent(row.id, due(row.cadence, time))
      const error = reason(exit.cause.reasons.find((item) => item._tag === "Fail")?.error)
      yield* store.report.failed(row.id, error, time + retry)
      yield* Effect.logWarning("report delivery failed").pipe(
        Effect.annotateLogs({ org: org.slug, report: row.id, error }),
      )
    })

    // Runs forever on a schedule, so nothing may escape it: one report's defect must not stop the rest.
    const logged = (report: string) =>
      Effect.catchCause((cause) =>
        Effect.logError("report delivery crashed").pipe(Effect.annotateLogs({ report, cause: String(cause) })),
      )
    const run = Effect.fn("Reports.run")(function* () {
      const claimed = yield* store.report.claim(lease)
      yield* Effect.forEach(claimed, (row) => attempt(row).pipe(logged(row.id)), { concurrency: 4, discard: true })
    }, logged("*"))

    const send = Effect.fn("Reports.send")(function* (org: Org, row: Report) {
      const exit = yield* deliver(org, row, period(row.cadence, yield* Clock.currentTimeMillis)).pipe(Effect.exit)
      if (exit._tag === "Success") return { ok: true, error: null }
      return { ok: false, error: reason(exit.cause.reasons.find((item) => item._tag === "Fail")?.error) }
    })

    return Service.of({ summary, run, send })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [Store.node, ServerConfig.node, httpClient],
})
