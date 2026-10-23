import { afterAll, describe, expect, test } from "bun:test"
import { exportJWK, generateKeyPair, SignJWT } from "jose"
import { setup } from "./fixture"

// A real (if tiny) OpenID provider: discovery, JWKS, and a token endpoint that enforces
// client authentication and PKCE, so the server is exercised end to end without mocks.
async function provider() {
  const keys = await generateKeyPair("RS256")
  const jwk = { ...(await exportJWK(keys.publicKey)), kid: "k1", alg: "RS256", use: "sig" }
  const grants = new Map<string, { email: string; nonce: string; challenge: string; verified?: boolean }>()
  const client = { id: "kilo-enterprise", secret: "s3cr3t" }
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url)
      const issuer = url.origin
      if (url.pathname === "/.well-known/openid-configuration")
        return Response.json({
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          jwks_uri: `${issuer}/jwks`,
        })
      if (url.pathname === "/jwks") return Response.json({ keys: [jwk] })
      if (url.pathname !== "/token") return new Response("not found", { status: 404 })
      const expected = `Basic ${btoa(`${client.id}:${client.secret}`)}`
      if (req.headers.get("authorization") !== expected)
        return Response.json({ error: "invalid_client" }, { status: 401 })
      const form = new URLSearchParams(await req.text())
      const grant = grants.get(form.get("code") ?? "")
      if (!grant) return Response.json({ error: "invalid_grant" }, { status: 400 })
      grants.delete(form.get("code")!)
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(form.get("code_verifier") ?? ""))
      if (Buffer.from(digest).toString("base64url") !== grant.challenge)
        return Response.json({ error: "invalid_grant", error_description: "PKCE" }, { status: 400 })
      const token = await new SignJWT({
        email: grant.email,
        email_verified: grant.verified ?? true,
        nonce: grant.nonce,
        name: "Signed In",
      })
        .setProtectedHeader({ alg: "RS256", kid: "k1" })
        .setIssuer(issuer)
        .setAudience(client.id)
        .setSubject(`sub-${grant.email}`)
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(keys.privateKey)
      return Response.json({ id_token: token, access_token: "at", token_type: "Bearer" })
    },
  })
  const issuer = `http://localhost:${server.port}`
  // Simulates the user authenticating at the IdP: returns the code the IdP would redirect back with.
  const login = (authorize: string, email: string, opts: { nonce?: string; verified?: boolean } = {}) => {
    const url = new URL(authorize)
    const code = crypto.randomUUID()
    grants.set(code, {
      email,
      nonce: opts.nonce ?? url.searchParams.get("nonce")!,
      challenge: url.searchParams.get("code_challenge")!,
      verified: opts.verified,
    })
    return { code, state: url.searchParams.get("state")! }
  }
  return { server, issuer, client, login }
}

const idp = await provider()
afterAll(() => idp.server.stop(true))

async function configured() {
  const env = await setup()
  const res = await env.call("PUT", "/api/v1/orgs/acme/sso", {
    token: env.owner.token,
    body: { issuer: idp.issuer, client_id: idp.client.id, client_secret: idp.client.secret },
  })
  expect(res.status).toBe(200)
  return env
}

async function signin(
  env: Awaited<ReturnType<typeof configured>>,
  email: string,
  query = "",
  opts: { nonce?: string; verified?: boolean } = {},
) {
  const start = await env.server.request(`/sso/acme/start${query}`)
  expect(start.status).toBe(302)
  const authorize = start.headers.get("location")!
  expect(authorize.startsWith(`${idp.issuer}/authorize?`)).toBe(true)
  const params = new URL(authorize).searchParams
  expect(params.get("code_challenge_method")).toBe("S256")
  expect(params.get("redirect_uri")).toBe("http://localhost:8787/sso/callback")
  const grant = idp.login(authorize, email, opts)
  return env.server.request(`/sso/callback?code=${grant.code}&state=${grant.state}`)
}

describe("sso configuration", () => {
  test("requires a reachable issuer and stores the client secret sealed", async () => {
    const env = await setup()
    const bad = await env.call("PUT", "/api/v1/orgs/acme/sso", {
      token: env.owner.token,
      body: { issuer: "http://localhost:1/nope", client_id: "x", client_secret: "y" },
    })
    expect(bad.status).toBe(400)
    const ok = await configured()
    const row = (await ok.store.sso.get(ok.owner.org.id))!
    expect(row.secret.startsWith("v1.")).toBe(true)
    expect(row.secret).not.toContain(idp.client.secret)
    const view = await ok.call("GET", "/api/v1/orgs/acme/sso", { token: ok.owner.token })
    expect(view.data).toMatchObject({ configured: true, issuer: idp.issuer, client_id: idp.client.id, enforce: false })
    expect(JSON.stringify(view.data)).not.toContain(idp.client.secret)
  })

  test("cannot be configured without a server secret", async () => {
    const env = await setup({ secret: undefined })
    const res = await env.call("PUT", "/api/v1/orgs/acme/sso", {
      token: env.owner.token,
      body: { issuer: idp.issuer, client_id: "x", client_secret: "y" },
    })
    expect(res.status).toBe(400)
  })
})

describe("browser sign-in", () => {
  test("an existing member gets an org-scoped session cookie", async () => {
    const env = await configured()
    const res = await signin(env, "owner@acme.com")
    expect(res.status).toBe(302)
    expect(res.headers.get("location")).toBe("/admin")
    const cookie = res.headers.get("set-cookie")!
    expect(cookie).toContain("ent_session=")
    expect(cookie).toContain("HttpOnly")
    const session = cookie.match(/ent_session=([^;]+)/)![1]
    const me = await env.call("GET", "/api/v1/me", { headers: { cookie: `ent_session=${session}` } })
    expect(me.data.user.email).toBe("owner@acme.com")
    const logins = await env.store.audit.query({ org: env.owner.org.id, actions: ["user.login"], limit: 5 })
    expect(logins[0].details).toEqual({ method: "sso", device: false })
  })

  test("strangers are refused; verified-domain users are provisioned just in time", async () => {
    const env = await configured()
    expect((await signin(env, "stranger@acme.com")).status).toBe(403)
    const domain = await env.store.domain.create(env.owner.org.id, "acme.com")
    await env.store.domain.verify(domain.name)
    expect((await signin(env, "newbie@acme.com")).status).toBe(302)
    const user = (await env.store.user.find("newbie@acme.com"))!
    expect((await env.store.member.role(env.owner.org.id, user.id))?.role).toBe("member")
    expect(
      await env.store.audit.query({ org: env.owner.org.id, actions: ["sso.auto_provision"], limit: 5 }),
    ).toHaveLength(1)
  })

  test("a pending invite is honoured at first sign-in with the invited role", async () => {
    const env = await configured()
    await env.call("POST", "/api/v1/orgs/acme/invites", {
      token: env.owner.token,
      body: { email: "lead@partner.io", role: "admin" },
    })
    expect((await signin(env, "lead@partner.io")).status).toBe(302)
    const user = (await env.store.user.find("lead@partner.io"))!
    expect((await env.store.member.role(env.owner.org.id, user.id))?.role).toBe("admin")
  })

  test("rejects a replayed state, a wrong nonce and unverified email", async () => {
    const env = await configured()
    const start = await env.server.request("/sso/acme/start")
    const grant = idp.login(start.headers.get("location")!, "owner@acme.com")
    expect((await env.server.request(`/sso/callback?code=${grant.code}&state=${grant.state}`)).status).toBe(302)
    const second = idp.login(start.headers.get("location")!, "owner@acme.com")
    expect((await env.server.request(`/sso/callback?code=${second.code}&state=${second.state}`)).status).toBe(400)
    expect((await signin(env, "owner@acme.com", "", { nonce: "forged" })).status).toBe(403)
    expect((await signin(env, "owner@acme.com", "", { verified: false })).status).toBe(403)
  })

  test("suspended members cannot sign in", async () => {
    const env = await configured()
    const dev = await env.join("dev@acme.com", "member")
    await env.store.member.suspend(env.owner.org.id, dev.user.id, true)
    expect((await signin(env, "dev@acme.com")).status).toBe(403)
  })
})

describe("device login for the CLI and IDEs", () => {
  test("code is approved through SSO, then exchanged exactly once for a token", async () => {
    const env = await configured()
    const begin = await env.call("POST", "/api/v1/auth/device", { body: { org: "acme" } })
    expect(begin.status).toBe(200)
    expect(begin.data.user_code).toMatch(/^[A-Z]{4}-[A-Z]{4}$/)
    const poll = () => env.call("POST", "/api/v1/auth/device/token", { body: { device_code: begin.data.device_code } })
    expect((await poll()).data.error).toBe("authorization_pending")
    expect((await poll()).data.error).toBe("slow_down")
    const page = await env.server.request(`/device?code=${begin.data.user_code}`)
    expect(await page.text()).toContain(begin.data.user_code)
    const res = await signin(env, "owner@acme.com", `?device=${begin.data.user_code.toLowerCase()}`)
    expect(res.status).toBe(200)
    expect(await res.text()).toContain("signed in")
    await env.exec("update devices set polled = null")
    const done = await poll()
    expect(done.status).toBe(200)
    expect(done.data).toMatchObject({ token_type: "Bearer", org: { slug: "acme" }, user: { email: "owner@acme.com" } })
    expect((await env.call("GET", "/api/v1/orgs/acme", { token: done.data.access_token })).status).toBe(200)
    expect((await poll()).data.error).toBe("invalid_grant")
  })

  test("a denied code can never be redeemed", async () => {
    const env = await configured()
    const begin = await env.call("POST", "/api/v1/auth/device", { body: { org: "acme" } })
    await env.server.request(`/device/deny?code=${begin.data.user_code}`)
    const res = await env.call("POST", "/api/v1/auth/device/token", { body: { device_code: begin.data.device_code } })
    expect(res.data.error).toBe("access_denied")
    expect((await env.server.request(`/sso/acme/start?device=${begin.data.user_code}`)).status).toBe(404)
  })

  test("orgs without SSO point users at their administrator", async () => {
    const env = await setup()
    const res = await env.call("POST", "/api/v1/auth/device", { body: { org: "acme" } })
    expect(res.status).toBe(400)
    expect(res.data.message).toContain("administrator")
  })
})

describe("cross-org isolation", () => {
  test("an org's own IdP cannot mint access to another org that shares the user", async () => {
    const env = await configured()
    // Globex's owner points Globex SSO at an IdP they control and asserts Acme's owner email.
    const globex = await env.store.org.create({ name: "Globex", slug: "globex" })
    const evil = await env.join("boss@globex.com", "owner", globex.id)
    await env.call("PUT", "/api/v1/orgs/globex/sso", {
      token: evil.token,
      body: { issuer: idp.issuer, client_id: idp.client.id, client_secret: idp.client.secret },
    })
    await env.call("POST", "/api/v1/orgs/globex/invites", { token: evil.token, body: { email: "owner@acme.com" } })
    const start = await env.server.request("/sso/globex/start")
    const grant = idp.login(start.headers.get("location")!, "owner@acme.com")
    const res = await env.server.request(`/sso/callback?code=${grant.code}&state=${grant.state}`)
    expect(res.status).toBe(302)
    const session = res.headers.get("set-cookie")!.match(/ent_session=([^;]+)/)![1]
    const acme = await env.call("GET", "/api/v1/orgs/acme", { headers: { cookie: `ent_session=${session}` } })
    expect(acme.status).toBe(404)
  })
})
