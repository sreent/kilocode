import { describe, expect, test } from "bun:test"
import { ConfigProvider, Effect } from "effect"
import { ServerConfig } from "../src/config"
import { setup } from "./fixture"

describe("rate limits", () => {
  test("each token has its own allowance, refused with a 429 and Retry-After once spent", async () => {
    const env = await setup({ limits: { token: 3, anonymous: 0 } })
    const dev = await env.join("dev@acme.com", "member")
    const me = (token: string) => env.call("GET", "/api/v1/me", { token })
    for (let i = 0; i < 3; i++) expect((await me(dev.token)).status).toBe(200)
    const refused = await me(dev.token)
    expect(refused.status).toBe(429)
    // Three a minute come back one every 20 seconds.
    expect(refused.data).toEqual({ _tag: "RateLimitError", message: "Too many requests. Try again in 20 seconds." })
    expect(refused.headers.get("retry-after")).toBe("20")
    expect((await me(env.owner.token)).status).toBe(200)
    // Health checks and the console's files are never counted.
    for (let i = 0; i < 5; i++) {
      expect((await env.call("GET", "/healthz")).status).toBe(200)
      expect((await env.call("GET", "/readyz")).data).toEqual({ ok: true })
      expect((await env.call("GET", "/admin/assets/index.js")).status).toBe(200)
    }
  })

  test("identity providers' SCIM clients are refused in SCIM's error format", async () => {
    const env = await setup({ limits: { token: 1, anonymous: 0 } })
    // The console token's own allowance is spent creating the SCIM token.
    const token: string = (
      await env.call("POST", "/api/v1/orgs/acme/scim/tokens", { token: env.owner.token, body: { name: "okta" } })
    ).data.token
    expect((await env.call("GET", "/scim/v2/Users", { token })).status).toBe(200)
    const refused = await env.call("GET", "/scim/v2/Users", { token })
    expect(refused.status).toBe(429)
    expect(refused.headers.get("content-type")).toContain("application/scim+json")
    expect(refused.data).toMatchObject({ status: "429", detail: "Too many requests. Try again in 60 seconds." })
  })

  test("requests without a token are counted per address, the one the nearest proxy saw", async () => {
    const env = await setup({ limits: { token: 0, anonymous: 2 }, proxy: 1 })
    const spec = (forwarded: string) =>
      env.call("GET", "/api/v1/openapi.json", { headers: { "x-forwarded-for": forwarded } })
    // A client can send any X-Forwarded-For it likes; the proxy's own entry, the last, is what counts.
    expect((await spec("192.0.2.1, 198.51.100.4")).status).toBe(200)
    expect((await spec("192.0.2.2, 198.51.100.4")).status).toBe(200)
    expect((await spec("192.0.2.3, 198.51.100.4")).status).toBe(429)
    expect((await spec("198.51.100.5")).status).toBe(200)
    // Pages answer in HTML.
    const page = await env.call("GET", "/device", { headers: { "x-forwarded-for": "198.51.100.4" } })
    expect(page.status).toBe(429)
    expect(page.data).toContain("Too many requests")
  })
})

describe("client addresses", () => {
  const recorded = async (proxy: number, forwarded: string) => {
    const env = await setup({ proxy })
    await env.call("POST", "/api/v1/orgs/acme/groups", {
      token: env.owner.token,
      body: { name: "Platform" },
      headers: { "x-forwarded-for": forwarded },
    })
    return (await env.store.audit.query({ org: env.owner.org.id, actions: ["group.create"], limit: 1 }))[0].ip
  }

  test("are read from X-Forwarded-For as many entries from the end as there are proxies", async () => {
    expect(await recorded(0, "192.0.2.1")).toBe("203.0.113.7")
    expect(await recorded(1, "192.0.2.1, 198.51.100.4")).toBe("198.51.100.4")
    expect(await recorded(2, "192.0.2.1, 198.51.100.4, 10.0.0.2")).toBe("198.51.100.4")
    // A request that skipped the outer proxy has fewer entries.
    expect(await recorded(2, "198.51.100.4")).toBe("198.51.100.4")
  })

  test("ORGANIZATION_TRUST_PROXY takes a count of proxies, or true for one", async () => {
    const proxy = (value?: string) =>
      Effect.runPromise(
        ServerConfig.Service.use((config) => Effect.succeed(config.proxy)).pipe(
          Effect.provide(ServerConfig.layer),
          Effect.provideService(
            ConfigProvider.ConfigProvider,
            ConfigProvider.fromEnv({ env: value === undefined ? {} : { ORGANIZATION_TRUST_PROXY: value } }),
          ),
        ),
      )
    expect(await proxy()).toBe(0)
    expect(await proxy("true")).toBe(1)
    expect(await proxy("1")).toBe(1)
    expect(await proxy("2")).toBe(2)
    expect(await proxy("false")).toBe(0)
    await expect(proxy("sometimes")).rejects.toThrow()
  })
})

describe("device codes", () => {
  test("wrong codes are limited per address, so codes can't be guessed", async () => {
    const env = await setup({ proxy: 1 })
    const from = (address: string) => ({ headers: { "x-forwarded-for": address } })
    const { code } = await env.store.device.create(env.owner.org.id, 10 * 60_000)
    expect((await env.call("GET", `/device?code=${code}`, from("198.51.100.4"))).status).toBe(200)
    for (let i = 0; i < 19; i++)
      expect((await env.call("GET", `/device?code=BBBB-BBB${i}`, from("198.51.100.4"))).status).toBe(404)
    // Denying a code that isn't waiting is a wrong code too.
    expect((await env.call("GET", "/device/deny?code=CCCC-CCCC", from("198.51.100.4"))).status).toBe(404)
    // After twenty, even the right code waits.
    const blocked = await env.call("GET", `/device?code=${code}`, from("198.51.100.4"))
    expect(blocked.status).toBe(429)
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0)
    expect((await env.call("GET", `/device?code=${code}`, from("198.51.100.5"))).status).toBe(200)
  })
})
