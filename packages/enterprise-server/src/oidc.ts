import { Hono } from "hono"
import { setCookie } from "hono/cookie"
import { createRemoteJWKSet, jwtVerify } from "jose"
import { z } from "zod"
import { cookie, escape, fail, ip, page, type Ctx, type Env } from "./context"
import * as crypto from "./crypto"

const Discovery = z.object({
  issuer: z.string(),
  authorization_endpoint: z.url(),
  token_endpoint: z.url(),
  jwks_uri: z.url(),
  userinfo_endpoint: z.url().optional(),
  token_endpoint_auth_methods_supported: z.array(z.string()).optional(),
})
type Discovery = z.infer<typeof Discovery>

const hour = 60 * 60 * 1000
const documents = new Map<string, { at: number; doc: Discovery }>()
const keys = new Map<string, ReturnType<typeof createRemoteJWKSet>>()

export async function discover(issuer: string) {
  const hit = documents.get(issuer)
  if (hit && Date.now() - hit.at < hour) return hit.doc
  const res = await fetch(`${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`)
  if (!res.ok) fail(502, `OIDC discovery failed for ${issuer}: HTTP ${res.status}`)
  const doc = Discovery.parse(await res.json())
  // OIDC Discovery 1.0 §4.3: the advertised issuer must match the one we were configured with.
  if (doc.issuer.replace(/\/$/, "") !== issuer.replace(/\/$/, "")) fail(502, `OIDC issuer mismatch: ${doc.issuer}`)
  documents.set(issuer, { at: Date.now(), doc })
  return doc
}

function jwks(uri: string) {
  const hit = keys.get(uri)
  if (hit) return hit
  const set = createRemoteJWKSet(new URL(uri))
  keys.set(uri, set)
  return set
}

function error(c: Ctx, title: string, message: string, status: 400 | 403 | 404 | 502 = 400) {
  return c.html(page(title, `<h1>${escape(title)}</h1><p>${escape(message)}</p>`), status)
}

export const oidc = new Hono<Env>()

oidc.get("/sso/:org/start", async (c) => {
  const store = c.var.store
  const org = store.org.get(c.req.param("org"))
  if (!org) return error(c, "Unknown organization", "This organization does not exist.", 404)
  const sso = store.sso.get(org.id)
  if (!sso) return error(c, "SSO not configured", "Single sign-on is not configured for this organization.", 404)
  const code = c.req.query("device")?.trim().toUpperCase()
  if (code) {
    const row = store.device.code(code)
    if (!row || row.org !== org.id || row.status !== "pending" || row.expires < store.now())
      return error(c, "Code expired", "This device code is invalid or has expired. Start the login again.", 404)
  }
  const doc = await discover(sso.issuer)
  const verifier = crypto.secret(32)
  const nonce = crypto.secret(16)
  const state = store.login.create({ org: org.id, verifier, nonce, device: code })
  const url = new URL(doc.authorization_endpoint)
  url.searchParams.set("response_type", "code")
  url.searchParams.set("client_id", sso.client)
  url.searchParams.set("redirect_uri", `${c.var.config.base}/sso/callback`)
  url.searchParams.set("scope", sso.scopes)
  url.searchParams.set("state", state)
  url.searchParams.set("nonce", nonce)
  url.searchParams.set("code_challenge", await crypto.challenge(verifier))
  url.searchParams.set("code_challenge_method", "S256")
  const hint = c.req.query("login_hint")
  if (hint) url.searchParams.set("login_hint", hint)
  return c.redirect(url.toString())
})

oidc.get("/sso/callback", async (c) => {
  const store = c.var.store
  const config = c.var.config
  const state = c.req.query("state")
  const row = state ? store.login.take(state) : undefined
  if (!row || store.now() - row.created > 10 * 60 * 1000)
    return error(c, "Sign-in expired", "This sign-in attempt is invalid or has expired. Please try again.")
  const denied = c.req.query("error")
  if (denied) return error(c, "Sign-in failed", c.req.query("error_description") ?? denied, 403)
  const code = c.req.query("code")
  if (!code) return error(c, "Sign-in failed", "The identity provider did not return an authorization code.")
  const org = store.org.get(row.org)!
  const sso = store.sso.get(org.id)
  if (!sso || !config.secret)
    return error(c, "SSO not configured", "Single sign-on is not configured for this organization.", 404)

  const doc = await discover(sso.issuer)
  const secret = await crypto.unseal(config.secret, sso.secret)
  // Discovery default is client_secret_basic; fall back to client_secret_post when that's all the IdP offers.
  const basic = (doc.token_endpoint_auth_methods_supported ?? ["client_secret_basic"]).includes("client_secret_basic")
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: `${config.base}/sso/callback`,
    code_verifier: row.verifier,
  })
  if (!basic) {
    form.set("client_id", sso.client)
    form.set("client_secret", secret)
  }
  const res = await fetch(doc.token_endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
      ...(basic
        ? { authorization: `Basic ${btoa(`${encodeURIComponent(sso.client)}:${encodeURIComponent(secret)}`)}` }
        : {}),
    },
    body: form,
  })
  if (!res.ok) return error(c, "Sign-in failed", `Token exchange failed (HTTP ${res.status}).`, 502)
  const tokens = z.object({ id_token: z.string(), access_token: z.string().optional() }).safeParse(await res.json())
  if (!tokens.success) return error(c, "Sign-in failed", "The identity provider did not return an ID token.", 502)

  const verified = await jwtVerify(tokens.data.id_token, jwks(doc.jwks_uri), {
    issuer: doc.issuer,
    audience: sso.client,
  }).catch((err: Error) => err)
  if (verified instanceof Error) return error(c, "Sign-in failed", `Invalid ID token: ${verified.message}`, 403)
  const claims = verified.payload
  if (claims.nonce !== row.nonce) return error(c, "Sign-in failed", "ID token nonce mismatch.", 403)

  const profile = await (async () => {
    if (typeof claims.email === "string") return claims
    if (!doc.userinfo_endpoint || !tokens.data.access_token) return claims
    const info = await fetch(doc.userinfo_endpoint, {
      headers: { authorization: `Bearer ${tokens.data.access_token}` },
    })
    if (!info.ok) return claims
    const data = z.record(z.string(), z.unknown()).safeParse(await info.json()).data
    // OIDC Core §5.3.2: userinfo must describe the same subject as the ID token.
    if (!data || data.sub !== claims.sub) return claims
    return { ...claims, ...data }
  })()
  const email = typeof profile.email === "string" ? profile.email.trim().toLowerCase() : undefined
  if (!email) return error(c, "Sign-in failed", "The identity provider did not share an email address.", 403)
  if (profile.email_verified === false)
    return error(c, "Sign-in failed", "Your email address is not verified with the identity provider.", 403)
  const name = typeof profile.name === "string" ? profile.name : null

  const known = store.user.find(email)
  if (known && !known.active) return error(c, "Account deactivated", "Your account has been deactivated.", 403)
  const access = known ? store.member.role(org.id, known.id) : undefined
  const membership = known ? store.member.get(org.id, known.id) : undefined
  if (membership?.suspended) return error(c, "Access suspended", "Your access to this organization is suspended.", 403)

  const user = (() => {
    if (access) return known!
    const pending = store.invite.pending(org.id, email).at(0)
    if (pending) {
      const created = store.user.ensure({ email, name, external: String(claims.sub) })
      store.member.add(org.id, created.id, pending.role)
      store.invite.accept(pending.id)
      store.audit.record({
        org: org.id,
        action: "user.accept_invite",
        actor: { id: created.id, email },
        target: created.id,
        details: { role: pending.role, invite: pending.id, method: "sso" },
        ip: ip(c),
      })
      return created
    }
    // Just-in-time provisioning for people whose email domain this org has verified.
    if (sso.provision && store.domain.owner(email) === org.id) {
      const created = store.user.ensure({ email, name, external: String(claims.sub) })
      store.member.add(org.id, created.id, "member")
      store.audit.record({
        org: org.id,
        action: "sso.auto_provision",
        actor: { id: created.id, email },
        target: created.id,
        details: { domain: email.split("@").at(-1) },
        ip: ip(c),
      })
      return created
    }
    return undefined
  })()
  if (!user)
    return error(c, "Not a member", `${email} is not a member of ${org.name}. Ask an administrator to invite you.`, 403)
  if (!user.name && name) store.user.update(user.id, { name })

  store.audit.record({
    org: org.id,
    action: "user.login",
    actor: { id: user.id, email: user.email },
    target: user.id,
    details: { method: "sso", device: row.device != null },
    ip: ip(c),
  })

  if (row.device) {
    if (!store.device.decide(row.device, "approved", user.id))
      return error(c, "Code expired", "This device code expired before sign-in finished. Start the login again.")
    return c.html(
      page(
        "Device approved",
        `<h1>You're signed in</h1><p>Return to your terminal or IDE. You can close this window.</p>`,
      ),
    )
  }

  const session = store.token.issue({ kind: "user", user: user.id, org: org.id, name: "Web session", ttl: 8 * hour })
  setCookie(c, cookie, session.value, {
    path: "/",
    httpOnly: true,
    secure: config.base.startsWith("https://"),
    sameSite: "Lax",
    maxAge: (8 * hour) / 1000,
  })
  return c.redirect("/admin")
})
