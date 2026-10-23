import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { setup } from "./fixture"

describe("authentication and scoping", () => {
  test("bootstrap token identifies the owner", async () => {
    const env = await setup()
    const res = await env.call("GET", "/api/v1/me", { token: env.owner.token })
    expect(res.status).toBe(200)
    expect(res.data.user.email).toBe("owner@acme.com")
    expect(res.data.orgs).toEqual([
      { id: env.owner.org.id, slug: "acme", name: "Acme", parent: null, role: "owner", inherited: false },
    ])
  })

  test("missing, unknown and revoked tokens are rejected", async () => {
    const env = await setup()
    expect((await env.call("GET", "/api/v1/me")).status).toBe(401)
    expect((await env.call("GET", "/api/v1/me", { token: "ent_nope" })).status).toBe(401)
    const created = await env.call("POST", "/api/v1/me/tokens", { token: env.owner.token, body: { name: "laptop" } })
    expect(created.status).toBe(201)
    expect((await env.call("GET", "/api/v1/me", { token: created.data.token })).status).toBe(200)
    expect((await env.call("DELETE", `/api/v1/me/tokens/${created.data.id}`, { token: env.owner.token })).status).toBe(
      204,
    )
    expect((await env.call("GET", "/api/v1/me", { token: created.data.token })).status).toBe(401)
  })

  test("a token issued for one org never reaches another org the user belongs to", async () => {
    const env = await setup()
    const other = await env.store.org.create({ name: "Globex", slug: "globex" })
    await env.store.member.add(other.id, env.owner.user.id, "owner")
    const res = await env.call("GET", "/api/v1/orgs/globex", { token: env.owner.token })
    expect(res.status).toBe(404)
  })

  test("logout revokes the current token and is audited", async () => {
    const env = await setup()
    expect((await env.call("POST", "/api/v1/auth/logout", { token: env.owner.token })).status).toBe(204)
    expect((await env.call("GET", "/api/v1/me", { token: env.owner.token })).status).toBe(401)
    expect(await env.store.audit.query({ org: env.owner.org.id, actions: ["user.logout"], limit: 10 })).toHaveLength(1)
  })

  test("cookie sessions must send a same-origin Origin header on writes", async () => {
    const env = await setup()
    const headers = { cookie: `ent_session=${env.owner.token}` }
    expect((await env.call("GET", "/api/v1/orgs/acme", { headers })).status).toBe(200)
    const blocked = await env.call("PATCH", "/api/v1/orgs/acme", { headers, body: { name: "Evil" } })
    expect(blocked.status).toBe(403)
    const allowed = await env.call("PATCH", "/api/v1/orgs/acme", {
      headers: { ...headers, origin: "http://localhost:8787" },
      body: { name: "Acme Corp" },
    })
    expect(allowed.status).toBe(200)
    expect(allowed.data.org.name).toBe("Acme Corp")
  })

  test("deactivated users lose access immediately", async () => {
    const env = await setup()
    const dev = await env.join("dev@acme.com", "member")
    await env.store.user.update(dev.user.id, { active: false })
    expect((await env.call("GET", "/api/v1/orgs/acme", { token: dev.token })).status).toBe(401)
  })
})

describe("roles", () => {
  test("members cannot change governance settings", async () => {
    const env = await setup()
    const dev = await env.join("dev@acme.com", "member")
    expect((await env.call("PUT", "/api/v1/orgs/acme/policy", { token: dev.token, body: {} })).status).toBe(403)
    expect((await env.call("GET", "/api/v1/orgs/acme/audit", { token: dev.token })).status).toBe(403)
    expect((await env.call("GET", "/api/v1/orgs/acme/members", { token: dev.token })).status).toBe(403)
  })

  test("admins manage members but cannot touch owners or grant ownership", async () => {
    const env = await setup()
    const admin = await env.join("admin@acme.com", "admin")
    const dev = await env.join("dev@acme.com", "member")
    const promote = await env.call("PATCH", `/api/v1/orgs/acme/members/${dev.user.id}`, {
      token: admin.token,
      body: { role: "owner" },
    })
    expect(promote.status).toBe(403)
    const demote = await env.call("PATCH", `/api/v1/orgs/acme/members/${env.owner.user.id}`, {
      token: admin.token,
      body: { role: "member" },
    })
    expect(demote.status).toBe(403)
    const billing = await env.call("PATCH", `/api/v1/orgs/acme/members/${dev.user.id}`, {
      token: admin.token,
      body: { role: "billing_manager" },
    })
    expect(billing.status).toBe(200)
    // Admins cannot edit model access (owner-only governance).
    expect((await env.call("PUT", "/api/v1/orgs/acme/policy", { token: admin.token, body: {} })).status).toBe(403)
  })

  test("the last owner can be neither demoted nor removed", async () => {
    const env = await setup()
    const demote = await env.call("PATCH", `/api/v1/orgs/acme/members/${env.owner.user.id}`, {
      token: env.owner.token,
      body: { role: "admin" },
    })
    expect(demote.status).toBe(409)
    const remove = await env.call("DELETE", `/api/v1/orgs/acme/members/${env.owner.user.id}`, {
      token: env.owner.token,
    })
    expect(remove.status).toBe(409)
  })

  test("role changes and removals are audited with before and after", async () => {
    const env = await setup()
    const dev = await env.join("dev@acme.com", "member")
    await env.call("PATCH", `/api/v1/orgs/acme/members/${dev.user.id}`, {
      token: env.owner.token,
      body: { role: "admin" },
    })
    await env.call("DELETE", `/api/v1/orgs/acme/members/${dev.user.id}`, { token: env.owner.token })
    const events = await env.call("GET", "/api/v1/orgs/acme/audit?action=member.change_role,member.remove", {
      token: env.owner.token,
    })
    expect(events.data.events.map((event: { action: string }) => event.action)).toEqual([
      "member.remove",
      "member.change_role",
    ])
    expect(events.data.events[1].details).toEqual({ from: "member", to: "admin" })
    expect(events.data.events[1].email).toBe("owner@acme.com")
    expect(events.data.events[1].ip).toBe("203.0.113.7")
  })
})

describe("sub-organizations", () => {
  test("parent managers administer sub-orgs without membership; sub-org tokens never reach the parent", async () => {
    const env = await setup()
    const created = await env.call("POST", "/api/v1/orgs/acme/suborgs", {
      token: env.owner.token,
      body: { name: "Acme EU", slug: "acme-eu" },
    })
    expect(created.status).toBe(201)
    const child = await env.call("GET", "/api/v1/orgs/acme-eu", { token: env.owner.token })
    expect(child.data).toMatchObject({ role: "owner", inherited: true })
    const dev = await env.join("dev@acme.com", "member", created.data.org.id)
    expect((await env.call("GET", "/api/v1/orgs/acme", { token: dev.token })).status).toBe(404)
    const nested = await env.call("POST", "/api/v1/orgs/acme-eu/suborgs", {
      token: env.owner.token,
      body: { name: "Too deep", slug: "too-deep" },
    })
    expect(nested.status).toBe(400)
    const listed = await env.call("GET", "/api/v1/orgs/acme/suborgs", { token: env.owner.token })
    expect(listed.data.suborgs).toHaveLength(1)
    expect(listed.data.suborgs[0]).toMatchObject({ slug: "acme-eu", members: 1, spent: 0 })
  })

  test("parent members without a manager role inherit nothing", async () => {
    const env = await setup()
    const child = await env.store.org.create({ name: "Acme EU", slug: "acme-eu", parent: env.owner.org.id })
    const dev = await env.join("dev@acme.com", "member")
    expect(await env.store.member.role(child.id, dev.user.id)).toBeUndefined()
  })
})

describe("invites", () => {
  test("an invite is single use and grants the invited role", async () => {
    const env = await setup()
    const invite = await env.call("POST", "/api/v1/orgs/acme/invites", {
      token: env.owner.token,
      body: { email: "New.Hire@Acme.com", role: "admin" },
    })
    expect(invite.status).toBe(201)
    const accepted = await env.call("POST", `/api/v1/invites/${invite.data.token}/accept`, {
      body: { name: "New Hire" },
    })
    expect(accepted.status).toBe(200)
    const org = await env.call("GET", "/api/v1/orgs/acme", { token: accepted.data.token })
    expect(org.data.role).toBe("admin")
    expect(accepted.data.user.email).toBe("new.hire@acme.com")
    expect((await env.call("POST", `/api/v1/invites/${invite.data.token}/accept`, { body: {} })).status).toBe(404)
  })

  test("revoked invites cannot be accepted", async () => {
    const env = await setup()
    const invite = await env.call("POST", "/api/v1/orgs/acme/invites", {
      token: env.owner.token,
      body: { email: "x@acme.com" },
    })
    expect(
      (await env.call("DELETE", `/api/v1/orgs/acme/invites/${invite.data.id}`, { token: env.owner.token })).status,
    ).toBe(204)
    expect((await env.call("POST", `/api/v1/invites/${invite.data.token}/accept`, { body: {} })).status).toBe(404)
  })

  test("orgs that enforce SSO refuse invite links and admin-issued tokens", async () => {
    const env = await setup()
    await env.store.sso.set(env.owner.org.id, {
      issuer: "https://idp.example.com",
      client: "c",
      secret: "s",
      scopes: "openid email",
      enforce: true,
      provision: true,
    })
    const invite = await env.call("POST", "/api/v1/orgs/acme/invites", {
      token: env.owner.token,
      body: { email: "x@acme.com" },
    })
    expect((await env.call("POST", `/api/v1/invites/${invite.data.token}/accept`, { body: {} })).status).toBe(403)
    const dev = await env.join("dev@acme.com", "member")
    const issued = await env.call("POST", `/api/v1/orgs/acme/members/${dev.user.id}/tokens`, {
      token: env.owner.token,
      body: {},
    })
    expect(issued.status).toBe(403)
  })
})

describe("policy", () => {
  test("invalid policies are rejected with a readable error", async () => {
    const env = await setup()
    const res = await env.call("PUT", "/api/v1/orgs/acme/policy", {
      token: env.owner.token,
      body: { models: { default: { mode: "some" } } },
    })
    expect(res.status).toBe(400)
    expect(res.data.message).toContain("mode")
    expect(res.data._tag).toBe("InvalidRequestError")
  })

  test("effective policy combines the org ceiling, defaults and group grants for the caller", async () => {
    const env = await setup()
    const dev = await env.join("dev@acme.com", "member")
    const saved = await env.call("PUT", "/api/v1/orgs/acme/policy", {
      token: env.owner.token,
      body: {
        models: { blocked: ["openai"], default: { mode: "selected", items: ["anthropic/claude-sonnet-*"] } },
        permission: { bash: { "rm -rf *": "deny" } },
        instructions: "Never commit secrets.",
        share: "disabled",
      },
    })
    expect(saved.status).toBe(200)
    expect(saved.data.version).toBe(1)
    const group = await env.call("POST", "/api/v1/orgs/acme/groups", {
      token: env.owner.token,
      body: { name: "research", models: { mode: "selected", items: ["anthropic/claude-opus-*"] } },
    })
    await env.call("PUT", `/api/v1/orgs/acme/groups/${group.data.id}/members`, {
      token: env.owner.token,
      body: { users: [dev.user.id, "usr_not_a_member"] },
    })
    const effective = await env.call("GET", "/api/v1/orgs/acme/policy/effective", { token: dev.token })
    expect(effective.status).toBe(200)
    expect(effective.data).toMatchObject({
      org: { slug: "acme" },
      user: { email: "dev@acme.com", role: "member" },
      version: 1,
      groups: ["research"],
      models: { allow: ["anthropic/claude-sonnet-*", "anthropic/claude-opus-*"], deny: ["openai/*"] },
      permission: { bash: { "rm -rf *": "deny" } },
      instructions: "Never commit secrets.",
      share: "disabled",
    })
    // The owner isn't in the research group, so only the default applies.
    const owner = await env.call("GET", "/api/v1/orgs/acme/policy/effective", { token: env.owner.token })
    expect(owner.data.models.allow).toEqual(["anthropic/claude-sonnet-*"])
    const audit = await env.store.audit.query({ org: env.owner.org.id, actions: ["policy.update"], limit: 1 })
    expect((audit[0].details as { blocked: unknown }).blocked).toEqual({ added: ["openai"], removed: [] })
  })

  test("unchanged effective policy answers conditional requests with 304", async () => {
    const env = await setup()
    const first = await env.call("GET", "/api/v1/orgs/acme/policy/effective", { token: env.owner.token })
    const etag = first.headers.get("etag")!
    const again = await env.call("GET", "/api/v1/orgs/acme/policy/effective", {
      token: env.owner.token,
      headers: { "if-none-match": etag },
    })
    expect(again.status).toBe(304)
    await env.call("PUT", "/api/v1/orgs/acme/policy", { token: env.owner.token, body: { share: "allowed" } })
    const changed = await env.call("GET", "/api/v1/orgs/acme/policy/effective", {
      token: env.owner.token,
      headers: { "if-none-match": etag },
    })
    expect(changed.status).toBe(200)
  })

  test("members only see the names of their own groups", async () => {
    const env = await setup()
    const dev = await env.join("dev@acme.com", "member")
    const mine = await env.call("POST", "/api/v1/orgs/acme/groups", { token: env.owner.token, body: { name: "mine" } })
    await env.call("POST", "/api/v1/orgs/acme/groups", { token: env.owner.token, body: { name: "secret" } })
    await env.call("PUT", `/api/v1/orgs/acme/groups/${mine.data.id}/members`, {
      token: env.owner.token,
      body: { users: [dev.user.id] },
    })
    const res = await env.call("GET", "/api/v1/orgs/acme/groups/mine", { token: dev.token })
    expect(res.data.groups).toEqual([{ id: mine.data.id, name: "mine" }])
    expect((await env.call("GET", "/api/v1/orgs/acme/groups", { token: dev.token })).status).toBe(403)
  })

  test("org modes are delivered as agents and slugs stay unique", async () => {
    const env = await setup()
    const mode = { slug: "reviewer", name: "Reviewer", prompt: "Review diffs for security issues.", mode: "subagent" }
    expect((await env.call("POST", "/api/v1/orgs/acme/modes", { token: env.owner.token, body: mode })).status).toBe(201)
    expect((await env.call("POST", "/api/v1/orgs/acme/modes", { token: env.owner.token, body: mode })).status).toBe(409)
    const effective = await env.call("GET", "/api/v1/orgs/acme/policy/effective", { token: env.owner.token })
    expect(effective.data.agents.reviewer).toEqual({
      description: "Reviewer",
      prompt: "Review diffs for security issues.",
      mode: "subagent",
    })
    const events = await env.store.audit.query({ org: env.owner.org.id, actions: ["custom_mode.create"], limit: 5 })
    expect(events).toHaveLength(1)
  })
})

describe("usage and budgets", () => {
  const record = (id: string, cost: number, model = "claude-sonnet-4") => ({
    id,
    at: Date.now(),
    session: "ses_1",
    project: "web",
    provider: "anthropic",
    model,
    tokens: { input: 1000, output: 200, reasoning: 0, cache: { read: 50, write: 0 } },
    cost,
  })

  test("ingestion is idempotent per record id", async () => {
    const env = await setup()
    const first = await env.call("POST", "/api/v1/orgs/acme/usage", {
      token: env.owner.token,
      body: { records: [record("m1", 0.5)] },
    })
    const again = await env.call("POST", "/api/v1/orgs/acme/usage", {
      token: env.owner.token,
      body: { records: [record("m1", 0.5), record("m2", 0.25)] },
    })
    expect(first.data.accepted).toBe(1)
    expect(again.data.accepted).toBe(1)
    const summary = await env.call("GET", "/api/v1/orgs/acme/usage?by=model", { token: env.owner.token })
    expect(summary.data.rows).toEqual([
      {
        key: "anthropic/claude-sonnet-4",
        requests: 2,
        users: 1,
        input: 2000,
        output: 400,
        reasoning: 0,
        cache_read: 100,
        cache_write: 0,
        cost: 0.75,
      },
    ])
  })

  test("members only ever see their own usage", async () => {
    const env = await setup()
    const dev = await env.join("dev@acme.com", "member")
    await env.call("POST", "/api/v1/orgs/acme/usage", { token: env.owner.token, body: { records: [record("o1", 5)] } })
    await env.call("POST", "/api/v1/orgs/acme/usage", { token: dev.token, body: { records: [record("d1", 1)] } })
    const own = await env.call("GET", `/api/v1/orgs/acme/usage?by=user&user=${env.owner.user.id}`, { token: dev.token })
    expect(own.data.rows.map((row: { key: string }) => row.key)).toEqual(["dev@acme.com"])
    const all = await env.call("GET", "/api/v1/orgs/acme/usage?by=user", { token: env.owner.token })
    expect(all.data.rows.map((row: { key: string }) => row.key)).toEqual(["owner@acme.com", "dev@acme.com"])
    expect((await env.call("GET", "/api/v1/orgs/acme/usage/export", { token: dev.token })).status).toBe(403)
  })

  test("CSV exports neutralise spreadsheet formulas", async () => {
    const env = await setup()
    await env.call("POST", "/api/v1/orgs/acme/usage", {
      token: env.owner.token,
      body: { records: [{ ...record("x1", 1), project: '=HYPERLINK("http://evil")' }] },
    })
    const res = await env.call("GET", "/api/v1/orgs/acme/usage/export", { token: env.owner.token })
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/csv")
    expect(res.data).toContain(`"'=HYPERLINK(""http://evil"")"`)
  })

  test("per-member budgets flag the effective policy once spend reaches them, user overrides win", async () => {
    const env = await setup()
    const dev = await env.join("dev@acme.com", "member")
    const vip = await env.join("vip@acme.com", "member")
    const saved = await env.call("PUT", "/api/v1/orgs/acme/budgets", {
      token: env.owner.token,
      body: {
        budgets: [
          { scope: "member", period: "day", amount: 2 },
          { scope: "user", target: vip.user.id, period: "day", amount: 100 },
        ],
      },
    })
    expect(saved.status).toBe(200)
    await env.call("POST", "/api/v1/orgs/acme/usage", { token: dev.token, body: { records: [record("d1", 2.5)] } })
    await env.call("POST", "/api/v1/orgs/acme/usage", { token: vip.token, body: { records: [record("v1", 2.5)] } })
    const blocked = await env.call("GET", "/api/v1/orgs/acme/policy/effective", { token: dev.token })
    expect(blocked.data.budget).toEqual({
      exceeded: true,
      limits: [{ scope: "member", period: "day", amount: 2, spent: 2.5 }],
    })
    const fine = await env.call("GET", "/api/v1/orgs/acme/policy/effective", { token: vip.token })
    expect(fine.data.budget).toEqual({
      exceeded: false,
      limits: [{ scope: "user", period: "day", amount: 100, spent: 2.5 }],
    })
  })

  test("only owners and billing managers set budgets", async () => {
    const env = await setup()
    const admin = await env.join("admin@acme.com", "admin")
    const billing = await env.join("billing@acme.com", "billing_manager")
    const body = { budgets: [{ scope: "org", period: "month", amount: 1000 }] }
    expect((await env.call("PUT", "/api/v1/orgs/acme/budgets", { token: admin.token, body })).status).toBe(403)
    expect((await env.call("PUT", "/api/v1/orgs/acme/budgets", { token: billing.token, body })).status).toBe(200)
  })
})

describe("audit log", () => {
  test("filters by actor and exports CSV", async () => {
    const env = await setup()
    const admin = await env.join("admin@acme.com", "admin")
    await env.call("POST", "/api/v1/orgs/acme/invites", { token: admin.token, body: { email: "a@acme.com" } })
    await env.call("POST", "/api/v1/orgs/acme/invites", { token: env.owner.token, body: { email: "b@acme.com" } })
    const filtered = await env.call("GET", "/api/v1/orgs/acme/audit?actor=ADMIN@acme.com", { token: env.owner.token })
    expect(filtered.data.events.map((event: { action: string }) => event.action)).toEqual(["user.send_invite"])
    const exported = await env.call("GET", "/api/v1/orgs/acme/audit/export?action=user.send_invite", {
      token: env.owner.token,
    })
    expect(exported.data.split("\n")[0]).toBe("id,at,action,email,target,details,ip")
    expect(exported.data.trim().split("\n")).toHaveLength(3)
  })

  test("pages with the before cursor", async () => {
    const env = await setup()
    for (const name of ["a", "b", "c"])
      await env.call("POST", "/api/v1/orgs/acme/groups", { token: env.owner.token, body: { name } })
    const first = await env.call("GET", "/api/v1/orgs/acme/audit?action=group.create&limit=2", {
      token: env.owner.token,
    })
    expect(first.data.events.map((event: { details: { name: string } }) => event.details.name)).toEqual(["c", "b"])
    const next = await env.call(
      "GET",
      `/api/v1/orgs/acme/audit?action=group.create&limit=2&before=${first.data.next}`,
      {
        token: env.owner.token,
      },
    )
    expect(next.data.events.map((event: { details: { name: string } }) => event.details.name)).toEqual(["a"])
  })
})

describe("verified domains", () => {
  test("a domain verifies only when its TXT record carries the token", async () => {
    const records: Record<string, string[][]> = {}
    const env = await setup({ txt: (name) => Effect.succeed(records[name] ?? []) })
    const created = await env.call("POST", "/api/v1/orgs/acme/domains", {
      token: env.owner.token,
      body: { domain: "Acme.com" },
    })
    expect(created.status).toBe(201)
    expect(created.data.name).toBe("acme.com")
    expect(
      (await env.call("POST", "/api/v1/orgs/acme/domains/acme.com/verify", { token: env.owner.token })).status,
    ).toBe(400)
    records["acme.com"] = [
      ["v=spf1 -all"],
      [created.data.record.value.slice(0, 10), created.data.record.value.slice(10)],
    ]
    expect(
      (await env.call("POST", "/api/v1/orgs/acme/domains/acme.com/verify", { token: env.owner.token })).status,
    ).toBe(200)
    expect(await env.store.domain.owner("someone@ACME.com")).toBe(env.owner.org.id)
    const other = await env.store.org.create({ name: "Globex", slug: "globex" })
    const steal = await env.join("x@globex.com", "owner", other.id)
    expect(
      (await env.call("POST", "/api/v1/orgs/globex/domains", { token: steal.token, body: { domain: "acme.com" } }))
        .status,
    ).toBe(409)
  })
})

describe("admin console", () => {
  test("is served as a single-page app with a strict content security policy", async () => {
    const env = await setup()
    const page = await env.server.request("/admin")
    expect(page.status).toBe(200)
    expect(page.headers.get("content-type")).toContain("text/html")
    expect(page.headers.get("content-security-policy")).toContain("script-src 'self'")
    expect(page.headers.get("x-frame-options")).toBeTruthy()
    expect(await page.text()).toContain('src="/admin/assets/index.js"')
    // Client-side routes fall back to the app; unknown assets do not.
    expect((await env.server.request("/admin/members")).status).toBe(200)
    expect((await env.server.request("/admin/assets/missing.js")).status).toBe(404)
    const script = await env.server.request("/admin/assets/index.js")
    expect(script.headers.get("content-type")).toContain("text/javascript")
    expect(script.headers.get("cache-control")).toContain("immutable")
    expect((await env.server.request("/")).headers.get("location")).toBe("/admin")
  })
})

describe("transport", () => {
  test("malformed JSON is a 400, not a server error", async () => {
    const env = await setup()
    const res = await env.server.request("/api/v1/me/tokens", {
      method: "POST",
      headers: { authorization: `Bearer ${env.owner.token}`, "content-type": "application/json" },
      body: "{not json",
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ _tag: "InvalidRequestError", message: "request body must be valid JSON" })
  })

  test("roles are checked before the body is validated", async () => {
    const env = await setup()
    const dev = await env.join("dev@acme.com", "member")
    const res = await env.call("PUT", "/api/v1/orgs/acme/policy", {
      token: dev.token,
      body: { models: { default: { mode: "some" } } },
    })
    expect(res.status).toBe(403)
    expect(res.data).toEqual({ _tag: "ForbiddenError", message: "your role (member) cannot perform policy.write" })
  })

  test("serves the OpenAPI document generated from the shared contract", async () => {
    const env = await setup()
    const res = await env.call("GET", "/api/v1/openapi.json")
    expect(res.status).toBe(200)
    expect(Object.keys(res.data.paths)).toContain("/api/v1/orgs/{org}/policy/effective")
  })

  test("unknown routes answer with a JSON 404 and every response carries security headers", async () => {
    const env = await setup()
    const res = await env.call("GET", "/api/v1/nope")
    expect(res.status).toBe(404)
    expect(res.data._tag).toBe("NotFoundError")
    expect(res.headers.get("x-content-type-options")).toBe("nosniff")
    expect(res.headers.get("referrer-policy")).toBe("no-referrer")
  })

  test("an invite accepted twice at once admits one person", async () => {
    const env = await setup()
    const invite = await env.call("POST", "/api/v1/orgs/acme/invites", {
      token: env.owner.token,
      body: { email: "race@acme.com" },
    })
    const accept = () => env.call("POST", `/api/v1/invites/${invite.data.token}/accept`, { body: {} })
    const results = await Promise.all([accept(), accept(), accept()])
    expect(results.map((res) => res.status).sort((a, b) => a - b)).toEqual([200, 404, 404])
  })
})
