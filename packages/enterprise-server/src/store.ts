import type { Db } from "./db"
import { json } from "./db"
import * as crypto from "./crypto"
import { inherited, type Role } from "./roles"
import { Access, Mode, Policy, type Budget } from "./policy"

export type Org = { id: string; name: string; slug: string; parent: string | null; settings: string; created: number }
export type User = {
  id: string
  email: string
  name: string | null
  external: string | null
  active: number
  created: number
}
export type Token = {
  id: string
  kind: "user" | "scim"
  user: string | null
  org: string
  name: string
  created: number
  expires: number | null
  used: number | null
  revoked: number | null
}
export type Group = {
  id: string
  org: string
  name: string
  external: string | null
  models: string | null
  created: number
}
export type Audit = {
  id: number
  org: string
  at: number
  action: string
  actor: string | null
  email: string | null
  target: string | null
  details: string
  ip: string | null
}

export type Store = ReturnType<typeof create>

export function create(db: Db, now: () => number = Date.now) {
  const org = {
    get(ref: string) {
      return db.query<Org, [string, string]>("select * from orgs where id = ? or slug = ?").get(ref, ref) ?? undefined
    },
    create(input: { name: string; slug: string; parent?: string }) {
      const row = { id: crypto.id("org"), name: input.name, slug: input.slug, parent: input.parent ?? null }
      db.query("insert into orgs (id, name, slug, parent, created) values (?, ?, ?, ?, ?)").run(
        row.id,
        row.name,
        row.slug,
        row.parent,
        now(),
      )
      return org.get(row.id)!
    },
    update(id: string, input: { name?: string; settings?: Record<string, unknown> }) {
      if (input.name != null) db.query("update orgs set name = ? where id = ?").run(input.name, id)
      if (input.settings != null)
        db.query("update orgs set settings = ? where id = ?").run(JSON.stringify(input.settings), id)
      return org.get(id)!
    },
    children(id: string) {
      return db.query<Org, [string]>("select * from orgs where parent = ? order by name").all(id)
    },
    count() {
      return db.query<{ n: number }, []>("select count(*) as n from orgs").get()!.n
    },
  }

  const user = {
    get(id: string) {
      return db.query<User, [string]>("select * from users where id = ?").get(id) ?? undefined
    },
    find(email: string) {
      return db.query<User, [string]>("select * from users where email = ?").get(email.trim()) ?? undefined
    },
    ensure(input: { email: string; name?: string | null; external?: string | null }) {
      const existing = user.find(input.email)
      if (existing) return existing
      const id = crypto.id("usr")
      db.query("insert into users (id, email, name, external, created) values (?, ?, ?, ?, ?)").run(
        id,
        input.email.trim().toLowerCase(),
        input.name ?? null,
        input.external ?? null,
        now(),
      )
      return user.get(id)!
    },
    update(id: string, input: { email?: string; name?: string | null; external?: string | null; active?: boolean }) {
      if (input.email != null)
        db.query("update users set email = ? where id = ?").run(input.email.trim().toLowerCase(), id)
      if (input.name !== undefined) db.query("update users set name = ? where id = ?").run(input.name, id)
      if (input.external !== undefined) db.query("update users set external = ? where id = ?").run(input.external, id)
      if (input.active != null) {
        db.query("update users set active = ? where id = ?").run(input.active ? 1 : 0, id)
        // Deactivation must cut off every live credential immediately.
        if (!input.active) db.query("update tokens set revoked = ? where user = ? and revoked is null").run(now(), id)
      }
      return user.get(id)!
    },
  }

  const member = {
    // Direct membership wins; otherwise a parent-org manager inherits their role in a sub-org.
    // Suspended memberships (SCIM active=false) grant nothing.
    role(orgID: string, userID: string): { role: Role; inherited: boolean } | undefined {
      const direct = db
        .query<
          { role: Role },
          [string, string]
        >("select role from members where org = ? and user = ? and suspended is null")
        .get(orgID, userID)
      if (direct) return { role: direct.role, inherited: false }
      const parent = db
        .query<
          { role: Role },
          [string, string]
        >("select m.role from orgs o join members m on m.org = o.parent where o.id = ? and m.user = ? and m.suspended is null")
        .get(orgID, userID)
      if (parent && inherited.includes(parent.role)) return { role: parent.role, inherited: true }
      return undefined
    },
    // Raw membership row, including suspended ones; used by SCIM which must see deactivated users.
    get(orgID: string, userID: string) {
      return (
        db
          .query<
            { role: Role; suspended: number | null },
            [string, string]
          >("select role, suspended from members where org = ? and user = ?")
          .get(orgID, userID) ?? undefined
      )
    },
    suspend(orgID: string, userID: string, value: boolean) {
      db.query("update members set suspended = ? where org = ? and user = ?").run(value ? now() : null, orgID, userID)
    },
    list(orgID: string) {
      return db
        .query<
          User & { role: Role; joined: number; suspended: number | null },
          [string]
        >("select u.*, m.role, m.created as joined, m.suspended from members m join users u on u.id = m.user where m.org = ? order by u.email")
        .all(orgID)
    },
    orgs(userID: string) {
      return db
        .query<
          Org & { role: Role },
          [string]
        >("select o.*, m.role from members m join orgs o on o.id = m.org where m.user = ? and m.suspended is null order by o.name")
        .all(userID)
    },
    // Memberships of any state; a user with none left is fully deprovisioned.
    count(userID: string) {
      return db.query<{ n: number }, [string]>("select count(*) as n from members where user = ?").get(userID)!.n
    },
    // Memberships outside this org and its sub-orgs. SCIM may only rewrite a user's identity
    // (email, name) when no other org depends on it.
    foreign(userID: string, orgID: string) {
      return db
        .query<
          { n: number },
          [string, string, string]
        >("select count(*) as n from members m join orgs o on o.id = m.org where m.user = ? and o.id <> ? and coalesce(o.parent, '') <> ?")
        .get(userID, orgID, orgID)!.n
    },
    add(orgID: string, userID: string, role: Role) {
      db.query("insert into members (org, user, role, created) values (?, ?, ?, ?) on conflict do nothing").run(
        orgID,
        userID,
        role,
        now(),
      )
    },
    set(orgID: string, userID: string, role: Role) {
      db.query("update members set role = ? where org = ? and user = ?").run(role, orgID, userID)
    },
    remove(orgID: string, userID: string) {
      db.query("delete from members where org = ? and user = ?").run(orgID, userID)
      db.query("delete from group_members where user = ? and grp in (select id from org_groups where org = ?)").run(
        userID,
        orgID,
      )
    },
    owners(orgID: string) {
      return db
        .query<
          { n: number },
          [string]
        >("select count(*) as n from members where org = ? and role = 'owner' and suspended is null")
        .get(orgID)!.n
    },
  }

  const sso = {
    get(orgID: string) {
      return (
        db
          .query<
            {
              org: string
              issuer: string
              client: string
              secret: string
              scopes: string
              enforce: number
              provision: number
              updated: number
            },
            [string]
          >("select * from sso where org = ?")
          .get(orgID) ?? undefined
      )
    },
    set(
      orgID: string,
      input: { issuer: string; client: string; secret: string; scopes: string; enforce: boolean; provision: boolean },
    ) {
      db.query(
        `insert into sso (org, issuer, client, secret, scopes, enforce, provision, updated) values (?, ?, ?, ?, ?, ?, ?, ?)
         on conflict (org) do update set issuer = excluded.issuer, client = excluded.client, secret = excluded.secret,
           scopes = excluded.scopes, enforce = excluded.enforce, provision = excluded.provision, updated = excluded.updated`,
      ).run(
        orgID,
        input.issuer,
        input.client,
        input.secret,
        input.scopes,
        input.enforce ? 1 : 0,
        input.provision ? 1 : 0,
        now(),
      )
    },
    remove(orgID: string) {
      db.query("delete from sso where org = ?").run(orgID)
    },
  }

  type Device = {
    hash: string
    code: string
    org: string
    user: string | null
    status: "pending" | "approved" | "denied" | "consumed"
    created: number
    expires: number
    polled: number | null
  }

  const device = {
    create(orgID: string, ttl: number) {
      const value = crypto.secret()
      const code = crypto.code()
      db.query("insert into devices (hash, code, org, status, created, expires) values (?, ?, ?, 'pending', ?, ?)").run(
        crypto.hash(value),
        code,
        orgID,
        now(),
        now() + ttl,
      )
      return { value, code }
    },
    find(value: string) {
      return db.query<Device, [string]>("select * from devices where hash = ?").get(crypto.hash(value)) ?? undefined
    },
    code(code: string) {
      return (
        db.query<Device, [string]>("select * from devices where code = ?").get(code.trim().toUpperCase()) ?? undefined
      )
    },
    poll(hash: string) {
      db.query("update devices set polled = ? where hash = ?").run(now(), hash)
    },
    // Only a pending, unexpired code can change state, so a code can never be approved twice.
    decide(code: string, status: "approved" | "denied", userID?: string) {
      return (
        db
          .query("update devices set status = ?, user = ? where code = ? and status = 'pending' and expires > ?")
          .run(status, userID ?? null, code, now()).changes > 0
      )
    },
    consume(hash: string) {
      return (
        db.query("update devices set status = 'consumed' where hash = ? and status = 'approved'").run(hash).changes > 0
      )
    },
  }

  const login = {
    create(input: { org: string; verifier: string; nonce: string; device?: string }) {
      const state = crypto.secret()
      db.query("insert into logins (state, org, verifier, nonce, device, created) values (?, ?, ?, ?, ?, ?)").run(
        state,
        input.org,
        input.verifier,
        input.nonce,
        input.device ?? null,
        now(),
      )
      return state
    },
    // Single use: the row is deleted as it is read.
    take(state: string) {
      return (
        db
          .query<
            { state: string; org: string; verifier: string; nonce: string; device: string | null; created: number },
            [string]
          >("delete from logins where state = ? returning *")
          .get(state) ?? undefined
      )
    },
  }

  type Invite = {
    id: string
    org: string
    email: string
    role: Role
    actor: string | null
    created: number
    expires: number
    accepted: number | null
    revoked: number | null
  }

  const invite = {
    create(input: { org: string; email: string; role: Role; actor: string; ttl: number }) {
      const value = crypto.secret()
      const id = crypto.id("inv")
      db.query(
        "insert into invites (id, org, email, role, hash, actor, created, expires) values (?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        id,
        input.org,
        input.email.trim().toLowerCase(),
        input.role,
        crypto.hash(value),
        input.actor,
        now(),
        now() + input.ttl,
      )
      return { id, value }
    },
    find(value: string) {
      return (
        db
          .query<
            Invite,
            [string, number]
          >("select * from invites where hash = ? and accepted is null and revoked is null and expires > ?")
          .get(crypto.hash(value), now()) ?? undefined
      )
    },
    pending(orgID: string, email?: string) {
      if (email)
        return db
          .query<
            Invite,
            [string, string, number]
          >("select * from invites where org = ? and email = ? and accepted is null and revoked is null and expires > ? order by created desc")
          .all(orgID, email.trim(), now())
      return db
        .query<
          Invite,
          [string, number]
        >("select * from invites where org = ? and accepted is null and revoked is null and expires > ? order by created desc")
        .all(orgID, now())
    },
    accept(id: string) {
      db.query("update invites set accepted = ? where id = ?").run(now(), id)
    },
    revoke(orgID: string, id: string) {
      return (
        db
          .query("update invites set revoked = ? where org = ? and id = ? and accepted is null and revoked is null")
          .run(now(), orgID, id).changes > 0
      )
    },
  }

  const domain = {
    list(orgID: string) {
      return db
        .query<
          { name: string; token: string; verified: number | null; created: number },
          [string]
        >("select name, token, verified, created from domains where org = ? order by name")
        .all(orgID)
    },
    get(name: string) {
      return (
        db
          .query<
            { name: string; org: string; token: string; verified: number | null },
            [string]
          >("select name, org, token, verified from domains where name = ?")
          .get(name.trim().toLowerCase()) ?? undefined
      )
    },
    create(orgID: string, name: string) {
      const token = `enterprise-verify=${crypto.secret(18)}`
      db.query("insert into domains (name, org, token, created) values (?, ?, ?, ?)").run(
        name.trim().toLowerCase(),
        orgID,
        token,
        now(),
      )
      return domain.get(name)!
    },
    verify(name: string) {
      db.query("update domains set verified = ? where name = ?").run(now(), name.trim().toLowerCase())
    },
    remove(orgID: string, name: string) {
      return (
        db.query("delete from domains where org = ? and name = ?").run(orgID, name.trim().toLowerCase()).changes > 0
      )
    },
    // The org that owns the verified domain of this email address, if any.
    owner(email: string) {
      const host = email.split("@").at(-1)?.toLowerCase()
      if (!host) return undefined
      return (
        db.query<{ org: string }, [string]>("select org from domains where name = ? and verified is not null").get(host)
          ?.org ?? undefined
      )
    },
  }

  // Housekeeping for short-lived rows: device codes, abandoned SSO logins, and audit history past
  // retention. Without a retention the audit log is kept forever.
  function sweep(retention?: number) {
    const day = 24 * 60 * 60 * 1000
    db.query("delete from devices where expires < ?").run(now() - day)
    db.query("delete from logins where created < ?").run(now() - day)
    if (retention == null) return 0
    return audit.prune(now() - retention)
  }

  const token = {
    // Every token is bound to one org. An org's IdP is configured by that org's own admins, so an
    // identity asserted through it must never carry into another org that happens to share the user.
    issue(input: { kind: "user" | "scim"; user?: string; org: string; name: string; ttl?: number }) {
      const value = crypto.token(input.kind)
      const row = crypto.id("tok")
      db.query(
        "insert into tokens (id, hash, kind, user, org, name, created, expires) values (?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        row,
        crypto.hash(value),
        input.kind,
        input.user ?? null,
        input.org,
        input.name,
        now(),
        input.ttl ? now() + input.ttl : null,
      )
      return { id: row, value }
    },
    verify(value: string) {
      const row = db.query<Token, [string]>("select * from tokens where hash = ?").get(crypto.hash(value))
      if (!row || row.revoked) return undefined
      if (row.expires && row.expires < now()) return undefined
      // Throttle last-used writes so every authenticated request doesn't hit the disk.
      if (row.used == null || now() - row.used > 60_000)
        db.query("update tokens set used = ? where id = ?").run(now(), row.id)
      return row
    },
    list(input: { org: string; user?: string; kind: "user" | "scim" }) {
      if (input.user)
        return db
          .query<
            Token,
            [string, string, string]
          >("select id, kind, user, org, name, created, expires, used, revoked from tokens where org = ? and user = ? and kind = ? order by created desc")
          .all(input.org, input.user, input.kind)
      return db
        .query<
          Token,
          [string, string]
        >("select id, kind, user, org, name, created, expires, used, revoked from tokens where org = ? and kind = ? order by created desc")
        .all(input.org, input.kind)
    },
    // A token reaches its own org, plus that org's sub-orgs (inherited management).
    reaches(row: Token, orgID: string) {
      if (row.org === orgID) return true
      return org.get(orgID)?.parent === row.org
    },
    revoke(id: string) {
      db.query("update tokens set revoked = ? where id = ? and revoked is null").run(now(), id)
    },
    get(id: string) {
      return db.query<Token, [string]>("select * from tokens where id = ?").get(id) ?? undefined
    },
  }

  const group = {
    list(orgID: string) {
      return db.query<Group, [string]>("select * from org_groups where org = ? order by name").all(orgID)
    },
    get(orgID: string, id: string) {
      return (
        db.query<Group, [string, string]>("select * from org_groups where org = ? and id = ?").get(orgID, id) ??
        undefined
      )
    },
    create(orgID: string, input: { name: string; external?: string | null; models?: Access | null }) {
      const id = crypto.id("grp")
      db.query("insert into org_groups (id, org, name, external, models, created) values (?, ?, ?, ?, ?, ?)").run(
        id,
        orgID,
        input.name,
        input.external ?? null,
        input.models ? JSON.stringify(input.models) : null,
        now(),
      )
      return group.get(orgID, id)!
    },
    update(orgID: string, id: string, input: { name?: string; external?: string | null; models?: Access | null }) {
      if (input.name != null)
        db.query("update org_groups set name = ? where org = ? and id = ?").run(input.name, orgID, id)
      if (input.external !== undefined)
        db.query("update org_groups set external = ? where org = ? and id = ?").run(input.external, orgID, id)
      if (input.models !== undefined)
        db.query("update org_groups set models = ? where org = ? and id = ?").run(
          input.models ? JSON.stringify(input.models) : null,
          orgID,
          id,
        )
      return group.get(orgID, id)!
    },
    remove(orgID: string, id: string) {
      db.query("delete from org_groups where org = ? and id = ?").run(orgID, id)
    },
    members(id: string) {
      return db
        .query<
          User,
          [string]
        >("select u.* from group_members g join users u on u.id = g.user where g.grp = ? order by u.email")
        .all(id)
    },
    // Replaces membership. Only direct org members (suspended ones included, so SCIM can keep
    // group state for deactivated users) may be placed in a group; anything else is skipped.
    assign(orgID: string, id: string, users: string[]) {
      db.transaction(() => {
        db.query("delete from group_members where grp = ?").run(id)
        for (const userID of users) group.join(orgID, id, userID)
      })()
    },
    join(orgID: string, id: string, userID: string) {
      if (!member.get(orgID, userID)) return false
      db.query("insert into group_members (grp, user) values (?, ?) on conflict do nothing").run(id, userID)
      return true
    },
    leave(id: string, userID: string) {
      db.query("delete from group_members where grp = ? and user = ?").run(id, userID)
    },
    of(orgID: string, userID: string) {
      return db
        .query<
          Group,
          [string, string]
        >("select g.* from org_groups g join group_members m on m.grp = g.id where g.org = ? and m.user = ? order by g.name")
        .all(orgID, userID)
    },
  }

  const policy = {
    get(orgID: string) {
      const row = db
        .query<
          { data: string; version: number; updated: number },
          [string]
        >("select data, version, updated from policies where org = ?")
        .get(orgID)
      return {
        policy: Policy.parse(json(row?.data, {})),
        version: row?.version ?? 0,
        updated: row?.updated ?? null,
      }
    },
    set(orgID: string, data: Policy, actor: string) {
      db.query(
        `insert into policies (org, data, version, updated, actor) values (?, ?, 1, ?, ?)
         on conflict (org) do update set data = excluded.data, version = version + 1, updated = excluded.updated, actor = excluded.actor`,
      ).run(orgID, JSON.stringify(data), now(), actor)
      return policy.get(orgID)
    },
  }

  const mode = {
    list(orgID: string) {
      return db
        .query<{ id: string; slug: string; name: string; config: string; created: number; updated: number }, [string]>(
          "select id, slug, name, config, created, updated from modes where org = ? order by slug",
        )
        .all(orgID)
        .map((row) => ({ id: row.id, created: row.created, updated: row.updated, ...Mode.parse(json(row.config, {})) }))
    },
    get(orgID: string, id: string) {
      return mode.list(orgID).find((row) => row.id === id || row.slug === id)
    },
    save(orgID: string, input: Mode, id?: string) {
      const row = id ?? crypto.id("mod")
      db.query(
        `insert into modes (id, org, slug, name, config, created, updated) values (?, ?, ?, ?, ?, ?, ?)
         on conflict (id) do update set slug = excluded.slug, name = excluded.name, config = excluded.config, updated = excluded.updated`,
      ).run(row, orgID, input.slug, input.name, JSON.stringify(input), now(), now())
      return mode.get(orgID, row)!
    },
    remove(orgID: string, id: string) {
      db.query("delete from modes where org = ? and id = ?").run(orgID, id)
    },
  }

  const audit = {
    record(input: {
      org: string
      action: string
      actor?: { id: string; email: string } | { id: null; email: string }
      target?: string | null
      details?: Record<string, unknown>
      ip?: string | null
    }) {
      db.query(
        "insert into audit (org, at, action, actor, email, target, details, ip) values (?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        input.org,
        now(),
        input.action,
        input.actor?.id ?? null,
        input.actor?.email ?? null,
        input.target ?? null,
        JSON.stringify(input.details ?? {}),
        input.ip ?? null,
      )
    },
    query(input: {
      org: string
      actions?: string[]
      actor?: string
      from?: number
      to?: number
      before?: number
      limit: number
    }) {
      const where = ["org = ?"]
      const args: (string | number)[] = [input.org]
      if (input.actions?.length) {
        where.push(`action in (${input.actions.map(() => "?").join(", ")})`)
        args.push(...input.actions)
      }
      if (input.actor) {
        where.push("email = ? collate nocase")
        args.push(input.actor)
      }
      if (input.from != null) {
        where.push("at >= ?")
        args.push(input.from)
      }
      if (input.to != null) {
        where.push("at <= ?")
        args.push(input.to)
      }
      if (input.before != null) {
        where.push("id < ?")
        args.push(input.before)
      }
      args.push(input.limit)
      return db
        .query<Audit, (string | number)[]>(`select * from audit where ${where.join(" and ")} order by id desc limit ?`)
        .all(...args)
    },
    prune(before: number) {
      return db.query("delete from audit where at < ?").run(before).changes
    },
  }

  const usage = {
    record(
      orgID: string,
      userID: string,
      rows: {
        id: string
        at: number
        session?: string
        project?: string
        provider: string
        model: string
        input: number
        output: number
        reasoning: number
        read: number
        write: number
        cost: number
      }[],
    ) {
      const stmt = db.query(
        `insert into usage (org, id, user, at, session, project, provider, model, input, output, reasoning, cache_read, cache_write, cost)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) on conflict do nothing`,
      )
      return db.transaction(() =>
        rows.reduce(
          (sum, row) =>
            sum +
            stmt.run(
              orgID,
              row.id,
              userID,
              row.at,
              row.session ?? null,
              row.project ?? null,
              row.provider,
              row.model,
              row.input,
              row.output,
              row.reasoning,
              row.read,
              row.write,
              row.cost,
            ).changes,
          0,
        ),
      )()
    },
    summary(input: {
      org: string
      by: "user" | "model" | "provider" | "day" | "project"
      from: number
      to: number
      user?: string
    }) {
      const key = {
        user: "u.email",
        model: "s.provider || '/' || s.model",
        provider: "s.provider",
        day: "strftime('%Y-%m-%d', s.at / 1000, 'unixepoch')",
        project: "coalesce(s.project, '')",
      }[input.by]
      const filter = input.user ? "and s.user = ?" : ""
      const args = input.user ? [input.org, input.from, input.to, input.user] : [input.org, input.from, input.to]
      return db
        .query<
          {
            key: string
            requests: number
            users: number
            input: number
            output: number
            reasoning: number
            cache_read: number
            cache_write: number
            cost: number
          },
          (string | number)[]
        >(
          `select ${key} as key, count(*) as requests, count(distinct s.user) as users,
             sum(s.input) as input, sum(s.output) as output, sum(s.reasoning) as reasoning,
             sum(s.cache_read) as cache_read, sum(s.cache_write) as cache_write, round(sum(s.cost), 6) as cost
           from usage s join users u on u.id = s.user
           where s.org = ? and s.at >= ? and s.at < ? ${filter}
           group by 1 order by cost desc, requests desc`,
        )
        .all(...args)
    },
    rows(input: { org: string; from: number; to: number; user?: string }) {
      const filter = input.user ? "and s.user = ?" : ""
      const args = input.user ? [input.org, input.from, input.to, input.user] : [input.org, input.from, input.to]
      return db
        .query<Record<string, string | number | null>, (string | number)[]>(
          `select s.id, s.at, u.email, s.session, s.project, s.provider, s.model, s.input, s.output, s.reasoning,
             s.cache_read, s.cache_write, s.cost
           from usage s join users u on u.id = s.user
           where s.org = ? and s.at >= ? and s.at < ? ${filter} order by s.at`,
        )
        .all(...args)
    },
    // Rounded to micro-dollars so float summation noise never reaches budgets or the UI.
    spent(input: { org: string; from: number; user?: string }) {
      const sum = input.user
        ? db
            .query<
              { n: number | null },
              [string, number, string]
            >("select sum(cost) as n from usage where org = ? and at >= ? and user = ?")
            .get(input.org, input.from, input.user)!.n
        : db
            .query<{ n: number | null }, [string, number]>("select sum(cost) as n from usage where org = ? and at >= ?")
            .get(input.org, input.from)!.n
      return Math.round((sum ?? 0) * 1e6) / 1e6
    },
  }

  const budget = {
    list(orgID: string) {
      return db
        .query<
          { scope: Budget["scope"]; target: string; period: Budget["period"]; amount: number },
          [string]
        >("select scope, target, period, amount from budgets where org = ? order by scope, target, period")
        .all(orgID)
    },
    replace(
      orgID: string,
      rows: { scope: Budget["scope"]; target: string; period: Budget["period"]; amount: number }[],
    ) {
      db.transaction(() => {
        db.query("delete from budgets where org = ?").run(orgID)
        for (const row of rows)
          db.query("insert into budgets (org, scope, target, period, amount) values (?, ?, ?, ?, ?)").run(
            orgID,
            row.scope,
            row.target,
            row.period,
            row.amount,
          )
      })()
    },
    // Budgets that bind this user, with spend for the current UTC day/month.
    status(orgID: string, userID: string): Budget[] {
      const date = new Date(now())
      const start = {
        day: Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
        month: Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1),
      }
      const rows = budget.list(orgID)
      const own = new Set(rows.filter((row) => row.scope === "user" && row.target === userID).map((row) => row.period))
      return rows
        .filter((row) => {
          if (row.scope === "org") return true
          if (row.scope === "user") return row.target === userID
          // A per-user override replaces the member default for the same period.
          return !own.has(row.period)
        })
        .map((row) => ({
          scope: row.scope,
          period: row.period,
          amount: row.amount,
          spent: usage.spent({ org: orgID, from: start[row.period], user: row.scope === "org" ? undefined : userID }),
        }))
    },
  }

  return {
    db,
    now,
    org,
    user,
    member,
    sso,
    device,
    login,
    invite,
    domain,
    token,
    group,
    policy,
    mode,
    audit,
    usage,
    budget,
    sweep,
  }
}
