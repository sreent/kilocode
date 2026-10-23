import { Hono } from "hono"
import { deleteCookie, getCookie } from "hono/cookie"
import { createMiddleware } from "hono/factory"
import { z } from "zod"
import { actor, body, cookie, escape, fail, ip, page, type Ctx, type Env } from "./context"

const day = 24 * 60 * 60 * 1000
export const ttl = {
  device: 10 * 60 * 1000,
  // CLI and IDE logins; long-lived so developers aren't interrupted, revocable at any time.
  cli: 90 * day,
  invite: 7 * day,
}
const interval = 5

export const authenticate = createMiddleware<Env>(async (c, next) => {
  const bearer = c.req
    .header("authorization")
    ?.match(/^Bearer\s+(.+)$/i)
    ?.at(1)
  const value = bearer ?? getCookie(c, cookie)
  if (!value) fail(401, "missing bearer token")
  const token = c.var.store.token.verify(value)
  if (!token || token.kind !== "user" || !token.user) fail(401, "invalid or expired token")
  const user = c.var.store.user.get(token.user)
  if (!user || !user.active) fail(401, "user is deactivated")
  // Browser sessions ride on an ambient cookie, so writes must prove they come from our own origin (CSRF).
  if (!bearer && !["GET", "HEAD"].includes(c.req.method)) {
    if (c.req.header("origin") !== new URL(c.var.config.base).origin) fail(403, "cross-origin request rejected")
  }
  c.set("token", token)
  c.set("user", user)
  c.set("cookie", !bearer)
  await next()
})

// Account-level events (tokens, logout) are recorded in the org the caller's token belongs to.
function record(c: Ctx, action: string, details?: Record<string, unknown>) {
  c.var.store.audit.record({ org: c.var.token.org, action, actor: actor(c), target: c.var.user.id, details, ip: ip(c) })
}

export const auth = new Hono<Env>()

// RFC 8628 device authorization: the CLI shows a code, the user approves it in the browser via SSO.
auth.post("/api/v1/auth/device", async (c) => {
  const input = await body(c, z.object({ org: z.string().min(1) }))
  const store = c.var.store
  const org = store.org.get(input.org) ?? fail(404, "organization not found")
  if (!store.sso.get(org.id))
    fail(400, "single sign-on is not configured for this organization; ask an administrator for an access token")
  const created = store.device.create(org.id, ttl.device)
  const base = c.var.config.base
  return c.json({
    device_code: created.value,
    user_code: created.code,
    verification_uri: `${base}/device`,
    verification_uri_complete: `${base}/device?code=${created.code}`,
    expires_in: ttl.device / 1000,
    interval,
  })
})

auth.post("/api/v1/auth/device/token", async (c) => {
  const input = await body(c, z.object({ device_code: z.string().min(1) }))
  const store = c.var.store
  const row = store.device.find(input.device_code)
  if (!row || row.status === "consumed") return c.json({ error: "invalid_grant" }, 400)
  if (row.expires < store.now()) return c.json({ error: "expired_token" }, 400)
  if (row.status === "denied") return c.json({ error: "access_denied" }, 400)
  if (row.status === "pending") {
    const fast = row.polled != null && store.now() - row.polled < interval * 1000
    store.device.poll(row.hash)
    return c.json({ error: fast ? "slow_down" : "authorization_pending" }, 400)
  }
  if (!row.user || !store.device.consume(row.hash)) return c.json({ error: "invalid_grant" }, 400)
  const user = store.user.get(row.user)!
  const org = store.org.get(row.org)!
  const issued = store.token.issue({ kind: "user", user: user.id, org: org.id, name: "CLI device login", ttl: ttl.cli })
  store.audit.record({
    org: org.id,
    action: "user.login",
    actor: { id: user.id, email: user.email },
    target: user.id,
    details: { method: "device" },
    ip: ip(c),
  })
  return c.json({
    access_token: issued.value,
    token_type: "Bearer",
    expires_in: ttl.cli / 1000,
    user: { id: user.id, email: user.email, name: user.name },
    org: { id: org.id, slug: org.slug, name: org.name },
  })
})

// Browser page that starts SSO for a pending device code.
auth.get("/device", (c) => {
  const code = c.req.query("code")
  if (!code)
    return c.html(
      page(
        "Approve device",
        `<h1>Approve a device</h1>
         <p>Enter the code shown in your terminal or IDE.</p>
         <form method="get" action="/device"><input name="code" autocomplete="off" required> <button>Continue</button></form>`,
      ),
    )
  const row = c.var.store.device.code(code)
  if (!row || row.status !== "pending" || row.expires < c.var.store.now())
    return c.html(
      page("Code expired", `<h1>Code not found</h1><p>This code is invalid or has expired. Start the login again.</p>`),
      404,
    )
  const org = c.var.store.org.get(row.org)!
  return c.html(
    page(
      "Approve device",
      `<h1>Sign in to ${escape(org.name)}</h1>
       <p>Confirm this code matches the one in your terminal or IDE:</p>
       <div class="code">${escape(row.code)}</div>
       <p><a class="button" href="/sso/${encodeURIComponent(org.slug)}/start?device=${encodeURIComponent(row.code)}">Continue with single sign-on</a></p>
       <p><a href="/device/deny?code=${encodeURIComponent(row.code)}">This wasn't me</a></p>`,
    ),
  )
})

auth.get("/device/deny", (c) => {
  const code = c.req.query("code") ?? ""
  c.var.store.device.decide(code.trim().toUpperCase(), "denied")
  return c.html(
    page("Login denied", `<h1>Login denied</h1><p>The device was not signed in. You can close this window.</p>`),
  )
})

// Invite links are bearer secrets delivered by an admin. Orgs that enforce SSO accept invites only through SSO.
auth.post("/api/v1/invites/:token/accept", async (c) => {
  const store = c.var.store
  const row = store.invite.find(c.req.param("token")) ?? fail(404, "invite not found or expired")
  if (store.sso.get(row.org)?.enforce)
    fail(403, "this organization requires single sign-on; sign in with SSO to accept your invite")
  const raw = await c.req.json().catch(() => ({}))
  const input = z.object({ name: z.string().max(200).optional() }).parse(raw)
  const user = store.user.ensure({ email: row.email, name: input.name })
  if (!user.active) fail(403, "this account is deactivated")
  store.member.add(row.org, user.id, row.role)
  store.invite.accept(row.id)
  const issued = store.token.issue({
    kind: "user",
    user: user.id,
    org: row.org,
    name: "Invite acceptance",
    ttl: ttl.cli,
  })
  store.audit.record({
    org: row.org,
    action: "user.accept_invite",
    actor: { id: user.id, email: user.email },
    target: user.id,
    details: { role: row.role, invite: row.id },
    ip: ip(c),
  })
  const org = store.org.get(row.org)!
  return c.json({
    token: issued.value,
    user: { id: user.id, email: user.email, name: user.name },
    org: { id: org.id, slug: org.slug, name: org.name },
  })
})

auth.use("/api/v1/me", authenticate)
auth.use("/api/v1/me/*", authenticate)
auth.use("/api/v1/auth/logout", authenticate)

// The caller's identity and the orgs this token reaches: its own org plus sub-orgs it can manage.
auth.get("/api/v1/me", (c) => {
  const store = c.var.store
  const home = store.org.get(c.var.token.org)!
  const orgs = [home, ...store.org.children(home.id)].flatMap((org) => {
    const access = store.member.role(org.id, c.var.user.id)
    if (!access) return []
    return [
      {
        id: org.id,
        slug: org.slug,
        name: org.name,
        parent: org.parent,
        role: access.role,
        inherited: access.inherited,
      },
    ]
  })
  return c.json({ user: { id: c.var.user.id, email: c.var.user.email, name: c.var.user.name }, orgs })
})

auth.get("/api/v1/me/tokens", (c) =>
  c.json({ tokens: c.var.store.token.list({ org: c.var.token.org, user: c.var.user.id, kind: "user" }) }),
)

auth.post("/api/v1/me/tokens", async (c) => {
  const input = await body(
    c,
    z.object({ name: z.string().min(1).max(100), days: z.number().int().min(1).max(365).default(90) }),
  )
  const issued = c.var.store.token.issue({
    kind: "user",
    user: c.var.user.id,
    org: c.var.token.org,
    name: input.name,
    ttl: input.days * day,
  })
  record(c, "token.create", { token: issued.id, name: input.name, days: input.days })
  return c.json({ id: issued.id, token: issued.value }, 201)
})

auth.delete("/api/v1/me/tokens/:id", (c) => {
  const row = c.var.store.token.get(c.req.param("id"))
  if (!row || row.user !== c.var.user.id || row.org !== c.var.token.org) fail(404, "token not found")
  c.var.store.token.revoke(row.id)
  record(c, "token.revoke", { token: row.id, name: row.name })
  return c.body(null, 204)
})

auth.post("/api/v1/auth/logout", (c) => {
  c.var.store.token.revoke(c.var.token.id)
  record(c, "user.logout")
  deleteCookie(c, cookie, { path: "/" })
  return c.body(null, 204)
})
