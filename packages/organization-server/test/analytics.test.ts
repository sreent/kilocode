import { afterAll, describe, expect, test } from "bun:test"
import { Reports } from "../src/reports"
import { signature } from "../src/streams"
import { setup, type Env } from "./fixture"

const day = 24 * 60 * 60 * 1000
// Monday 7 September 2026, 00:00 UTC.
const monday = Date.UTC(2026, 8, 7)

const record = (id: string, at: number, cost: number, model = "claude-sonnet-4", session = `ses_${id}`) => ({
  id,
  at,
  session,
  provider: "mistral",
  model,
  tokens: { input: 100, output: 10 },
  cost,
})

const report = (env: Env, token: string, ...records: ReturnType<typeof record>[]) =>
  env.call("POST", "/api/v1/orgs/acme/usage", { token, body: { records } })

// A webhook that keeps what it receives.
const hook = (() => {
  const seen: Array<{ headers: Record<string, string>; body: string }> = []
  const bun = Bun.serve({
    port: 0,
    async fetch(request) {
      seen.push({ headers: Object.fromEntries(request.headers), body: await request.text() })
      return new Response("ok")
    },
  })
  return { url: `http://localhost:${bun.port}/hook`, seen, stop: () => bun.stop(true) }
})()

afterAll(() => hook.stop())

describe("adoption", () => {
  test("counts people, new people and sessions interval by interval, and lists who hasn't used it", async () => {
    const env = await setup()
    const ada = await env.join("ada@acme.com", "member")
    const bo = await env.join("bo@acme.com", "member")
    await env.join("cy@acme.com", "member")
    // Ada started the week before; Bo starts on Wednesday.
    await report(env, ada.token, record("a0", monday - 3 * day, 1))
    await report(env, ada.token, record("a1", monday + 1000, 2, "claude-sonnet-4", "ses_x"))
    await report(env, ada.token, record("a2", monday + 2000, 3, "claude-sonnet-4", "ses_x"))
    await report(env, bo.token, record("b1", monday + 2 * day, 4))

    const range = `from=${monday}&to=${monday + 7 * day}`
    const res = await env.call("GET", `/api/v1/orgs/acme/analytics/adoption?${range}`, { token: env.owner.token })
    expect(res.status).toBe(200)
    expect(res.data).toMatchObject({
      interval: "day",
      members: 4,
      seats: { limit: null, used: 4 },
      active: 2,
      new: 1,
      sessions: 2,
      requests: 3,
      cost: 9,
    })
    expect(res.data.series).toHaveLength(7)
    expect(res.data.series[0]).toEqual({ start: monday, active: 1, new: 0, sessions: 1, requests: 2, cost: 5 })
    expect(res.data.series[1]).toEqual({ start: monday + day, active: 0, new: 0, sessions: 0, requests: 0, cost: 0 })
    expect(res.data.series[2]).toEqual({
      start: monday + 2 * day,
      active: 1,
      new: 1,
      sessions: 1,
      requests: 1,
      cost: 4,
    })
    // Cy never used it; the owner neither.
    expect(res.data.idle.map((row: { email: string; last: number | null }) => [row.email, row.last])).toEqual([
      ["cy@acme.com", null],
      ["owner@acme.com", null],
    ])

    const weekly = await env.call("GET", `/api/v1/orgs/acme/analytics/adoption?${range}&interval=week`, {
      token: env.owner.token,
    })
    expect(weekly.data.series).toEqual([{ start: monday, active: 2, new: 1, sessions: 2, requests: 3, cost: 9 }])

    // Members see no one's adoption but their own usage elsewhere.
    expect((await env.call("GET", `/api/v1/orgs/acme/analytics/adoption`, { token: ada.token })).status).toBe(403)
    const long = `from=${monday - 3000 * day}&to=${monday}&interval=day`
    expect(
      (await env.call("GET", `/api/v1/orgs/acme/analytics/adoption?${long}`, { token: env.owner.token })).status,
    ).toBe(400)
  })
})

describe("comparisons", () => {
  test("set groups, sub-organizations and models against the range before", async () => {
    const env = await setup()
    const ada = await env.join("ada@acme.com", "member")
    const bo = await env.join("bo@acme.com", "member")
    const group = await env.call("POST", "/api/v1/orgs/acme/groups", {
      token: env.owner.token,
      body: { name: "Research" },
    })
    await env.call("PUT", `/api/v1/orgs/acme/groups/${group.data.id}/members`, {
      token: env.owner.token,
      body: { users: [ada.user.id] },
    })
    const child = await env.call("POST", "/api/v1/orgs/acme/suborgs", {
      token: env.owner.token,
      body: { name: "Acme EU", slug: "acme-eu" },
    })
    const eu = await env.join("eu@acme.com", "member", child.data.org.id)
    await report(env, ada.token, record("a1", monday + 1000, 2), record("p1", monday - day, 1, "gpt-5"))
    await report(env, bo.token, record("b1", monday + 2000, 3, "gpt-5"))
    await env.call("POST", "/api/v1/orgs/acme-eu/usage", {
      token: eu.token,
      body: { records: [record("e1", monday, 5)] },
    })

    const range = `from=${monday}&to=${monday + 7 * day}`
    const compare = (by: string) =>
      env.call("GET", `/api/v1/orgs/acme/analytics/compare?by=${by}&${range}`, { token: env.owner.token })

    const groups = await compare("group")
    expect(groups.data.previous).toEqual({ from: monday - 7 * day, to: monday })
    expect(groups.data.rows).toEqual([
      {
        key: "Research",
        id: group.data.id,
        members: 1,
        current: { active: 1, requests: 1, cost: 2, tokens: 110 },
        previous: { active: 1, requests: 1, cost: 1, tokens: 110 },
      },
    ])

    const orgs = await compare("suborg")
    expect(
      orgs.data.rows.map((row: { key: string; members: number; current: { cost: number } }) => [
        row.key,
        row.members,
        row.current.cost,
      ]),
    ).toEqual([
      ["Acme", 3, 5],
      ["Acme EU", 1, 5],
    ])

    // A model only used before still shows, so its drop is visible.
    const models = await compare("model")
    expect(
      models.data.rows.map((row: { key: string; current: { cost: number }; previous: { cost: number } }) => [
        row.key,
        row.current.cost,
        row.previous.cost,
      ]),
    ).toEqual([
      ["mistral/gpt-5", 3, 1],
      ["mistral/claude-sonnet-4", 2, 0],
    ])
  })
})

describe("scheduled reports", () => {
  test("periods are whole UTC weeks and months, due an hour after they end", () => {
    const wednesday = monday + 2 * day + 5000
    expect(Reports.period("weekly", wednesday)).toEqual({ from: monday - 7 * day, to: monday })
    expect(Reports.period("monthly", wednesday)).toEqual({ from: Date.UTC(2026, 7, 1), to: Date.UTC(2026, 8, 1) })
    expect(Reports.due("weekly", wednesday)).toBe(monday + 7 * day + 60 * 60 * 1000)
    // Just after a boundary, that boundary's report is still to come.
    expect(Reports.due("weekly", monday + 1000)).toBe(monday + 60 * 60 * 1000)
    expect(Reports.due("monthly", wednesday)).toBe(Date.UTC(2026, 9, 1) + 60 * 60 * 1000)
  })

  test("summaries go to the webhook signed, on schedule and on demand", async () => {
    const env = await setup()
    const ada = await env.join("ada@acme.com", "member")
    const now = Date.now()
    const last = Reports.period("weekly", now)
    await report(env, ada.token, record("a1", last.from + 1000, 12.5), record("a0", last.from - day, 10))

    const created = await env.call("POST", "/api/v1/orgs/acme/reports", {
      token: env.owner.token,
      body: { name: "Weekly to Slack", cadence: "weekly", url: hook.url },
    })
    expect(created.status).toBe(201)
    expect(created.data.report).toMatchObject({ format: "text", enabled: true, sent: null, error: null })
    expect(created.data.report.next).toBe(Reports.due("weekly", now))
    const secret: string = created.data.secret
    const id: string = created.data.report.id

    const sent = await env.call("POST", `/api/v1/orgs/acme/reports/${id}/send`, { token: env.owner.token })
    expect(sent.data).toEqual({ ok: true, error: null })
    const message = hook.seen.at(-1)!
    const stamp = message.headers["x-org-signature"]!.match(/^t=(\d+),v1=([0-9a-f]+)$/)!
    expect(stamp[2]).toBe(signature(secret, Number(stamp[1]), message.body))
    const text: string = JSON.parse(message.body).text
    expect(text).toStartWith("*Acme: AI use, ")
    expect(text).toContain("$12.50 spent (up 25% on the week before), 1 request. 1 of 2 members used Kilo.")
    expect(text).toContain("Top spenders: ada@acme.com ($12.50)")

    // Due reports go out once, then wait for the next period.
    await env.exec(`update reports set next = 0, format = 'json'`)
    const before = hook.seen.length
    await env.runtime.runPromise(Reports.Service.use((reports) => reports.run()))
    expect(hook.seen.length).toBe(before + 1)
    expect(JSON.parse(hook.seen.at(-1)!.body)).toMatchObject({
      org: { slug: "acme" },
      period: { cadence: "weekly", ...last },
      spend: 12.5,
      people: { members: 2, active: 1, new: 0 },
      previous: { spend: 10, active: 1 },
    })
    const listed = await env.call("GET", "/api/v1/orgs/acme/reports", { token: env.owner.token })
    expect(listed.data.reports[0].next).toBe(Reports.due("weekly", Date.now()))
    expect(listed.data.reports[0].sent).toBeGreaterThan(0)

    // A destination that fails is noted, and the report waits before trying again.
    await env.call("PATCH", `/api/v1/orgs/acme/reports/${id}`, {
      token: env.owner.token,
      body: { url: "http://127.0.0.1:9/nowhere" },
    })
    await env.exec(`update reports set next = 0`)
    await env.runtime.runPromise(Reports.Service.use((reports) => reports.run()))
    const failing = (await env.call("GET", "/api/v1/orgs/acme/reports", { token: env.owner.token })).data.reports[0]
    expect(failing.error).toStartWith("webhook:")
    expect(failing.next).toBe(0)

    expect((await env.call("DELETE", `/api/v1/orgs/acme/reports/${id}`, { token: env.owner.token })).status).toBe(204)
    const audit = (await env.store.audit.query({ org: env.owner.org.id, limit: 20 })).map((event) => event.action)
    expect(audit.filter((action) => action.startsWith("report."))).toEqual([
      "report.delete",
      "report.update",
      "report.create",
    ])
  })

  test("only managers handle reports", async () => {
    const env = await setup()
    const dev = await env.join("dev@acme.com", "member")
    const body = { name: "Mine", cadence: "monthly", url: hook.url }
    expect((await env.call("POST", "/api/v1/orgs/acme/reports", { token: dev.token, body })).status).toBe(403)
    expect((await env.call("GET", "/api/v1/orgs/acme/reports", { token: dev.token })).status).toBe(403)
  })
})
