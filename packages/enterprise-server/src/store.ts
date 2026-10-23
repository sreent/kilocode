export * as Store from "./store"

import { and, asc, count, desc, eq, getColumns, gt, gte, inArray, isNull, lt, lte, ne, or, sql } from "drizzle-orm"
import { Clock, Context, Effect, Layer, Schema } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { isSqlError } from "effect/unstable/sql/SqlError"
import { inherited } from "@enterprise/protocol/roles"
import {
  Mode,
  ModelAccess,
  Policy,
  type BudgetStatus,
  type GatewayKind,
  type Role,
  type UsageBy,
} from "@enterprise/protocol/schema"
import * as Crypto from "./crypto"
import { Database } from "./db/database"
import {
  AuditTable,
  BudgetTable,
  DeviceTable,
  DomainTable,
  GatewayProviderTable,
  GroupMemberTable,
  GroupTable,
  InviteTable,
  LoginTable,
  MemberTable,
  ModeTable,
  OrgTable,
  PolicyTable,
  SsoTable,
  TokenTable,
  UsageTable,
  UserTable,
} from "./db/schema.sql"

export type Org = typeof OrgTable.$inferSelect
export type User = typeof UserTable.$inferSelect
export type Token = typeof TokenTable.$inferSelect
export type Group = typeof GroupTable.$inferSelect
export type Audit = typeof AuditTable.$inferSelect
export type Sso = typeof SsoTable.$inferSelect
export type GatewayProvider = typeof GatewayProviderTable.$inferSelect

// Who an audit event is attributed to; SCIM provisioning has no user, only a token name.
export type Actor = { readonly id: string | null; readonly email: string }

type Budget = { scope: BudgetStatus["scope"]; target: string; period: BudgetStatus["period"]; amount: number }

const day = 24 * 60 * 60 * 1000
const now = Clock.currentTimeMillis
// Emails and domain names are stored lowercase and always looked up lowercase.
const lower = (value: string) => value.trim().toLowerCase()
const decodePolicy = Schema.decodeUnknownSync(Policy)
const decodeMode = Schema.decodeUnknownSync(Mode)
const decodeAccess = Schema.decodeUnknownSync(Schema.NullOr(ModelAccess))

// Token rows without the secret hash, which never leaves the store.
const { hash: _, ...tokenColumns } = getColumns(TokenTable)

const make = Effect.gen(function* () {
  const { db } = yield* Database.Service

  const findOrg = Effect.fn("Store.org.get")(function* (ref: string) {
    return yield* db
      .select()
      .from(OrgTable)
      .where(or(eq(OrgTable.id, ref), eq(OrgTable.slug, ref)))
      .get()
  }, Effect.orDie)

  const org = {
    get: findOrg,
    create: Effect.fn("Store.org.create")(function* (input: { name: string; slug: string; parent?: string }) {
      return yield* db
        .insert(OrgTable)
        .values({
          id: Crypto.id("org"),
          name: input.name,
          slug: input.slug,
          parent: input.parent ?? null,
          created: yield* now,
        })
        .returning()
        .get()
    }, Effect.orDie),
    update: Effect.fn("Store.org.update")(function* (
      id: string,
      input: { name?: string; settings?: Record<string, unknown> },
    ) {
      const patch = {
        ...(input.name != null && { name: input.name }),
        ...(input.settings != null && { settings: input.settings }),
      }
      if (Object.keys(patch).length > 0) yield* db.update(OrgTable).set(patch).where(eq(OrgTable.id, id))
      return (yield* findOrg(id))!
    }, Effect.orDie),
    children: Effect.fn("Store.org.children")(function* (id: string) {
      return yield* db.select().from(OrgTable).where(eq(OrgTable.parent, id)).orderBy(asc(OrgTable.name))
    }, Effect.orDie),
  }

  const getUser = Effect.fn("Store.user.get")(function* (id: string) {
    return yield* db.select().from(UserTable).where(eq(UserTable.id, id)).get()
  }, Effect.orDie)
  const findUser = Effect.fn("Store.user.find")(function* (email: string) {
    return yield* db
      .select()
      .from(UserTable)
      .where(eq(UserTable.email, lower(email)))
      .get()
  }, Effect.orDie)

  const user = {
    get: getUser,
    find: findUser,
    ensure: Effect.fn("Store.user.ensure")(function* (input: {
      email: string
      name?: string | null
      external?: string | null
    }) {
      const existing = yield* findUser(input.email)
      if (existing) return existing
      return yield* db
        .insert(UserTable)
        .values({
          id: Crypto.id("usr"),
          email: lower(input.email),
          name: input.name ?? null,
          external: input.external ?? null,
          created: yield* now,
        })
        .returning()
        .get()
    }, Effect.orDie),
    update: Effect.fn("Store.user.update")(function* (
      id: string,
      input: { email?: string; name?: string | null; external?: string | null; active?: boolean },
    ) {
      const patch = {
        ...(input.email != null && { email: lower(input.email) }),
        ...(input.name !== undefined && { name: input.name }),
        ...(input.external !== undefined && { external: input.external }),
        ...(input.active != null && { active: input.active }),
      }
      yield* db.transaction(() =>
        Effect.gen(function* () {
          if (Object.keys(patch).length > 0) yield* db.update(UserTable).set(patch).where(eq(UserTable.id, id))
          // Deactivation must cut off every live credential immediately.
          if (input.active === false)
            yield* db
              .update(TokenTable)
              .set({ revoked: yield* now })
              .where(and(eq(TokenTable.user, id), isNull(TokenTable.revoked)))
        }),
      )
      return (yield* getUser(id))!
    }, Effect.orDie),
  }

  const member = {
    // Direct membership wins; otherwise a parent-org manager inherits their role in a sub-org.
    // Suspended memberships (SCIM active=false) grant nothing.
    role: Effect.fn("Store.member.role")(function* (orgID: string, userID: string) {
      const direct = yield* db
        .select({ role: MemberTable.role })
        .from(MemberTable)
        .where(and(eq(MemberTable.org, orgID), eq(MemberTable.user, userID), isNull(MemberTable.suspended)))
        .get()
      if (direct) return { role: direct.role, inherited: false }
      const parent = yield* db
        .select({ role: MemberTable.role })
        .from(OrgTable)
        .innerJoin(MemberTable, eq(MemberTable.org, OrgTable.parent))
        .where(and(eq(OrgTable.id, orgID), eq(MemberTable.user, userID), isNull(MemberTable.suspended)))
        .get()
      if (parent && inherited.includes(parent.role)) return { role: parent.role, inherited: true }
      return undefined
    }, Effect.orDie),
    // Raw membership row, including suspended ones; used by SCIM, which must see deactivated users.
    get: Effect.fn("Store.member.get")(function* (orgID: string, userID: string) {
      return yield* db
        .select({ role: MemberTable.role, suspended: MemberTable.suspended })
        .from(MemberTable)
        .where(and(eq(MemberTable.org, orgID), eq(MemberTable.user, userID)))
        .get()
    }, Effect.orDie),
    suspend: Effect.fn("Store.member.suspend")(function* (orgID: string, userID: string, value: boolean) {
      yield* db
        .update(MemberTable)
        .set({ suspended: value ? yield* now : null })
        .where(and(eq(MemberTable.org, orgID), eq(MemberTable.user, userID)))
    }, Effect.orDie),
    list: Effect.fn("Store.member.list")(function* (orgID: string) {
      return yield* db
        .select({
          ...getColumns(UserTable),
          role: MemberTable.role,
          joined: MemberTable.created,
          suspended: MemberTable.suspended,
        })
        .from(MemberTable)
        .innerJoin(UserTable, eq(UserTable.id, MemberTable.user))
        .where(eq(MemberTable.org, orgID))
        .orderBy(asc(UserTable.email))
    }, Effect.orDie),
    // Memberships of any state; a user with none left is fully deprovisioned.
    count: Effect.fn("Store.member.count")(function* (userID: string) {
      return yield* db.$count(MemberTable, eq(MemberTable.user, userID))
    }, Effect.orDie),
    // Memberships outside this org and its sub-orgs. SCIM may only rewrite a user's identity
    // (email, name) when no other org depends on it.
    foreign: Effect.fn("Store.member.foreign")(function* (userID: string, orgID: string) {
      const row = yield* db
        .select({ n: count() })
        .from(MemberTable)
        .innerJoin(OrgTable, eq(OrgTable.id, MemberTable.org))
        .where(
          and(eq(MemberTable.user, userID), ne(OrgTable.id, orgID), sql`coalesce(${OrgTable.parent}, '') <> ${orgID}`),
        )
        .get()
      return row?.n ?? 0
    }, Effect.orDie),
    add: Effect.fn("Store.member.add")(function* (orgID: string, userID: string, role: Role) {
      yield* db
        .insert(MemberTable)
        .values({ org: orgID, user: userID, role, created: yield* now })
        .onConflictDoNothing()
    }, Effect.orDie),
    set: Effect.fn("Store.member.set")(function* (orgID: string, userID: string, role: Role) {
      yield* db
        .update(MemberTable)
        .set({ role })
        .where(and(eq(MemberTable.org, orgID), eq(MemberTable.user, userID)))
    }, Effect.orDie),
    remove: Effect.fn("Store.member.remove")(function* (orgID: string, userID: string) {
      yield* db.transaction(() =>
        Effect.gen(function* () {
          yield* db.delete(MemberTable).where(and(eq(MemberTable.org, orgID), eq(MemberTable.user, userID)))
          yield* db
            .delete(GroupMemberTable)
            .where(
              and(
                eq(GroupMemberTable.user, userID),
                inArray(
                  GroupMemberTable.grp,
                  db.select({ id: GroupTable.id }).from(GroupTable).where(eq(GroupTable.org, orgID)),
                ),
              ),
            )
        }),
      )
    }, Effect.orDie),
    owners: Effect.fn("Store.member.owners")(function* (orgID: string) {
      return yield* db.$count(
        MemberTable,
        and(eq(MemberTable.org, orgID), eq(MemberTable.role, "owner"), isNull(MemberTable.suspended)),
      )
    }, Effect.orDie),
  }

  const sso = {
    get: Effect.fn("Store.sso.get")(function* (orgID: string) {
      return yield* db.select().from(SsoTable).where(eq(SsoTable.org, orgID)).get()
    }, Effect.orDie),
    set: Effect.fn("Store.sso.set")(function* (
      orgID: string,
      input: { issuer: string; client: string; secret: string; scopes: string; enforce: boolean; provision: boolean },
    ) {
      const row = { ...input, updated: yield* now }
      yield* db
        .insert(SsoTable)
        .values({ org: orgID, ...row })
        .onConflictDoUpdate({ target: SsoTable.org, set: row })
    }, Effect.orDie),
    remove: Effect.fn("Store.sso.remove")(function* (orgID: string) {
      yield* db.delete(SsoTable).where(eq(SsoTable.org, orgID))
    }, Effect.orDie),
  }

  const device = {
    create: Effect.fn("Store.device.create")(function* (orgID: string, ttl: number) {
      const value = Crypto.secret()
      const code = Crypto.code()
      const created = yield* now
      yield* db
        .insert(DeviceTable)
        .values({ hash: Crypto.hash(value), code, org: orgID, status: "pending", created, expires: created + ttl })
      return { value, code }
    }, Effect.orDie),
    find: Effect.fn("Store.device.find")(function* (value: string) {
      return yield* db
        .select()
        .from(DeviceTable)
        .where(eq(DeviceTable.hash, Crypto.hash(value)))
        .get()
    }, Effect.orDie),
    code: Effect.fn("Store.device.code")(function* (code: string) {
      return yield* db.select().from(DeviceTable).where(eq(DeviceTable.code, code.trim().toUpperCase())).get()
    }, Effect.orDie),
    poll: Effect.fn("Store.device.poll")(function* (hash: string) {
      yield* db
        .update(DeviceTable)
        .set({ polled: yield* now })
        .where(eq(DeviceTable.hash, hash))
    }, Effect.orDie),
    // Only a pending, unexpired code can change state, so a code can never be approved twice.
    decide: Effect.fn("Store.device.decide")(function* (code: string, status: "approved" | "denied", userID?: string) {
      const row = yield* db
        .update(DeviceTable)
        .set({ status, user: userID ?? null })
        .where(and(eq(DeviceTable.code, code), eq(DeviceTable.status, "pending"), gt(DeviceTable.expires, yield* now)))
        .returning({ hash: DeviceTable.hash })
        .get()
      return row !== undefined
    }, Effect.orDie),
    consume: Effect.fn("Store.device.consume")(function* (hash: string) {
      const row = yield* db
        .update(DeviceTable)
        .set({ status: "consumed" })
        .where(and(eq(DeviceTable.hash, hash), eq(DeviceTable.status, "approved")))
        .returning({ hash: DeviceTable.hash })
        .get()
      return row !== undefined
    }, Effect.orDie),
  }

  const login = {
    create: Effect.fn("Store.login.create")(function* (input: {
      org: string
      verifier: string
      nonce: string
      device?: string
    }) {
      const state = Crypto.secret()
      yield* db.insert(LoginTable).values({
        state,
        org: input.org,
        verifier: input.verifier,
        nonce: input.nonce,
        device: input.device ?? null,
        created: yield* now,
      })
      return state
    }, Effect.orDie),
    // Single use: the row is deleted as it is read.
    take: Effect.fn("Store.login.take")(function* (state: string) {
      return yield* db.delete(LoginTable).where(eq(LoginTable.state, state)).returning().get()
    }, Effect.orDie),
  }

  const live = Effect.fn(function* () {
    return and(isNull(InviteTable.accepted), isNull(InviteTable.revoked), gt(InviteTable.expires, yield* now))
  })

  const invite = {
    create: Effect.fn("Store.invite.create")(function* (input: {
      org: string
      email: string
      role: Role
      actor: string
      ttl: number
    }) {
      const value = Crypto.secret()
      const id = Crypto.id("inv")
      const created = yield* now
      yield* db.insert(InviteTable).values({
        id,
        org: input.org,
        email: lower(input.email),
        role: input.role,
        hash: Crypto.hash(value),
        actor: input.actor,
        created,
        expires: created + input.ttl,
      })
      return { id, value }
    }, Effect.orDie),
    find: Effect.fn("Store.invite.find")(function* (value: string) {
      return yield* db
        .select()
        .from(InviteTable)
        .where(and(eq(InviteTable.hash, Crypto.hash(value)), yield* live()))
        .get()
    }, Effect.orDie),
    pending: Effect.fn("Store.invite.pending")(function* (orgID: string, email?: string) {
      return yield* db
        .select()
        .from(InviteTable)
        .where(and(eq(InviteTable.org, orgID), email ? eq(InviteTable.email, lower(email)) : undefined, yield* live()))
        .orderBy(desc(InviteTable.created))
    }, Effect.orDie),
    // Only a live invite can be accepted, so concurrent accepts of one invite admit one person.
    accept: Effect.fn("Store.invite.accept")(function* (id: string) {
      const row = yield* db
        .update(InviteTable)
        .set({ accepted: yield* now })
        .where(and(eq(InviteTable.id, id), yield* live()))
        .returning({ id: InviteTable.id })
        .get()
      return row !== undefined
    }, Effect.orDie),
    revoke: Effect.fn("Store.invite.revoke")(function* (orgID: string, id: string) {
      const row = yield* db
        .update(InviteTable)
        .set({ revoked: yield* now })
        .where(
          and(
            eq(InviteTable.org, orgID),
            eq(InviteTable.id, id),
            isNull(InviteTable.accepted),
            isNull(InviteTable.revoked),
          ),
        )
        .returning({ id: InviteTable.id })
        .get()
      return row !== undefined
    }, Effect.orDie),
  }

  const domain = {
    list: Effect.fn("Store.domain.list")(function* (orgID: string) {
      return yield* db.select().from(DomainTable).where(eq(DomainTable.org, orgID)).orderBy(asc(DomainTable.name))
    }, Effect.orDie),
    get: Effect.fn("Store.domain.get")(function* (name: string) {
      return yield* db
        .select()
        .from(DomainTable)
        .where(eq(DomainTable.name, lower(name)))
        .get()
    }, Effect.orDie),
    create: Effect.fn("Store.domain.create")(function* (orgID: string, name: string) {
      return yield* db
        .insert(DomainTable)
        .values({
          name: lower(name),
          org: orgID,
          token: `enterprise-verify=${Crypto.secret(18)}`,
          created: yield* now,
        })
        .returning()
        .get()
    }, Effect.orDie),
    verify: Effect.fn("Store.domain.verify")(function* (name: string) {
      yield* db
        .update(DomainTable)
        .set({ verified: yield* now })
        .where(eq(DomainTable.name, lower(name)))
    }, Effect.orDie),
    remove: Effect.fn("Store.domain.remove")(function* (orgID: string, name: string) {
      const row = yield* db
        .delete(DomainTable)
        .where(and(eq(DomainTable.org, orgID), eq(DomainTable.name, lower(name))))
        .returning({ name: DomainTable.name })
        .get()
      return row !== undefined
    }, Effect.orDie),
    // The org that owns the verified domain of this email address, if any.
    owner: Effect.fn("Store.domain.owner")(function* (email: string) {
      const host = email.split("@").at(-1)?.toLowerCase()
      if (!host) return undefined
      const row = yield* db
        .select({ org: DomainTable.org })
        .from(DomainTable)
        .where(and(eq(DomainTable.name, host), sql`${DomainTable.verified} is not null`))
        .get()
      return row?.org
    }, Effect.orDie),
  }

  const token = {
    // Every token is bound to one org. An org's IdP is configured by that org's own admins, so an
    // identity asserted through it must never carry into another org that happens to share the user.
    issue: Effect.fn("Store.token.issue")(function* (input: {
      kind: "user" | "scim"
      user?: string
      org: string
      name: string
      ttl?: number
    }) {
      const value = Crypto.token(input.kind)
      const id = Crypto.id("tok")
      const created = yield* now
      yield* db.insert(TokenTable).values({
        id,
        hash: Crypto.hash(value),
        kind: input.kind,
        user: input.user ?? null,
        org: input.org,
        name: input.name,
        created,
        expires: input.ttl ? created + input.ttl : null,
      })
      return { id, value }
    }, Effect.orDie),
    verify: Effect.fn("Store.token.verify")(function* (value: string) {
      const row = yield* db
        .select(tokenColumns)
        .from(TokenTable)
        .where(eq(TokenTable.hash, Crypto.hash(value)))
        .get()
      const time = yield* now
      if (!row || row.revoked) return undefined
      if (row.expires && row.expires < time) return undefined
      // Throttle last-used writes so every authenticated request doesn't hit the disk.
      if (row.used == null || time - row.used > 60_000)
        yield* db.update(TokenTable).set({ used: time }).where(eq(TokenTable.id, row.id))
      return row
    }, Effect.orDie),
    list: Effect.fn("Store.token.list")(function* (input: { org: string; user?: string; kind: "user" | "scim" }) {
      return yield* db
        .select(tokenColumns)
        .from(TokenTable)
        .where(
          and(
            eq(TokenTable.org, input.org),
            input.user ? eq(TokenTable.user, input.user) : undefined,
            eq(TokenTable.kind, input.kind),
          ),
        )
        .orderBy(desc(TokenTable.created))
    }, Effect.orDie),
    // A token reaches its own org, plus that org's sub-orgs (inherited management).
    reaches: Effect.fn("Store.token.reaches")(function* (row: { org: string }, orgID: string) {
      if (row.org === orgID) return true
      return (yield* findOrg(orgID))?.parent === row.org
    }),
    revoke: Effect.fn("Store.token.revoke")(function* (id: string) {
      yield* db
        .update(TokenTable)
        .set({ revoked: yield* now })
        .where(and(eq(TokenTable.id, id), isNull(TokenTable.revoked)))
    }, Effect.orDie),
    get: Effect.fn("Store.token.get")(function* (id: string) {
      return yield* db.select(tokenColumns).from(TokenTable).where(eq(TokenTable.id, id)).get()
    }, Effect.orDie),
  }

  // Only direct org members (suspended ones included, so SCIM can keep group state for
  // deactivated users) may be placed in a group; anything else is refused.
  const joinGroup = Effect.fn("Store.group.join")(function* (orgID: string, id: string, userID: string) {
    if (!(yield* member.get(orgID, userID))) return false
    yield* db.insert(GroupMemberTable).values({ grp: id, user: userID }).onConflictDoNothing()
    return true
  }, Effect.orDie)

  const group = {
    list: Effect.fn("Store.group.list")(function* (orgID: string) {
      return yield* db.select().from(GroupTable).where(eq(GroupTable.org, orgID)).orderBy(asc(GroupTable.name))
    }, Effect.orDie),
    get: Effect.fn("Store.group.get")(function* (orgID: string, id: string) {
      return yield* db
        .select()
        .from(GroupTable)
        .where(and(eq(GroupTable.org, orgID), eq(GroupTable.id, id)))
        .get()
    }, Effect.orDie),
    create: Effect.fn("Store.group.create")(function* (
      orgID: string,
      input: { name: string; external?: string | null; models?: ModelAccess | null },
    ) {
      return yield* db
        .insert(GroupTable)
        .values({
          id: Crypto.id("grp"),
          org: orgID,
          name: input.name,
          external: input.external ?? null,
          models: input.models ?? null,
          created: yield* now,
        })
        .returning()
        .get()
    }, Effect.orDie),
    update: Effect.fn("Store.group.update")(function* (
      orgID: string,
      id: string,
      input: { name?: string; external?: string | null; models?: ModelAccess | null },
    ) {
      const patch = {
        ...(input.name != null && { name: input.name }),
        ...(input.external !== undefined && { external: input.external }),
        ...(input.models !== undefined && { models: input.models }),
      }
      if (Object.keys(patch).length > 0)
        yield* db
          .update(GroupTable)
          .set(patch)
          .where(and(eq(GroupTable.org, orgID), eq(GroupTable.id, id)))
    }, Effect.orDie),
    remove: Effect.fn("Store.group.remove")(function* (orgID: string, id: string) {
      yield* db.delete(GroupTable).where(and(eq(GroupTable.org, orgID), eq(GroupTable.id, id)))
    }, Effect.orDie),
    members: Effect.fn("Store.group.members")(function* (id: string) {
      return yield* db
        .select(getColumns(UserTable))
        .from(GroupMemberTable)
        .innerJoin(UserTable, eq(UserTable.id, GroupMemberTable.user))
        .where(eq(GroupMemberTable.grp, id))
        .orderBy(asc(UserTable.email))
    }, Effect.orDie),
    join: joinGroup,
    leave: Effect.fn("Store.group.leave")(function* (id: string, userID: string) {
      yield* db.delete(GroupMemberTable).where(and(eq(GroupMemberTable.grp, id), eq(GroupMemberTable.user, userID)))
    }, Effect.orDie),
    // Replaces membership; users who cannot join are skipped.
    assign: Effect.fn("Store.group.assign")(function* (orgID: string, id: string, users: ReadonlyArray<string>) {
      yield* db.transaction(() =>
        Effect.gen(function* () {
          yield* db.delete(GroupMemberTable).where(eq(GroupMemberTable.grp, id))
          for (const userID of users) yield* joinGroup(orgID, id, userID)
        }),
      )
    }, Effect.orDie),
    of: Effect.fn("Store.group.of")(function* (orgID: string, userID: string) {
      return yield* db
        .select(getColumns(GroupTable))
        .from(GroupTable)
        .innerJoin(GroupMemberTable, eq(GroupMemberTable.grp, GroupTable.id))
        .where(and(eq(GroupTable.org, orgID), eq(GroupMemberTable.user, userID)))
        .orderBy(asc(GroupTable.name))
    }, Effect.orDie),
    access: (row: Group) => decodeAccess(row.models ?? null),
  }

  const getPolicy = Effect.fn("Store.policy.get")(function* (orgID: string) {
    const row = yield* db.select().from(PolicyTable).where(eq(PolicyTable.org, orgID)).get()
    return { policy: decodePolicy(row?.data ?? {}), version: row?.version ?? 0, updated: row?.updated ?? null }
  }, Effect.orDie)

  const policy = {
    get: getPolicy,
    set: Effect.fn("Store.policy.set")(function* (orgID: string, data: Policy, actor: string) {
      const updated = yield* now
      yield* db
        .insert(PolicyTable)
        .values({ org: orgID, data, version: 1, updated, actor })
        .onConflictDoUpdate({
          target: PolicyTable.org,
          set: { data, version: sql`${PolicyTable.version} + 1`, updated, actor },
        })
      return yield* getPolicy(orgID)
    }, Effect.orDie),
  }

  const listModes = Effect.fn("Store.mode.list")(function* (orgID: string) {
    const rows = yield* db.select().from(ModeTable).where(eq(ModeTable.org, orgID)).orderBy(asc(ModeTable.slug))
    return rows.map((row) => ({ id: row.id, created: row.created, updated: row.updated, ...decodeMode(row.config) }))
  }, Effect.orDie)
  const getMode = Effect.fn("Store.mode.get")(function* (orgID: string, ref: string) {
    return (yield* listModes(orgID)).find((row) => row.id === ref || row.slug === ref)
  })

  const mode = {
    list: listModes,
    get: getMode,
    save: Effect.fn("Store.mode.save")(function* (orgID: string, input: Mode, id?: string) {
      const row = id ?? Crypto.id("mod")
      const time = yield* now
      yield* db
        .insert(ModeTable)
        .values({
          id: row,
          org: orgID,
          slug: input.slug,
          name: input.name,
          config: input,
          created: time,
          updated: time,
        })
        .onConflictDoUpdate({
          target: ModeTable.id,
          set: { slug: input.slug, name: input.name, config: input, updated: time },
        })
      return (yield* getMode(orgID, row))!
    }, Effect.orDie),
    remove: Effect.fn("Store.mode.remove")(function* (orgID: string, id: string) {
      yield* db.delete(ModeTable).where(and(eq(ModeTable.org, orgID), eq(ModeTable.id, id)))
    }, Effect.orDie),
  }

  const audit = {
    record: Effect.fn("Store.audit.record")(function* (input: {
      org: string
      action: string
      actor?: Actor
      target?: string | null
      details?: Record<string, unknown>
      ip?: string | null
    }) {
      yield* db.insert(AuditTable).values({
        org: input.org,
        at: yield* now,
        action: input.action,
        actor: input.actor?.id ?? null,
        email: input.actor?.email ?? null,
        target: input.target ?? null,
        details: input.details ?? {},
        ip: input.ip ?? null,
      })
    }, Effect.orDie),
    query: Effect.fn("Store.audit.query")(function* (input: {
      org: string
      actions?: ReadonlyArray<string>
      actor?: string
      from?: number
      to?: number
      before?: number
      limit: number
    }) {
      return yield* db
        .select()
        .from(AuditTable)
        .where(
          and(
            eq(AuditTable.org, input.org),
            input.actions?.length ? inArray(AuditTable.action, [...input.actions]) : undefined,
            input.actor ? sql`${AuditTable.email} = ${input.actor} collate nocase` : undefined,
            input.from != null ? gte(AuditTable.at, input.from) : undefined,
            input.to != null ? lte(AuditTable.at, input.to) : undefined,
            input.before != null ? lt(AuditTable.id, input.before) : undefined,
          ),
        )
        .orderBy(desc(AuditTable.id))
        .limit(input.limit)
    }, Effect.orDie),
    prune: Effect.fn("Store.audit.prune")(function* (before: number) {
      return yield* db.transaction(() =>
        Effect.gen(function* () {
          const n = yield* db.$count(AuditTable, lt(AuditTable.at, before))
          if (n > 0) yield* db.delete(AuditTable).where(lt(AuditTable.at, before))
          return n
        }),
      )
    }, Effect.orDie),
  }

  // Housekeeping for short-lived rows: device codes, abandoned SSO logins, and audit history past
  // retention. Without a retention the audit log is kept forever.
  const sweep = Effect.fn("Store.sweep")(function* (retention: number | undefined) {
    const time = yield* now
    yield* db.delete(DeviceTable).where(lt(DeviceTable.expires, time - day))
    yield* db.delete(LoginTable).where(lt(LoginTable.created, time - day))
    if (retention == null) return 0
    return yield* audit.prune(time - retention)
  }, Effect.orDie)

  // Usage queries join users for emails and stay in SQL, where the aggregation belongs.
  const window = (input: { org: string; from: number; to: number; user?: string }) =>
    sql`s.org = ${input.org} and s.at >= ${input.from} and s.at < ${input.to} ${input.user ? sql`and s.user = ${input.user}` : sql``}`

  const usage = {
    record: Effect.fn("Store.usage.record")(function* (
      orgID: string,
      userID: string,
      rows: ReadonlyArray<{
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
        source?: "client" | "gateway"
      }>,
    ) {
      return yield* db.transaction(() =>
        Effect.gen(function* () {
          let accepted = 0
          for (const row of rows) {
            const inserted = yield* db
              .insert(UsageTable)
              .values({
                org: orgID,
                id: row.id,
                user: userID,
                at: row.at,
                session: row.session ?? null,
                project: row.project ?? null,
                provider: row.provider,
                model: row.model,
                input: row.input,
                output: row.output,
                reasoning: row.reasoning,
                cache_read: row.read,
                cache_write: row.write,
                cost: row.cost,
                source: row.source ?? "client",
              })
              // Client-provided ids make resends idempotent.
              .onConflictDoNothing()
              .returning({ id: UsageTable.id })
              .get()
            if (inserted) accepted++
          }
          return accepted
        }),
      )
    }, Effect.orDie),
    summary: Effect.fn("Store.usage.summary")(function* (input: {
      org: string
      by: UsageBy
      from: number
      to: number
      user?: string
    }) {
      const key = {
        user: sql`u.email`,
        model: sql`s.provider || '/' || s.model`,
        provider: sql`s.provider`,
        day: sql`strftime('%Y-%m-%d', s.at / 1000, 'unixepoch')`,
        project: sql`coalesce(s.project, '')`,
        source: sql`s.source`,
      }[input.by]
      return yield* db.all<{
        key: string
        requests: number
        users: number
        input: number
        output: number
        reasoning: number
        cache_read: number
        cache_write: number
        cost: number
      }>(sql`
        select ${key} as key, count(*) as requests, count(distinct s.user) as users,
          sum(s.input) as input, sum(s.output) as output, sum(s.reasoning) as reasoning,
          sum(s.cache_read) as cache_read, sum(s.cache_write) as cache_write, round(sum(s.cost), 6) as cost
        from usage s join users u on u.id = s.user
        where ${window(input)}
        group by 1 order by cost desc, requests desc`)
    }, Effect.orDie),
    rows: Effect.fn("Store.usage.rows")(function* (input: { org: string; from: number; to: number; user?: string }) {
      return yield* db.all<Record<string, string | number | null>>(sql`
        select s.id, s.at, u.email, s.session, s.project, s.provider, s.model, s.input, s.output, s.reasoning,
          s.cache_read, s.cache_write, s.cost, s.source
        from usage s join users u on u.id = s.user
        where ${window(input)} order by s.at`)
    }, Effect.orDie),
    // Rounded to micro-dollars so float summation noise never reaches budgets or the UI.
    spent: Effect.fn("Store.usage.spent")(function* (input: { org: string; from: number; user?: string }) {
      const row = yield* db
        .select({ n: sql<number | null>`sum(${UsageTable.cost})` })
        .from(UsageTable)
        .where(
          and(
            eq(UsageTable.org, input.org),
            gte(UsageTable.at, input.from),
            input.user ? eq(UsageTable.user, input.user) : undefined,
          ),
        )
        .get()
      return Math.round((row?.n ?? 0) * 1e6) / 1e6
    }, Effect.orDie),
  }

  const where = (orgID: string, id: string) => and(eq(GatewayProviderTable.org, orgID), eq(GatewayProviderTable.id, id))

  const gateway = {
    list: Effect.fn("Store.gateway.list")(function* (orgID: string) {
      return yield* db
        .select()
        .from(GatewayProviderTable)
        .where(eq(GatewayProviderTable.org, orgID))
        .orderBy(asc(GatewayProviderTable.id))
    }, Effect.orDie),
    get: Effect.fn("Store.gateway.get")(function* (orgID: string, id: string) {
      return yield* db.select().from(GatewayProviderTable).where(where(orgID, id)).get()
    }, Effect.orDie),
    // `secret` is already sealed.
    set: Effect.fn("Store.gateway.set")(function* (
      orgID: string,
      id: string,
      input: { kind: GatewayKind; base: string; secret: string; hint: string },
    ) {
      const time = yield* now
      return yield* db
        .insert(GatewayProviderTable)
        .values({ org: orgID, id, ...input, created: time, updated: time })
        .onConflictDoUpdate({
          target: [GatewayProviderTable.org, GatewayProviderTable.id],
          set: { ...input, updated: time },
        })
        .returning()
        .get()
    }, Effect.orDie),
    remove: Effect.fn("Store.gateway.remove")(function* (orgID: string, id: string) {
      const row = yield* db
        .delete(GatewayProviderTable)
        .where(where(orgID, id))
        .returning({ id: GatewayProviderTable.id })
        .get()
      return row !== undefined
    }, Effect.orDie),
  }

  const listBudgets = Effect.fn("Store.budget.list")(function* (orgID: string) {
    return yield* db
      .select({
        scope: BudgetTable.scope,
        target: BudgetTable.target,
        period: BudgetTable.period,
        amount: BudgetTable.amount,
      })
      .from(BudgetTable)
      .where(eq(BudgetTable.org, orgID))
      .orderBy(asc(BudgetTable.scope), asc(BudgetTable.target), asc(BudgetTable.period))
  }, Effect.orDie)

  const budget = {
    list: listBudgets,
    replace: Effect.fn("Store.budget.replace")(function* (orgID: string, rows: ReadonlyArray<Budget>) {
      yield* db.transaction(() =>
        Effect.gen(function* () {
          yield* db.delete(BudgetTable).where(eq(BudgetTable.org, orgID))
          if (rows.length > 0) yield* db.insert(BudgetTable).values(rows.map((row) => ({ org: orgID, ...row })))
        }),
      )
    }, Effect.orDie),
    // Budgets that bind this user, with spend for the current UTC day/month.
    status: Effect.fn("Store.budget.status")(function* (orgID: string, userID: string) {
      const date = new Date(yield* now)
      const start = {
        day: Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
        month: Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1),
      }
      const rows = yield* listBudgets(orgID)
      const own = new Set(rows.filter((row) => row.scope === "user" && row.target === userID).map((row) => row.period))
      const binding = rows.filter((row) => {
        if (row.scope === "org") return true
        if (row.scope === "user") return row.target === userID
        // A per-user override replaces the member default for the same period.
        return !own.has(row.period)
      })
      return yield* Effect.forEach(
        binding,
        (row): Effect.Effect<BudgetStatus> =>
          usage
            .spent({ org: orgID, from: start[row.period], user: row.scope === "org" ? undefined : userID })
            .pipe(Effect.map((spent) => ({ scope: row.scope, period: row.period, amount: row.amount, spent }))),
      )
    }),
  }

  return {
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
    gateway,
    budget,
    sweep,
    // Runs an effect atomically; store calls inside it share the transaction. SQL failures are defects.
    transaction: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      db.transaction(() => effect, { behavior: "immediate" }).pipe(Effect.catchIf(isSqlError, Effect.die)),
  }
})

export interface Interface extends Effect.Success<typeof make> {}

export class Service extends Context.Service<Service, Interface>()("@enterprise/Store") {}

export const layer = Layer.effect(Service, make)

export const node = LayerNode.make({ service: Service, layer, deps: [Database.node] })
