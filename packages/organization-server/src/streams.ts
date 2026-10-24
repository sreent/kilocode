export * as Streams from "./streams"

import { Clock, Context, Effect, Layer, Option, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"
import net from "node:net"
import tls from "node:tls"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import * as Crypto from "./crypto"
import { ServerConfig } from "./config"
import { httpClient } from "./oidc"
import { Store, type Audit, type Org, type Stream } from "./store"

// Delivers audit events to each org's streams: signed JSON webhooks, RFC 5424 syslog over TCP or
// TLS, or OpenTelemetry logs over OTLP/HTTP. Delivery is at least once, in order, and resumes from
// the last event a destination accepted. Events carry their audit id, so receivers can drop the
// rare duplicate.

// Events per delivery, and how long a delivery may hold its stream before another worker may retry it.
const batch = 200
const lease = 60_000
const timeout = "15 seconds"

export class DeliveryError extends Schema.TaggedErrorClass<DeliveryError>()("DeliveryError", {
  message: Schema.String,
}) {}

// One event as destinations receive it: the audit API's shape plus a readable timestamp.
export function view(row: Audit) {
  return {
    id: row.id,
    org: row.org,
    at: row.at,
    time: new Date(row.at).toISOString(),
    action: row.action,
    actor: row.actor,
    email: row.email,
    target: row.target,
    details: row.details,
    ip: row.ip,
  }
}

// Receivers recompute it over "<t>.<body>" with the stream's secret, and reject stale timestamps.
export function signature(secret: string, time: number, body: string) {
  return new Bun.CryptoHasher("sha256", secret).update(`${time}.${body}`).digest("hex")
}

// RFC 5424: facility 13 (log audit), severity 6 (informational). MSGID is printable ASCII, at
// most 32 characters; the message is the event as JSON.
export function syslog(host: string, event: ReturnType<typeof view>) {
  const id = event.action.replace(/[^!-~]/g, "_").slice(0, 32) || "-"
  return `<110>1 ${event.time} ${host} kilo-organization - ${id} - ${JSON.stringify(event)}`
}

// OTLP/HTTP with JSON encoding: one resource for the org, one scope for its audit log, one log record
// per event, its body the event as JSON. 64-bit integers are decimal strings, as the protobuf JSON
// mapping requires. https://opentelemetry.io/docs/specs/otlp/#json-protobuf-encoding
export function otlp(org: Pick<Org, "id" | "slug" | "name">, events: ReadonlyArray<ReturnType<typeof view>>) {
  const text = (value: string) => ({ stringValue: value })
  const attribute = (key: string, value: string | number | null) =>
    value === null ? [] : [{ key, value: typeof value === "number" ? { intValue: String(value) } : text(value) }]
  return {
    resourceLogs: [
      {
        resource: {
          attributes: [
            { key: "service.name", value: text("kilo-organization") },
            { key: "kilo.org.id", value: text(org.id) },
            { key: "kilo.org.slug", value: text(org.slug) },
            { key: "kilo.org.name", value: text(org.name) },
          ],
        },
        scopeLogs: [
          {
            scope: { name: "kilo.organization.audit" },
            logRecords: events.map((event) => ({
              timeUnixNano: String(BigInt(event.at) * 1_000_000n),
              severityNumber: 9,
              severityText: "INFO",
              body: text(JSON.stringify(event)),
              attributes: [
                ...attribute("event.name", event.action),
                ...attribute("kilo.audit.id", event.id),
                ...attribute("user.id", event.actor),
                ...attribute("user.email", event.email),
                ...attribute("kilo.audit.target", event.target),
                ...attribute("client.address", event.ip),
              ],
            })),
          },
        ],
      },
    ],
  }
}

// How an OTLP collector says it kept a batch but refused some of its records. Resending them would
// not help, so the batch counts as delivered and the refusal is logged.
const Partial = Schema.Struct({
  partialSuccess: Schema.Struct({
    rejectedLogRecords: Schema.optional(Schema.Union([Schema.String, Schema.Number])),
    errorMessage: Schema.optional(Schema.String),
  }),
})
const partial = Schema.decodeUnknownOption(Partial)

// RFC 6587 octet counting, so a message can never be split or merged by the receiver.
const frame = (message: string) => `${Buffer.byteLength(message)} ${message}`

function send(target: { host: string; port: number; tls: boolean }, messages: ReadonlyArray<string>) {
  return Effect.callback<void, DeliveryError>((resume) => {
    const payload = messages.map(frame).join("")
    const socket = target.tls
      ? tls.connect({
          host: target.host,
          port: target.port,
          servername: net.isIP(target.host) ? undefined : target.host,
        })
      : net.connect({ host: target.host, port: target.port })
    const fail = (error: Error) => {
      socket.destroy()
      resume(Effect.fail(new DeliveryError({ message: `syslog ${target.host}:${target.port}: ${error.message}` })))
    }
    socket.setTimeout(15_000, () => fail(new Error("timed out")))
    socket.once("error", fail)
    socket.once(target.tls ? "secureConnect" : "connect", () =>
      socket.end(payload, () => {
        socket.destroy()
        resume(Effect.void)
      }),
    )
    return Effect.sync(() => socket.destroy())
  })
}

export interface Interface {
  // Delivers every due stream's pending events once; the server runs it every few seconds.
  readonly run: () => Effect.Effect<void>
  // Sends one synthetic event to a stream, without touching its delivery state.
  readonly test: (org: Org, row: Stream) => Effect.Effect<{ ok: boolean; error: string | null }>
}

export class Service extends Context.Service<Service, Interface>()("@organization/Streams") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const store = yield* Store.Service
    const config = yield* ServerConfig.Service
    const http = yield* HttpClient.HttpClient
    const host = new URL(config.base).hostname

    const open = (value: string | null) =>
      value && config.secret ? Crypto.unseal(config.secret, value) : Effect.succeed(undefined)

    const deliver = Effect.fn("Streams.deliver")(function* (
      org: Pick<Org, "id" | "slug" | "name">,
      row: Stream,
      events: ReadonlyArray<ReturnType<typeof view>>,
    ) {
      const target = row.target
      if (target.kind === "syslog")
        return yield* send(
          target,
          events.map((event) => syslog(host, event)),
        )
      const headers = JSON.parse((yield* open(row.headers)) ?? "{}") as Record<string, string>
      // OTLP endpoints authenticate with headers of their own; webhooks are also signed.
      const signed = yield* Effect.gen(function* () {
        if (target.kind === "otlp") return { body: JSON.stringify(otlp(org, events)), headers: {} }
        const secret = yield* open(row.secret)
        if (!secret)
          return yield* new DeliveryError({ message: "the signing secret cannot be read; recreate the stream" })
        const body = JSON.stringify({ org: { id: org.id, slug: org.slug, name: org.name }, events })
        const time = Math.floor((yield* Clock.currentTimeMillis) / 1000)
        return {
          body,
          headers: {
            "x-org-delivery": crypto.randomUUID(),
            "x-org-signature": `t=${time},v1=${signature(secret, time, body)}`,
          },
        }
      })
      const request = HttpClientRequest.post(target.url).pipe(
        HttpClientRequest.setHeaders({ ...headers, "user-agent": "kilo-organization", ...signed.headers }),
        HttpClientRequest.bodyText(signed.body, "application/json"),
      )
      // Never follow redirects: the destination is what the admin configured, nothing else.
      const response = yield* http.execute(request).pipe(
        Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
        Effect.timeout(timeout),
        Effect.mapError((error) => new DeliveryError({ message: `${target.kind}: ${error.message}` })),
      )
      if (response.status < 200 || response.status >= 300)
        return yield* new DeliveryError({ message: `${target.kind}: HTTP ${response.status}` })
      if (target.kind === "otlp") {
        const body = yield* response.json.pipe(
          Effect.timeout("5 seconds"),
          Effect.orElseSucceed(() => ({})),
        )
        const reply = Option.getOrUndefined(partial(body))?.partialSuccess
        const rejected = Number(reply?.rejectedLogRecords ?? 0)
        if (rejected > 0)
          yield* Effect.logWarning("OTLP collector refused audit records").pipe(
            Effect.annotateLogs({ org: org.slug, stream: row.id, rejected, error: reply?.errorMessage ?? "" }),
          )
      }
    })

    const attempt = Effect.fn("Streams.attempt")(function* (due: Stream) {
      const row = yield* store.stream.claim(due.id, lease)
      if (!row) return
      const org = yield* store.org.get(row.org)
      const events = (yield* store.stream.events(row, batch)).map(view)
      if (!org || events.length === 0) return yield* store.stream.delivered(row.id, row.cursor)
      const exit = yield* deliver(org, row, events).pipe(Effect.exit)
      if (exit._tag === "Success") return yield* store.stream.delivered(row.id, events.at(-1)!.id)
      const error = exit.cause.reasons.find((reason) => reason._tag === "Fail")?.error
      const message = error instanceof DeliveryError ? error.message : "delivery failed"
      // 5 s, 10 s, 20 s ... capped at 5 minutes between attempts.
      const wait = Math.min(5 * 60_000, 5_000 * 2 ** Math.min(row.failures, 10))
      yield* store.stream.failed(row.id, message, (yield* Clock.currentTimeMillis) + wait)
      if (row.failures === 0)
        yield* Effect.logWarning("audit stream delivery failing").pipe(
          Effect.annotateLogs({ org: org.slug, stream: row.id, error: message }),
        )
    })

    // Runs forever on a schedule, so nothing may escape it: one stream's defect must not stop the rest.
    const logged = (stream: string) =>
      Effect.catchCause((cause) =>
        Effect.logError("audit stream delivery crashed").pipe(Effect.annotateLogs({ stream, cause: String(cause) })),
      )
    const run = Effect.fn("Streams.run")(function* () {
      const due = yield* store.stream.due()
      yield* Effect.forEach(due, (row) => attempt(row).pipe(logged(row.id)), { concurrency: 4, discard: true })
    }, logged("*"))

    const test = Effect.fn("Streams.test")(function* (org: Org, row: Stream) {
      const time = yield* Clock.currentTimeMillis
      const event = {
        id: 0,
        org: org.id,
        at: time,
        time: new Date(time).toISOString(),
        action: "audit.stream_test",
        actor: null,
        email: null,
        target: row.id,
        details: { message: "Test event from Kilo Organization. It is not part of the audit log." },
        ip: null,
      }
      const exit = yield* deliver(org, row, [event]).pipe(Effect.exit)
      if (exit._tag === "Success") return { ok: true, error: null }
      const error = exit.cause.reasons.find((reason) => reason._tag === "Fail")?.error
      return { ok: false, error: error instanceof DeliveryError ? error.message : "delivery failed" }
    })

    return Service.of({ run, test })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [Store.node, ServerConfig.node, httpClient],
})
