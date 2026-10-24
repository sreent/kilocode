import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { signature } from "../src/streams"
import { Streams } from "../src/streams"
import { setup, type Env } from "./fixture"

// A SIEM's HTTP collector and a syslog server, recording what they receive.

type Delivery = { headers: Record<string, string>; body: string; events: Array<{ id: number; action: string }> }

const collector = (() => {
  const deliveries: Delivery[] = []
  const state = { status: 200, delay: 0, reply: "" }
  const bun = Bun.serve({
    port: 0,
    async fetch(request) {
      const body = await request.text()
      if (state.delay) await Bun.sleep(state.delay)
      deliveries.push({ headers: Object.fromEntries(request.headers), body, events: JSON.parse(body).events })
      return new Response(state.reply || null, { status: state.status })
    },
  })
  return { url: `http://localhost:${bun.port}/ingest/token-in-path`, deliveries, state, stop: () => bun.stop(true) }
})()

const syslog = (() => {
  const received: string[] = []
  const listener = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      data(_socket, data) {
        received.push(new TextDecoder().decode(data))
      },
    },
  })
  return { port: listener.port, received, stop: () => listener.stop(true) }
})()

afterAll(() => {
  collector.stop()
  syslog.stop()
})

let env: Env
const run = () =>
  env.runtime.runPromise(
    Effect.gen(function* () {
      yield* (yield* Streams.Service).run()
    }),
  )
const streams = (token = env.owner.token) => env.call("GET", "/api/v1/orgs/acme/audit/streams", { token })
const create = (body: unknown, token = env.owner.token) =>
  env.call("POST", "/api/v1/orgs/acme/audit/streams", { token, body })
// An audit event to deliver.
const activity = (name: string) =>
  env.call("POST", "/api/v1/orgs/acme/groups", { token: env.owner.token, body: { name } })

beforeEach(async () => {
  env = await setup()
  collector.deliveries.length = 0
  collector.state.status = 200
  collector.state.delay = 0
  collector.state.reply = ""
  syslog.received.length = 0
})

afterEach(async () => {
  await env.runtime.dispose()
})

describe("webhook streams", () => {
  test("deliver new events in order, signed, with the collector's own headers", async () => {
    const created = await create({
      name: "Splunk",
      target: { kind: "webhook", url: collector.url },
      headers: { authorization: "Splunk hec-token" },
    })
    expect(created.status).toBe(201)
    const secret: string = created.data.secret
    expect(secret.length).toBeGreaterThan(30)
    // The stream starts after the events that already exist; its own creation is the first it sends.
    expect(created.data.stream).toMatchObject({ headers: ["authorization"], enabled: true, pending: 0 })
    await activity("platform")
    await activity("data")
    expect((await streams()).data.streams[0].pending).toBe(3)

    await run()
    expect(collector.deliveries).toHaveLength(1)
    const [delivery] = collector.deliveries
    expect(delivery!.events.map((event) => event.action)).toEqual([
      "audit.stream_create",
      "group.create",
      "group.create",
    ])
    expect(delivery!.events.map((event) => event.id)).toEqual(
      [...delivery!.events.map((event) => event.id)].sort((a, b) => a - b),
    )
    expect(delivery!.headers.authorization).toBe("Splunk hec-token")
    expect(delivery!.headers["content-type"]).toContain("application/json")
    const [, time, digest] = delivery!.headers["x-org-signature"]!.match(/^t=(\d+),v1=([0-9a-f]{64})$/)!
    expect(digest).toBe(signature(secret, Number(time), delivery!.body))
    expect(JSON.parse(delivery!.body).org).toMatchObject({ slug: "acme" })

    const listed = (await streams()).data.streams[0]
    expect(listed).toMatchObject({ pending: 0, error: null, failing: null })
    expect(listed.delivered).toBeGreaterThan(0)
    expect(JSON.stringify(listed)).not.toContain("hec-token")
    await run()
    expect(collector.deliveries).toHaveLength(1)
  })

  test("back off on failure and resume from the last event the collector accepted", async () => {
    await create({ name: "SIEM", target: { kind: "webhook", url: collector.url } })
    collector.state.status = 503
    await run()
    let listed = (await streams()).data.streams[0]
    expect(listed.error).toBe("webhook: HTTP 503")
    expect(listed.failing).toBeGreaterThan(0)
    expect(listed.pending).toBe(1)
    // Waiting out the backoff: nothing is sent until it passes.
    await run()
    expect(collector.deliveries).toHaveLength(1)

    collector.state.status = 200
    await activity("later")
    await env.exec("update audit_streams set retry = 0")
    await run()
    expect(collector.deliveries).toHaveLength(2)
    expect(collector.deliveries[1]!.events.map((event) => event.action)).toEqual([
      "audit.stream_create",
      "group.create",
    ])
    listed = (await streams()).data.streams[0]
    expect(listed).toMatchObject({ pending: 0, error: null, failing: null })
  })

  test("two workers never deliver the same events", async () => {
    await create({ name: "SIEM", target: { kind: "webhook", url: collector.url } })
    collector.state.delay = 150
    await Promise.all([run(), run(), run()])
    expect(collector.deliveries).toHaveLength(1)
  })

  test("a paused stream keeps its place", async () => {
    const id = (await create({ name: "SIEM", target: { kind: "webhook", url: collector.url } })).data.stream.id
    await env.call("PATCH", `/api/v1/orgs/acme/audit/streams/${id}`, {
      token: env.owner.token,
      body: { enabled: false },
    })
    await activity("quiet")
    await run()
    expect(collector.deliveries).toHaveLength(0)
    await env.call("PATCH", `/api/v1/orgs/acme/audit/streams/${id}`, {
      token: env.owner.token,
      body: { enabled: true },
    })
    await run()
    expect(collector.deliveries[0]!.events.map((event) => event.action)).toEqual([
      "audit.stream_create",
      "audit.stream_update",
      "group.create",
      "audit.stream_update",
    ])
  })

  test("a test delivery reports the result without moving the stream", async () => {
    const id = (await create({ name: "SIEM", target: { kind: "webhook", url: collector.url } })).data.stream.id
    const ok = await env.call("POST", `/api/v1/orgs/acme/audit/streams/${id}/test`, { token: env.owner.token })
    expect(ok.data).toEqual({ ok: true, error: null })
    expect(collector.deliveries[0]!.events).toMatchObject([{ id: 0, action: "audit.stream_test" }])
    collector.state.status = 401
    const failed = await env.call("POST", `/api/v1/orgs/acme/audit/streams/${id}/test`, { token: env.owner.token })
    expect(failed.data).toEqual({ ok: false, error: "webhook: HTTP 401" })
    expect((await streams()).data.streams[0]).toMatchObject({ pending: 1, error: null })
  })
})

describe("syslog streams", () => {
  test("send one RFC 5424 message per event, octet-counted", async () => {
    const created = await create({
      name: "rsyslog",
      target: { kind: "syslog", host: "127.0.0.1", port: syslog.port, tls: false },
    })
    expect(created.status).toBe(201)
    expect(created.data.secret).toBeNull()
    await activity("ops")
    await run()
    for (let attempt = 0; attempt < 50 && !syslog.received.join("").includes("group.create"); attempt++)
      await Bun.sleep(10)
    const stream = syslog.received.join("")
    const messages: string[] = []
    for (let rest = stream; rest.length > 0; ) {
      const space = rest.indexOf(" ")
      const length = Number(rest.slice(0, space))
      const bytes = Buffer.from(rest.slice(space + 1))
      messages.push(bytes.subarray(0, length).toString())
      rest = bytes.subarray(length).toString()
    }
    expect(messages).toHaveLength(2)
    expect(messages[1]).toMatch(/^<110>1 \d{4}-\d\d-\d\dT[\d:.]+Z localhost kilo-organization - group\.create - \{/)
    expect(JSON.parse(messages[1]!.slice(messages[1]!.indexOf("{")))).toMatchObject({
      action: "group.create",
      email: "owner@acme.com",
    })
  })

  test("an unreachable server is reported as the stream's error", async () => {
    await create({ name: "down", target: { kind: "syslog", host: "127.0.0.1", port: 9, tls: false } })
    await run()
    expect((await streams()).data.streams[0].error).toContain("syslog 127.0.0.1:9")
  })
})

describe("OTLP streams", () => {
  type Attribute = { key: string; value: { stringValue?: string; intValue?: string } }
  type Record = { timeUnixNano: string; severityText: string; body: { stringValue: string }; attributes: Attribute[] }
  const attributes = (list: Attribute[]) =>
    Object.fromEntries(list.map((item) => [item.key, item.value.stringValue ?? item.value.intValue]))

  test("send OpenTelemetry log records over OTLP/HTTP with the collector's headers, unsigned", async () => {
    const created = await create({
      name: "OTel collector",
      target: { kind: "otlp", url: collector.url },
      headers: { authorization: "Bearer otel-token" },
    })
    expect(created.status).toBe(201)
    expect(created.data.secret).toBeNull()
    await activity("ops")
    await run()

    expect(collector.deliveries).toHaveLength(1)
    const [delivery] = collector.deliveries
    expect(delivery.headers.authorization).toBe("Bearer otel-token")
    expect(delivery.headers["content-type"]).toContain("application/json")
    expect(delivery.headers["x-org-signature"]).toBeUndefined()
    const [resource] = JSON.parse(delivery.body).resourceLogs
    expect(attributes(resource.resource.attributes)).toEqual({
      "service.name": "kilo-organization",
      "kilo.org.id": env.owner.org.id,
      "kilo.org.slug": "acme",
      "kilo.org.name": "Acme",
    })
    expect(resource.scopeLogs[0].scope).toEqual({ name: "kilo.organization.audit" })
    const records: Record[] = resource.scopeLogs[0].logRecords
    expect(records.map((record) => attributes(record.attributes)["event.name"])).toEqual([
      "audit.stream_create",
      "group.create",
    ])
    const event = JSON.parse(records[1].body.stringValue)
    expect(event).toMatchObject({ action: "group.create", email: "owner@acme.com" })
    // Nanoseconds, as a decimal string.
    expect(records[1].timeUnixNano).toBe(`${event.at}000000`)
    expect(records[1].severityText).toBe("INFO")
    expect(attributes(records[1].attributes)).toMatchObject({
      "kilo.audit.id": String(event.id),
      "user.id": env.owner.user.id,
      "user.email": "owner@acme.com",
    })

    // Records a collector keeps the batch but refuses are not sent again.
    collector.state.reply = JSON.stringify({ partialSuccess: { rejectedLogRecords: "1", errorMessage: "too old" } })
    await activity("refused")
    await run()
    expect((await streams()).data.streams[0]).toMatchObject({ pending: 0, error: null })

    collector.state.status = 503
    await activity("later")
    await run()
    expect((await streams()).data.streams[0]).toMatchObject({ pending: 1, error: "otlp: HTTP 503" })
  })
})

describe("tool-run audit", () => {
  const policy = (tools: string) =>
    env.call("PUT", "/api/v1/orgs/acme/policy", { token: env.owner.token, body: { audit: { tools } } })
  const send = (token: string, runs: unknown[]) =>
    env.call("POST", "/api/v1/orgs/acme/audit/tools", { token, body: { runs } })
  const runs = (at = Date.now() - 2_000) => [
    {
      id: "prt_1",
      at,
      session: "ses_1",
      project: "web",
      tool: "bash",
      outcome: "completed",
      duration: 1_200,
      subject: "git",
      input: '{"command":"git push"}',
    },
    { id: "prt_2", at, tool: "read", outcome: "error", subject: "src/app.ts", error: "File not found" },
  ]
  const logged = async () =>
    (await env.store.audit.query({ org: env.owner.org.id, actions: ["client.tool_run"], limit: 10 })).toReversed()

  test("are kept only at the level the policy sets, attributed to the person, once each", async () => {
    const dev = await env.join("dev@acme.com", "member")
    // Off by default: nothing is kept, whatever a client sends.
    expect((await send(dev.token, runs())).data).toEqual({ accepted: 0 })
    expect(await logged()).toHaveLength(0)

    expect((await policy("summary")).status).toBe(200)
    expect((await send(dev.token, runs())).data).toEqual({ accepted: 2 })
    // Resent after a lost response, nothing is logged twice.
    expect((await send(dev.token, runs())).data).toEqual({ accepted: 0 })
    const summary = await logged()
    expect(summary.map((event) => [event.target, event.email, event.details])).toEqual([
      [
        "bash",
        "dev@acme.com",
        { tool: "bash", outcome: "completed", duration_ms: 1_200, session: "ses_1", project: "web", subject: "git" },
      ],
      [
        "read",
        "dev@acme.com",
        { tool: "read", outcome: "error", duration_ms: 0, subject: "src/app.ts", error: "File not found" },
      ],
    ])

    expect((await policy("inputs")).status).toBe(200)
    const next = runs().map((item) => ({ ...item, id: `${item.id}_next` }))
    expect((await send(dev.token, next)).data).toEqual({ accepted: 2 })
    expect((await logged())[2].details).toMatchObject({ input: '{"command":"git push"}' })
  })

  test("never log in the future, and keep text Postgres would refuse", async () => {
    const dev = await env.join("dev@acme.com", "member")
    expect((await policy("inputs")).status).toBe(200)
    const late = Date.now() + 60 * 60_000
    const odd = { ...runs(late)[1], id: "prt_odd", subject: "half \ud800 a pair" }
    expect((await send(dev.token, [runs(late)[0], odd])).data).toEqual({ accepted: 2 })
    const events = await logged()
    expect(events.every((event) => event.at <= Date.now())).toBe(true)
    expect(events[1].details).toMatchObject({ subject: "half \ufffd a pair" })
  })

  test("are streamed like any other audit event", async () => {
    const dev = await env.join("dev@acme.com", "member")
    await policy("summary")
    await create({ name: "OTel", target: { kind: "otlp", url: collector.url } })
    await send(dev.token, runs())
    await run()
    const records = JSON.parse(collector.deliveries.at(-1)!.body).resourceLogs[0].scopeLogs[0].logRecords
    const names = records.map(
      (record: { attributes: Array<{ key: string; value: { stringValue?: string } }> }) =>
        record.attributes.find((item) => item.key === "event.name")!.value.stringValue,
    )
    expect(names.filter((name: string) => name === "client.tool_run")).toHaveLength(2)
  })
})

describe("stream administration", () => {
  test("owners and admins manage streams; members cannot see them", async () => {
    const admin = await env.join("admin@acme.com", "admin")
    const member = await env.join("member@acme.com", "member")
    expect((await create({ name: "A", target: { kind: "webhook", url: collector.url } }, admin.token)).status).toBe(201)
    expect((await streams(member.token)).status).toBe(403)
    expect((await create({ name: "M", target: { kind: "webhook", url: collector.url } }, member.token)).status).toBe(
      403,
    )
  })

  test("rejects reserved headers, headers on syslog, and changing a stream's kind", async () => {
    expect(
      (
        await create({
          name: "x",
          target: { kind: "webhook", url: collector.url },
          headers: { "x-org-signature": "f" },
        })
      ).status,
    ).toBe(400)
    expect(
      (await create({ name: "x", target: { kind: "syslog", host: "siem.acme.com", port: 6514 }, headers: { a: "b" } }))
        .status,
    ).toBe(400)
    const id = (await create({ name: "x", target: { kind: "webhook", url: collector.url } })).data.stream.id
    const changed = await env.call("PATCH", `/api/v1/orgs/acme/audit/streams/${id}`, {
      token: env.owner.token,
      body: { target: { kind: "syslog", host: "siem.acme.com", port: 6514 } },
    })
    expect(changed.status).toBe(400)
  })

  test("webhooks and headers need ORGANIZATION_SECRET to seal them; syslog and bare OTLP do not", async () => {
    await env.runtime.dispose()
    env = await setup({ secret: undefined })
    expect((await create({ name: "w", target: { kind: "webhook", url: collector.url } })).status).toBe(400)
    expect(
      (await create({ name: "s", target: { kind: "syslog", host: "127.0.0.1", port: syslog.port, tls: false } }))
        .status,
    ).toBe(201)
    expect((await create({ name: "o", target: { kind: "otlp", url: collector.url } })).status).toBe(201)
    expect(
      (await create({ name: "h", target: { kind: "otlp", url: collector.url }, headers: { authorization: "x" } }))
        .status,
    ).toBe(400)
  })

  test("audit entries name the destination's host, never a token in its URL", async () => {
    const id = (await create({ name: "Sumo", target: { kind: "webhook", url: collector.url } })).data.stream.id
    expect((await env.call("DELETE", `/api/v1/orgs/acme/audit/streams/${id}`, { token: env.owner.token })).status).toBe(
      204,
    )
    const audit = await env.call("GET", "/api/v1/orgs/acme/audit?action=audit.stream_create,audit.stream_remove", {
      token: env.owner.token,
    })
    expect(audit.data.events.map((event: { details: { destination: string } }) => event.details.destination)).toEqual([
      new URL(collector.url).host,
      new URL(collector.url).host,
    ])
    expect(JSON.stringify(audit.data)).not.toContain("token-in-path")
  })
})
