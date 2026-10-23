import { Hono } from "hono"
import { z } from "zod"
import { authenticate, ttl } from "./auth"
import { audit, body, csv, fail, need, time, type Ctx, type Env } from "./context"
import * as crypto from "./crypto"
import { json } from "./db"
import { discover } from "./oidc"
import { Access, Mode, Policy, resolve } from "./policy"
import { can, Role } from "./roles"
import type { Org } from "./store"

const day = 24 * 60 * 60 * 1000
const Slug = z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/, "lowercase letters, digits and dashes, 2-63 characters")
const Hostname = z
  .string()
  .toLowerCase()
  .regex(/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/, "must be a domain name like example.com")

function view(org: Org) {
  return {
    id: org.id,
    name: org.name,
    slug: org.slug,
    parent: org.parent,
    settings: json(org.settings, {}),
    created: org.created,
  }
}

function changed(before: Record<string, unknown>, after: Record<string, unknown>) {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(
    (key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]),
  )
}

function delta(before: string[], after: string[]) {
  return {
    added: after.filter((item) => !before.includes(item)),
    removed: before.filter((item) => !after.includes(item)),
  }
}

// Only owners grant the owner role or manage another owner's membership.
function guard(c: Ctx, current: Role | undefined, next?: Role) {
  if (c.var.role === "owner") return
  if (current === "owner" || next === "owner") fail(403, "only owners can manage owners")
}

export const api = new Hono<Env>()

api.use("*", authenticate)
api.use("*", async (c, next) => {
  const store = c.var.store
  const org = store.org.get(c.req.param("org") ?? "")
  // 404 rather than 403 so tokens can't probe which orgs exist.
  if (!org || !store.token.reaches(c.var.token, org.id)) fail(404, "organization not found")
  const access = store.member.role(org.id, c.var.user.id) ?? fail(404, "organization not found")
  c.set("org", org)
  c.set("role", access.role)
  c.set("inherited", access.inherited)
  await next()
})

api.get("/", (c) => c.json({ org: view(c.var.org), role: c.var.role, inherited: c.var.inherited }))

api.patch("/", async (c) => {
  need(c, "org.write")
  const input = await body(
    c,
    z.object({ name: z.string().min(1).max(200).optional(), settings: z.record(z.string(), z.unknown()).optional() }),
  )
  const before = view(c.var.org)
  const after = view(c.var.store.org.update(c.var.org.id, input))
  audit(c, "organization.settings_change", c.var.org.id, { changed: changed(before, after) })
  return c.json({ org: after })
})

// ---- members ------------------------------------------------------------------------------

api.get("/members", (c) => {
  need(c, "member.read")
  const store = c.var.store
  return c.json({
    members: store.member.list(c.var.org.id).map((row) => ({
      id: row.id,
      email: row.email,
      name: row.name,
      role: row.role,
      active: row.active === 1 && row.suspended == null,
      joined: row.joined,
      groups: store.group.of(c.var.org.id, row.id).map((group) => group.name),
    })),
  })
})

api.post("/members", async (c) => {
  need(c, "member.write")
  const input = await body(
    c,
    z.object({ email: z.email(), name: z.string().max(200).optional(), role: Role.default("member") }),
  )
  guard(c, undefined, input.role)
  const store = c.var.store
  const user = store.user.ensure({ email: input.email, name: input.name })
  if (store.member.get(c.var.org.id, user.id)) fail(409, "already a member")
  store.member.add(c.var.org.id, user.id, input.role)
  audit(c, "member.add", user.id, { email: user.email, role: input.role })
  return c.json({ id: user.id, email: user.email, role: input.role }, 201)
})

api.patch("/members/:user", async (c) => {
  need(c, "member.write")
  const input = await body(c, z.object({ role: Role }))
  const store = c.var.store
  const target = c.req.param("user")
  const current = store.member.get(c.var.org.id, target) ?? fail(404, "member not found")
  guard(c, current.role, input.role)
  if (current.role === "owner" && input.role !== "owner" && store.member.owners(c.var.org.id) <= 1)
    fail(409, "an organization must keep at least one owner")
  store.member.set(c.var.org.id, target, input.role)
  audit(c, "member.change_role", target, { from: current.role, to: input.role })
  return c.json({ id: target, role: input.role })
})

api.delete("/members/:user", (c) => {
  need(c, "member.write")
  const store = c.var.store
  const target = c.req.param("user")
  const current = store.member.get(c.var.org.id, target) ?? fail(404, "member not found")
  guard(c, current.role)
  if (current.role === "owner" && store.member.owners(c.var.org.id) <= 1)
    fail(409, "an organization must keep at least one owner")
  store.member.remove(c.var.org.id, target)
  audit(c, "member.remove", target, { role: current.role, email: store.user.get(target)?.email })
  return c.body(null, 204)
})

// For orgs without SSO: an admin issues a CLI/IDE token for a member and hands it over out of band.
api.post("/members/:user/tokens", async (c) => {
  need(c, "token.write")
  const store = c.var.store
  if (store.sso.get(c.var.org.id)?.enforce)
    fail(403, "this organization enforces single sign-on; members sign in with SSO")
  const target = c.req.param("user")
  const current = store.member.get(c.var.org.id, target)
  if (!current || current.suspended) fail(404, "member not found")
  guard(c, current.role)
  const input = await body(
    c,
    z.object({
      name: z.string().min(1).max(100).default("Admin-issued token"),
      days: z.number().int().min(1).max(365).default(90),
    }),
  )
  const issued = store.token.issue({
    kind: "user",
    user: target,
    org: c.var.org.id,
    name: input.name,
    ttl: input.days * day,
  })
  audit(c, "token.create", target, { token: issued.id, name: input.name, days: input.days, issued_by_admin: true })
  return c.json({ id: issued.id, token: issued.value }, 201)
})

// ---- invites ------------------------------------------------------------------------------

api.get("/invites", (c) => {
  need(c, "invite.write")
  return c.json({
    invites: c.var.store.invite.pending(c.var.org.id).map((row) => ({
      id: row.id,
      email: row.email,
      role: row.role,
      created: row.created,
      expires: row.expires,
    })),
  })
})

api.post("/invites", async (c) => {
  need(c, "invite.write")
  const input = await body(
    c,
    z.object({ email: z.email(), role: Role.default("member"), days: z.number().int().min(1).max(30).optional() }),
  )
  guard(c, undefined, input.role)
  const store = c.var.store
  const existing = store.user.find(input.email)
  if (existing && store.member.get(c.var.org.id, existing.id)) fail(409, "already a member")
  const created = store.invite.create({
    org: c.var.org.id,
    email: input.email,
    role: input.role,
    actor: c.var.user.id,
    ttl: input.days ? input.days * day : ttl.invite,
  })
  audit(c, "user.send_invite", created.id, { email: input.email, role: input.role })
  const base = c.var.config.base
  const sso = store.sso.get(c.var.org.id)
  return c.json(
    {
      id: created.id,
      // Bearer secret: deliver it to the invitee privately. With SSO, signing in consumes the invite instead.
      token: created.value,
      accept: `${base}/api/v1/invites/${created.value}/accept`,
      sso: sso ? `${base}/sso/${c.var.org.slug}/start` : null,
    },
    201,
  )
})

api.delete("/invites/:id", (c) => {
  need(c, "invite.write")
  if (!c.var.store.invite.revoke(c.var.org.id, c.req.param("id"))) fail(404, "invite not found")
  audit(c, "user.revoke_invite", c.req.param("id"))
  return c.body(null, 204)
})

// ---- groups -------------------------------------------------------------------------------

function group(c: Ctx, id: string) {
  const store = c.var.store
  const row = store.group.get(c.var.org.id, id) ?? fail(404, "group not found")
  return {
    id: row.id,
    name: row.name,
    external: row.external,
    models: Access.nullable().parse(json(row.models, null)),
    members: store.group.members(row.id).map((user) => ({ id: user.id, email: user.email, name: user.name })),
    created: row.created,
  }
}

api.get("/groups", (c) => {
  const store = c.var.store
  // Members only learn the names of the groups they belong to.
  if (!can(c.var.role, "group.read"))
    return c.json({
      groups: store.group.of(c.var.org.id, c.var.user.id).map((row) => ({ id: row.id, name: row.name })),
    })
  return c.json({ groups: store.group.list(c.var.org.id).map((row) => group(c, row.id)) })
})

api.get("/groups/:id", (c) => {
  need(c, "group.read")
  return c.json(group(c, c.req.param("id")))
})

api.post("/groups", async (c) => {
  need(c, "group.write")
  const input = await body(c, z.object({ name: z.string().min(1).max(200), models: Access.nullable().optional() }))
  const store = c.var.store
  if (store.group.list(c.var.org.id).some((row) => row.name === input.name)) fail(409, "a group with this name exists")
  const row = store.group.create(c.var.org.id, input)
  audit(c, "group.create", row.id, { name: input.name, models: input.models ?? null })
  return c.json(group(c, row.id), 201)
})

api.patch("/groups/:id", async (c) => {
  need(c, "group.write")
  const input = await body(
    c,
    z.object({ name: z.string().min(1).max(200).optional(), models: Access.nullable().optional() }),
  )
  const before = group(c, c.req.param("id"))
  c.var.store.group.update(c.var.org.id, before.id, input)
  const after = group(c, before.id)
  audit(c, "group.update", before.id, { changed: changed(before, after), models: after.models })
  return c.json(after)
})

api.put("/groups/:id/members", async (c) => {
  need(c, "group.write")
  const input = await body(c, z.object({ users: z.array(z.string()).max(10_000) }))
  const before = group(c, c.req.param("id"))
  c.var.store.group.assign(c.var.org.id, before.id, input.users)
  const after = group(c, before.id)
  audit(c, "group.update", before.id, {
    members: delta(
      before.members.map((user) => user.email),
      after.members.map((user) => user.email),
    ),
  })
  return c.json(after)
})

api.delete("/groups/:id", (c) => {
  need(c, "group.write")
  const row = group(c, c.req.param("id"))
  c.var.store.group.remove(c.var.org.id, row.id)
  audit(c, "group.delete", row.id, { name: row.name })
  return c.body(null, 204)
})

// ---- policy -------------------------------------------------------------------------------

api.get("/policy", (c) => {
  need(c, "policy.read")
  return c.json(c.var.store.policy.get(c.var.org.id))
})

api.put("/policy", async (c) => {
  need(c, "policy.write")
  const input = await body(c, Policy)
  const store = c.var.store
  const before = store.policy.get(c.var.org.id).policy
  const after = store.policy.set(c.var.org.id, input, c.var.user.id)
  audit(c, "policy.update", c.var.org.id, {
    version: after.version,
    changed: changed(before, after.policy),
    blocked: delta(before.models.blocked, after.policy.models.blocked),
  })
  return c.json(after)
})

// What a client enforces for the calling user. Clients poll this; the ETag makes unchanged polls cheap.
api.get("/policy/effective", async (c) => {
  const store = c.var.store
  const org = c.var.org
  const current = store.policy.get(org.id)
  const effective = resolve({
    policy: current.policy,
    version: current.version,
    groups: store.group
      .of(org.id, c.var.user.id)
      .map((row) => ({ name: row.name, models: Access.nullable().parse(json(row.models, null)) })),
    modes: store.mode.list(org.id),
    budgets: store.budget.status(org.id, c.var.user.id),
  })
  const payload = {
    org: { id: org.id, slug: org.slug, name: org.name },
    user: { id: c.var.user.id, email: c.var.user.email, role: c.var.role },
    ttl: 300,
    ...effective,
  }
  const text = JSON.stringify(payload)
  const etag = `"${crypto.hash(text).slice(0, 32)}"`
  if (c.req.header("if-none-match") === etag) return c.body(null, 304, { etag })
  return c.body(text, 200, { "content-type": "application/json", etag, "cache-control": "private, no-cache" })
})

// ---- custom modes (org-managed agents) ----------------------------------------------------

api.get("/modes", (c) => {
  need(c, "mode.read")
  return c.json({ modes: c.var.store.mode.list(c.var.org.id) })
})

api.post("/modes", async (c) => {
  need(c, "mode.write")
  const input = await body(c, Mode)
  const store = c.var.store
  if (store.mode.get(c.var.org.id, input.slug)) fail(409, "a mode with this slug exists")
  const row = store.mode.save(c.var.org.id, input)
  audit(c, "custom_mode.create", row.id, { slug: row.slug, name: row.name })
  return c.json(row, 201)
})

api.put("/modes/:id", async (c) => {
  need(c, "mode.write")
  const input = await body(c, Mode)
  const store = c.var.store
  const current = store.mode.get(c.var.org.id, c.req.param("id")) ?? fail(404, "mode not found")
  const clash = store.mode.get(c.var.org.id, input.slug)
  if (clash && clash.id !== current.id) fail(409, "a mode with this slug exists")
  const row = store.mode.save(c.var.org.id, input, current.id)
  audit(c, "custom_mode.update", row.id, { slug: row.slug, changed: changed(current, row) })
  return c.json(row)
})

api.delete("/modes/:id", (c) => {
  need(c, "mode.write")
  const store = c.var.store
  const current = store.mode.get(c.var.org.id, c.req.param("id")) ?? fail(404, "mode not found")
  store.mode.remove(c.var.org.id, current.id)
  audit(c, "custom_mode.delete", current.id, { slug: current.slug })
  return c.body(null, 204)
})

// ---- audit log ----------------------------------------------------------------------------

api.get("/audit", (c) => {
  need(c, "audit.read")
  const query = c.req.query()
  const rows = c.var.store.audit.query({
    org: c.var.org.id,
    actions: query.action
      ?.split(",")
      .map((item) => item.trim())
      .filter(Boolean),
    actor: query.actor,
    from: query.from ? time(query.from, 0) : undefined,
    to: query.to ? time(query.to, 0) : undefined,
    before: query.before ? Number(query.before) : undefined,
    limit: Math.min(Math.max(Number(query.limit ?? 100) || 100, 1), query.format === "csv" ? 100_000 : 1000),
  })
  const events = rows.map((row) => ({ ...row, details: json(row.details, {}) }))
  if (query.format === "csv")
    return c.body(
      csv(
        events.map((row) => ({ ...row, at: new Date(row.at).toISOString() })),
        ["id", "at", "action", "email", "target", "details", "ip"],
      ),
      200,
      {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="audit-${c.var.org.slug}.csv"`,
      },
    )
  return c.json({ events, next: events.length ? events.at(-1)!.id : null })
})

// ---- usage --------------------------------------------------------------------------------

const Entry = z.object({
  id: z.string().min(1).max(200),
  at: z.number().int().nonnegative(),
  session: z.string().max(200).optional(),
  project: z.string().max(500).optional(),
  provider: z.string().min(1).max(200),
  model: z.string().min(1).max(300),
  tokens: z
    .object({
      input: z.number().int().nonnegative().default(0),
      output: z.number().int().nonnegative().default(0),
      reasoning: z.number().int().nonnegative().default(0),
      cache: z
        .object({ read: z.number().int().nonnegative().default(0), write: z.number().int().nonnegative().default(0) })
        .prefault({}),
    })
    .prefault({}),
  cost: z.number().nonnegative().max(1_000_000).default(0),
})

api.post("/usage", async (c) => {
  const input = await body(c, z.object({ records: z.array(Entry).max(1000) }))
  const store = c.var.store
  const limit = store.now() + day
  const accepted = store.usage.record(
    c.var.org.id,
    c.var.user.id,
    input.records.map((row) => ({
      id: row.id,
      // Never trust a client clock to push spend outside the current budget window.
      at: Math.min(row.at, limit),
      session: row.session,
      project: row.project,
      provider: row.provider,
      model: row.model,
      input: row.tokens.input,
      output: row.tokens.output,
      reasoning: row.tokens.reasoning,
      read: row.tokens.cache.read,
      write: row.tokens.cache.write,
      cost: row.cost,
    })),
  )
  return c.json({ accepted })
})

function range(c: Ctx) {
  const now = c.var.store.now()
  return { from: time(c.req.query("from"), now - 30 * day), to: time(c.req.query("to"), now + 1) }
}

api.get("/usage", (c) => {
  const by = z.enum(["user", "model", "provider", "day", "project"]).catch("user").parse(c.req.query("by"))
  // Without usage.read a member can only ever see their own usage.
  const user = can(c.var.role, "usage.read") ? c.req.query("user") : c.var.user.id
  const window = range(c)
  return c.json({ by, ...window, rows: c.var.store.usage.summary({ org: c.var.org.id, by, user, ...window }) })
})

api.get("/usage/export", (c) => {
  need(c, "usage.read")
  const rows = c.var.store.usage.rows({ org: c.var.org.id, ...range(c) })
  return c.body(
    csv(
      rows.map((row) => ({ ...row, at: new Date(Number(row.at)).toISOString() })),
      [
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
      ],
    ),
    200,
    {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="usage-${c.var.org.slug}.csv"`,
    },
  )
})

// ---- budgets ------------------------------------------------------------------------------

api.get("/budgets", (c) => {
  need(c, "usage.read")
  return c.json({ budgets: c.var.store.budget.list(c.var.org.id) })
})

api.put("/budgets", async (c) => {
  need(c, "budget.write")
  const input = await body(
    c,
    z.object({
      budgets: z
        .array(
          z.object({
            scope: z.enum(["org", "member", "user"]),
            target: z.string().default(""),
            period: z.enum(["day", "month"]),
            amount: z.number().nonnegative().max(10_000_000),
          }),
        )
        .max(10_000),
    }),
  )
  const store = c.var.store
  const rows = input.budgets.map((row) => ({ ...row, target: row.scope === "user" ? row.target : "" }))
  for (const row of rows)
    if (row.scope === "user" && !store.member.get(c.var.org.id, row.target)) fail(400, `not a member: ${row.target}`)
  const before = store.budget.list(c.var.org.id)
  store.budget.replace(c.var.org.id, rows)
  audit(c, "budget.update", c.var.org.id, { before, after: rows })
  return c.json({ budgets: store.budget.list(c.var.org.id) })
})

// ---- single sign-on -----------------------------------------------------------------------

api.get("/sso", (c) => {
  need(c, "sso.write")
  const row = c.var.store.sso.get(c.var.org.id)
  const base = c.var.config.base
  return c.json({
    configured: row != null,
    issuer: row?.issuer ?? null,
    client_id: row?.client ?? null,
    scopes: row?.scopes ?? null,
    enforce: row?.enforce === 1,
    provision: row ? row.provision === 1 : null,
    redirect_uri: `${base}/sso/callback`,
    login_url: `${base}/sso/${c.var.org.slug}/start`,
  })
})

api.put("/sso", async (c) => {
  need(c, "sso.write")
  const config = c.var.config
  if (!config.secret) fail(400, "set ENTERPRISE_SECRET on the server before configuring single sign-on")
  const input = await body(
    c,
    z.object({
      issuer: z.url(),
      client_id: z.string().min(1),
      client_secret: z.string().min(1).optional(),
      scopes: z.string().default("openid email profile"),
      enforce: z.boolean().default(false),
      provision: z.boolean().default(true),
    }),
  )
  if (!input.scopes.split(/\s+/).includes("openid")) fail(400, "scopes must include openid")
  const store = c.var.store
  const current = store.sso.get(c.var.org.id)
  if (!current && !input.client_secret) fail(400, "client_secret is required")
  // Fail fast on a typo'd issuer instead of at the first user's login.
  await discover(input.issuer).catch((err: Error) => fail(400, `cannot reach issuer: ${err.message}`))
  store.sso.set(c.var.org.id, {
    issuer: input.issuer,
    client: input.client_id,
    secret: input.client_secret ? await crypto.seal(config.secret, input.client_secret) : current!.secret,
    scopes: input.scopes,
    enforce: input.enforce,
    provision: input.provision,
  })
  audit(c, "sso.update", c.var.org.id, {
    issuer: input.issuer,
    client_id: input.client_id,
    enforce: input.enforce,
    provision: input.provision,
    secret_rotated: input.client_secret != null,
  })
  return c.json({ ok: true })
})

api.delete("/sso", (c) => {
  need(c, "sso.write")
  c.var.store.sso.remove(c.var.org.id)
  audit(c, "sso.remove", c.var.org.id)
  return c.body(null, 204)
})

// ---- verified domains (SSO auto-join) -----------------------------------------------------

api.get("/domains", (c) => {
  need(c, "domain.write")
  return c.json({
    domains: c.var.store.domain.list(c.var.org.id).map((row) => ({
      name: row.name,
      verified: row.verified,
      record: { type: "TXT", name: row.name, value: row.token },
    })),
  })
})

api.post("/domains", async (c) => {
  need(c, "domain.write")
  const input = await body(c, z.object({ domain: Hostname }))
  const store = c.var.store
  if (store.domain.get(input.domain)) fail(409, "this domain is already registered")
  const row = store.domain.create(c.var.org.id, input.domain)
  audit(c, "domain.create", row.name)
  return c.json({ name: row.name, verified: null, record: { type: "TXT", name: row.name, value: row.token } }, 201)
})

api.post("/domains/:name/verify", async (c) => {
  need(c, "domain.write")
  const store = c.var.store
  const row = store.domain.get(c.req.param("name"))
  if (!row || row.org !== c.var.org.id) fail(404, "domain not found")
  const records = await c.var.config.txt(row.name).catch(() => [] as string[][])
  if (!records.some((parts) => parts.join("") === row.token))
    fail(400, `TXT record not found: add a TXT record on ${row.name} with value ${row.token}`)
  store.domain.verify(row.name)
  audit(c, "sso.set_domain", row.name)
  return c.json({ name: row.name, verified: store.now() })
})

api.delete("/domains/:name", (c) => {
  need(c, "domain.write")
  if (!c.var.store.domain.remove(c.var.org.id, c.req.param("name"))) fail(404, "domain not found")
  audit(c, "sso.remove_domain", c.req.param("name").toLowerCase())
  return c.body(null, 204)
})

// ---- SCIM provisioning tokens -------------------------------------------------------------

api.get("/scim/tokens", (c) => {
  need(c, "scim.write")
  return c.json({ tokens: c.var.store.token.list({ org: c.var.org.id, kind: "scim" }) })
})

api.post("/scim/tokens", async (c) => {
  need(c, "scim.write")
  const input = await body(c, z.object({ name: z.string().min(1).max(100).default("SCIM") }))
  const issued = c.var.store.token.issue({ kind: "scim", org: c.var.org.id, name: input.name })
  audit(c, "scim.token_create", issued.id, { name: input.name })
  return c.json({ id: issued.id, token: issued.value, base: `${c.var.config.base}/scim/v2` }, 201)
})

api.delete("/scim/tokens/:id", (c) => {
  need(c, "scim.write")
  const row = c.var.store.token.get(c.req.param("id"))
  if (!row || row.kind !== "scim" || row.org !== c.var.org.id) fail(404, "token not found")
  c.var.store.token.revoke(row.id)
  audit(c, "scim.token_revoke", row.id)
  return c.body(null, 204)
})

// ---- sub-organizations (one level deep) ---------------------------------------------------

api.get("/suborgs", (c) => {
  need(c, "suborg.read")
  const store = c.var.store
  const date = new Date(store.now())
  const month = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)
  return c.json({
    suborgs: store.org.children(c.var.org.id).map((org) => ({
      ...view(org),
      members: store.member.list(org.id).length,
      spent: store.usage.spent({ org: org.id, from: month }),
    })),
  })
})

api.post("/suborgs", async (c) => {
  need(c, "suborg.write")
  if (c.var.org.parent) fail(400, "sub-organizations cannot have their own sub-organizations")
  const input = await body(c, z.object({ name: z.string().min(1).max(200), slug: Slug }))
  const store = c.var.store
  if (store.org.get(input.slug)) fail(409, "this slug is taken")
  const child = store.org.create({ name: input.name, slug: input.slug, parent: c.var.org.id })
  audit(c, "organization.create", child.id, { name: child.name, slug: child.slug, parent: c.var.org.id })
  store.audit.record({
    org: child.id,
    action: "organization.create",
    actor: { id: c.var.user.id, email: c.var.user.email },
    target: child.id,
    details: { name: child.name, slug: child.slug, parent: c.var.org.id },
  })
  return c.json({ org: view(child) }, 201)
})
