import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { signature } from "../src/streams"
import { Streams } from "../src/streams"
import { setup, type Env } from "./fixture"

// A SIEM's HTTP collector and a syslog server, recording what they receive.

type Delivery = { headers: Record<string, string>; body: string; events: Array<{ id: number; action: string }> }

const collector = (() => {
  const deliveries: Delivery[] = []
  const state = { status: 200, delay: 0 }
  const bun = Bun.serve({
    port: 0,
    async fetch(request) {
      const body = await request.text()
      if (state.delay) await Bun.sleep(state.delay)
      deliveries.push({ headers: Object.fromEntries(request.headers), body, events: JSON.parse(body).events })
      return new Response(null, { status: state.status })
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
    const [, time, digest] = delivery!.headers["x-enterprise-signature"]!.match(/^t=(\d+),v1=([0-9a-f]{64})$/)!
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
    expect(messages[1]).toMatch(/^<110>1 \d{4}-\d\d-\d\dT[\d:.]+Z localhost kilo-enterprise - group\.create - \{/)
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
          headers: { "x-enterprise-signature": "f" },
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

  test("webhooks need ENTERPRISE_SECRET for their signing secret; syslog does not", async () => {
    await env.runtime.dispose()
    env = await setup({ secret: undefined })
    expect((await create({ name: "w", target: { kind: "webhook", url: collector.url } })).status).toBe(400)
    expect(
      (await create({ name: "s", target: { kind: "syslog", host: "127.0.0.1", port: syslog.port, tls: false } }))
        .status,
    ).toBe(201)
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
