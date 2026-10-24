export * as Store from "./store"

import { and, asc, count, desc, eq, getColumns, gt, gte, inArray, isNull, lt, lte, ne, or, sql } from "drizzle-orm"
import { Clock, Context, Effect, Layer, Schema } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EffectDrizzleError, EffectDrizzleQueryError } from "drizzle-orm/effect-core"
import { isSqlError, type SqlError } from "effect/unstable/sql/SqlError"
import { inherited } from "@organization/protocol/roles"
import {
  Mode,
  ModelAccess,
  Policy,
  type Budget,
  type BudgetSpend,
  type BudgetStatus,
  type GatewayAuth,
  type GatewayKind,
  type GatewayModel,
  type Price,
  type Role,
  type StreamTarget,
  type UsageBy,
} from "@organization/protocol/schema"
import * as Crypto from "./crypto"
import { Database } from "./db/database"
import {
  AssertionTable,
  AuditTable,
  BudgetTable,
  DeviceTable,
  DomainTable,
  GatewayCallTable,
  GatewayProviderTable,
  GatewayWindowTable,
  GroupMemberTable,
  GroupTable,
  InviteTable,
  LoginTable,
  MemberTable,
  ModeTable,
  OrgTable,
  PolicyTable,
  PriceTable,
  SsoTable,
  StreamTable,
  TokenTable,
  UsageTable,
  UserTable,
} from "./db/schema.sql"

export type Org = typeof OrgTable.$inferSelect
export type User = typeof UserTable.$inferSelect
export type Token = typeof TokenTable.$inferSelect
export type Group = typeof GroupTable.$inferSelect
export type Audit = typeof AuditTable.$inferSelect
// An org's single sign-on connection; the protocol decides which settings it carries.
type Connection = { readonly enforce: boolean; readonly provision: boolean }
export type OidcConnection = Connection & {
  readonly protocol: "oidc"
  readonly issuer: string
  readonly client: string
  // Sealed with ORGANIZATION_SECRET.
  readonly secret: string
  readonly scopes: string
}
export type SamlConnection = Connection & {
  readonly protocol: "saml"
  // The identity provider's entity ID, sign-in URL and signing certificates (PEM).
  readonly issuer: string
  readonly entry: string
  readonly certificates: ReadonlyArray<string>
  readonly unsolicited: boolean
}
export type Sso = (OidcConnection | SamlConnection) & { readonly org: string; readonly updated: number }
export type GatewayProvider = typeof GatewayProviderTable.$inferSelect
export type GatewayCall = typeof GatewayCallTable.$inferSelect
export type PriceRule = typeof PriceTable.$inferSelect
export type Stream = typeof StreamTable.$inferSelect

// Who an audit event is attributed to; SCIM provisioning has no user, only a token name.
export type Actor = { readonly id: string | null; readonly email: string }

const day = 24 * 60 * 60 * 1000
const now = Clock.currentTimeMillis
// Emails and domain names are stored lowercase and always looked up lowercase.
const lower = (value: string) => value.trim().toLowerCase()
const decodePolicy = Schema.decodeUnknownSync(Policy)
const decodeMode = Schema.decodeUnknownSync(Mode)
const decodeAccess = Schema.decodeUnknownSync(Schema.NullOr(ModelAccess))
const failed = (error: unknown): error is SqlError | EffectDrizzleError | EffectDrizzleQueryError =>
  isSqlError(error) || error instanceof EffectDrizzleError || error instanceof EffectDrizzleQueryError

// Token rows without the secret hash, which never leaves the store.
const { hash: _, ...tokenColumns } = getColumns(TokenTable)

const make = Effect.gen(function* () {
  const { db } = yield* Database.Service

  const findOrg = Effect.fn("Store.org.get")(function* (ref: string) {
    return (yield* db
      .select()
      .from(OrgTable)
      .where(or(eq(OrgTable.id, ref), eq(OrgTable.slug, ref)))
      .limit(1))[0]
  }, Effect.orDie)

  const org = {
    get: findOrg,
    create: Effect.fn("Store.org.create")(function* (input: { name: string; slug: string; parent?: string }) {
      return (yield* db
        .insert(OrgTable)
        .values({
          id: Crypto.id("org"),
          name: input.name,
          slug: input.slug,
          parent: input.parent ?? null,
          created: yield* now,
        })
        .returning())[0]
    }, Effect.orDie),
    update: Effect.fn("Store.org.update")(function* (
      id: string,
      input: { name?: string; settings?: Record<string, unknown>; seats?: number | null },
    ) {
      const patch = {
        ...(input.name != null && { name: input.name }),
        ...(input.settings != null && { settings: input.settings }),
        ...(input.seats !== undefined && { seats: input.seats }),
      }
      if (Object.keys(patch).length > 0) yield* db.update(OrgTable).set(patch).where(eq(OrgTable.id, id))
      return (yield* findOrg(id))!
    }, Effect.orDie),
    children: Effect.fn("Store.org.children")(function* (id: string) {
      return yield* db.select().from(OrgTable).where(eq(OrgTable.parent, id)).orderBy(asc(OrgTable.name))
    }, Effect.orDie),
  }

  const getUser = Effect.fn("Store.user.get")(function* (id: string) {
    return (yield* db.select().from(UserTable).where(eq(UserTable.id, id)).limit(1))[0]
  }, Effect.orDie)
  const findUser = Effect.fn("Store.user.find")(function* (email: string) {
    return (yield* db
      .select()
      .from(UserTable)
      .where(eq(UserTable.email, lower(email)))
      .limit(1))[0]
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
      // Two first sign-ins for one email can both get here; the one that loses reads the winner's row.
      const created = (yield* db
        .insert(UserTable)
        .values({
          id: Crypto.id("usr"),
          email: lower(input.email),
          name: input.name ?? null,
          external: input.external ?? null,
          created: yield* now,
        })
        .onConflictDoNothing({ target: UserTable.email })
        .returning())[0]
      return created ?? (yield* findUser(input.email))!
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
      const direct = (yield* db
        .select({ role: MemberTable.role })
        .from(MemberTable)
        .where(and(eq(MemberTable.org, orgID), eq(MemberTable.user, userID), isNull(MemberTable.suspended)))
        .limit(1))[0]
      if (direct) return { role: direct.role, inherited: false }
      const parent = (yield* db
        .select({ role: MemberTable.role })
        .from(OrgTable)
        .innerJoin(MemberTable, eq(MemberTable.org, OrgTable.parent))
        .where(and(eq(OrgTable.id, orgID), eq(MemberTable.user, userID), isNull(MemberTable.suspended)))
        .limit(1))[0]
      if (parent && inherited.includes(parent.role)) return { role: parent.role, inherited: true }
      return undefined
    }, Effect.orDie),
    // Raw membership row, including suspended ones; used by SCIM, which must see deactivated users.
    get: Effect.fn("Store.member.get")(function* (orgID: string, userID: string) {
      return (yield* db
        .select({ role: MemberTable.role, suspended: MemberTable.suspended })
        .from(MemberTable)
        .where(and(eq(MemberTable.org, orgID), eq(MemberTable.user, userID)))
        .limit(1))[0]
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
      const row = (yield* db
        .select({ n: count() })
        .from(MemberTable)
        .innerJoin(OrgTable, eq(OrgTable.id, MemberTable.org))
        .where(
          and(eq(MemberTable.user, userID), ne(OrgTable.id, orgID), sql`coalesce(${OrgTable.parent}, '') <> ${orgID}`),
        )
        .limit(1))[0]
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
      const row = (yield* db.select().from(SsoTable).where(eq(SsoTable.org, orgID)).limit(1))[0]
      if (!row) return undefined
      const common = {
        org: row.org,
        issuer: row.issuer,
        enforce: row.enforce,
        provision: row.provision,
        updated: row.updated,
      }
      const sso: Sso =
        row.protocol === "saml"
          ? {
              ...common,
              protocol: "saml",
              entry: row.entry ?? "",
              certificates: row.certificates ?? [],
              unsolicited: row.unsolicited,
            }
          : {
              ...common,
              protocol: "oidc",
              client: row.client ?? "",
              secret: row.secret ?? "",
              scopes: row.scopes ?? "openid email profile",
            }
      return sso
    }, Effect.orDie),
    // One connection per org: saving one protocol's settings clears the other's.
    set: Effect.fn("Store.sso.set")(function* (orgID: string, input: OidcConnection | SamlConnection) {
      const oidc = input.protocol === "oidc" ? input : undefined
      const saml = input.protocol === "saml" ? input : undefined
      const row = {
        protocol: input.protocol,
        issuer: input.issuer,
        client: oidc?.client ?? null,
        secret: oidc?.secret ?? null,
        scopes: oidc?.scopes ?? null,
        entry: saml?.entry ?? null,
        certificates: saml ? [...saml.certificates] : null,
        unsolicited: saml?.unsolicited ?? false,
        enforce: input.enforce,
        provision: input.provision,
        updated: yield* now,
      }
      yield* db
        .insert(SsoTable)
        .values({ org: orgID, ...row })
        .onConflictDoUpdate({ target: SsoTable.org, set: row })
    }, Effect.orDie),
    remove: Effect.fn("Store.sso.remove")(function* (orgID: string) {
      yield* db.delete(SsoTable).where(eq(SsoTable.org, orgID))
    }, Effect.orDie),
  }

  // SAML assertions a sign-in used up. False when this one was already used.
  const assertion = {
    consume: Effect.fn("Store.assertion.consume")(function* (orgID: string, id: string, expires: number) {
      const row = (yield* db
        .insert(AssertionTable)
        .values({ org: orgID, id, expires })
        .onConflictDoNothing()
        .returning({ id: AssertionTable.id }))[0]
      return row !== undefined
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
      return (yield* db
        .select()
        .from(DeviceTable)
        .where(eq(DeviceTable.hash, Crypto.hash(value)))
        .limit(1))[0]
    }, Effect.orDie),
    code: Effect.fn("Store.device.code")(function* (code: string) {
      return (yield* db.select().from(DeviceTable).where(eq(DeviceTable.code, code.trim().toUpperCase())).limit(1))[0]
    }, Effect.orDie),
    poll: Effect.fn("Store.device.poll")(function* (hash: string) {
      yield* db
        .update(DeviceTable)
        .set({ polled: yield* now })
        .where(eq(DeviceTable.hash, hash))
    }, Effect.orDie),
    // Only a pending, unexpired code can change state, so a code can never be approved twice.
    decide: Effect.fn("Store.device.decide")(function* (code: string, status: "approved" | "denied", userID?: string) {
      const row = (yield* db
        .update(DeviceTable)
        .set({ status, user: userID ?? null })
        .where(and(eq(DeviceTable.code, code), eq(DeviceTable.status, "pending"), gt(DeviceTable.expires, yield* now)))
        .returning({ hash: DeviceTable.hash }))[0]
      return row !== undefined
    }, Effect.orDie),
    consume: Effect.fn("Store.device.consume")(function* (hash: string) {
      const row = (yield* db
        .update(DeviceTable)
        .set({ status: "consumed" })
        .where(and(eq(DeviceTable.hash, hash), eq(DeviceTable.status, "approved")))
        .returning({ hash: DeviceTable.hash }))[0]
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
      return (yield* db.delete(LoginTable).where(eq(LoginTable.state, state)).returning())[0]
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
      return (yield* db
        .select()
        .from(InviteTable)
        .where(and(eq(InviteTable.hash, Crypto.hash(value)), yield* live()))
        .limit(1))[0]
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
      const row = (yield* db
        .update(InviteTable)
        .set({ accepted: yield* now })
        .where(and(eq(InviteTable.id, id), yield* live()))
        .returning({ id: InviteTable.id }))[0]
      return row !== undefined
    }, Effect.orDie),
    revoke: Effect.fn("Store.invite.revoke")(function* (orgID: string, id: string) {
      const row = (yield* db
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
        .returning({ id: InviteTable.id }))[0]
      return row !== undefined
    }, Effect.orDie),
  }

  const domain = {
    list: Effect.fn("Store.domain.list")(function* (orgID: string) {
      return yield* db.select().from(DomainTable).where(eq(DomainTable.org, orgID)).orderBy(asc(DomainTable.name))
    }, Effect.orDie),
    get: Effect.fn("Store.domain.get")(function* (name: string) {
      return (yield* db
        .select()
        .from(DomainTable)
        .where(eq(DomainTable.name, lower(name)))
        .limit(1))[0]
    }, Effect.orDie),
    create: Effect.fn("Store.domain.create")(function* (orgID: string, name: string) {
      return (yield* db
        .insert(DomainTable)
        .values({
          name: lower(name),
          org: orgID,
          token: `kilo-org-verify=${Crypto.secret(18)}`,
          created: yield* now,
        })
        .returning())[0]
    }, Effect.orDie),
    verify: Effect.fn("Store.domain.verify")(function* (name: string) {
      yield* db
        .update(DomainTable)
        .set({ verified: yield* now })
        .where(eq(DomainTable.name, lower(name)))
    }, Effect.orDie),
    remove: Effect.fn("Store.domain.remove")(function* (orgID: string, name: string) {
      const row = (yield* db
        .delete(DomainTable)
        .where(and(eq(DomainTable.org, orgID), eq(DomainTable.name, lower(name))))
        .returning({ name: DomainTable.name }))[0]
      return row !== undefined
    }, Effect.orDie),
    // The org that owns the verified domain of this email address, if any.
    owner: Effect.fn("Store.domain.owner")(function* (email: string) {
      const host = email.split("@").at(-1)?.toLowerCase()
      if (!host) return undefined
      const row = (yield* db
        .select({ org: DomainTable.org })
        .from(DomainTable)
        .where(and(eq(DomainTable.name, host), sql`${DomainTable.verified} is not null`))
        .limit(1))[0]
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
      const row = (yield* db
        .select(tokenColumns)
        .from(TokenTable)
        .where(eq(TokenTable.hash, Crypto.hash(value)))
        .limit(1))[0]
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
      return (yield* db.select(tokenColumns).from(TokenTable).where(eq(TokenTable.id, id)).limit(1))[0]
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
      return (yield* db
        .select()
        .from(GroupTable)
        .where(and(eq(GroupTable.org, orgID), eq(GroupTable.id, id)))
        .limit(1))[0]
    }, Effect.orDie),
    create: Effect.fn("Store.group.create")(function* (
      orgID: string,
      input: { name: string; external?: string | null; models?: ModelAccess | null },
    ) {
      return (yield* db
        .insert(GroupTable)
        .values({
          id: Crypto.id("grp"),
          org: orgID,
          name: input.name,
          external: input.external ?? null,
          models: input.models ?? null,
          created: yield* now,
        })
        .returning())[0]
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
    const row = (yield* db.select().from(PolicyTable).where(eq(PolicyTable.org, orgID)).limit(1))[0]
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
      const values = {
        org: input.org,
        at: yield* now,
        action: input.action,
        actor: input.actor?.id ?? null,
        email: input.actor?.email ?? null,
        target: input.target ?? null,
        details: input.details ?? {},
        ip: input.ip ?? null,
      }
      // Audit streams send what comes after the last id they delivered. Ids are taken and committed
      // one at a time across replicas, so an event can never commit behind one already delivered.
      yield* db.transaction(() =>
        Effect.gen(function* () {
          yield* db.execute(sql`select pg_advisory_xact_lock(hashtext('kilo-organization:audit'))`)
          yield* db.insert(AuditTable).values(values)
        }),
      )
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
            input.actor ? sql`lower(${AuditTable.email}) = lower(${input.actor})` : undefined,
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

  // Housekeeping for short-lived rows: device codes, abandoned SSO logins, used SAML assertions
  // past their lifetime, and audit history past retention. Without a retention the audit log is
  // kept forever.
  const sweep = Effect.fn("Store.sweep")(function* (retention: number | undefined) {
    const time = yield* now
    yield* db.delete(DeviceTable).where(lt(DeviceTable.expires, time - day))
    yield* db.delete(LoginTable).where(lt(LoginTable.created, time - day))
    yield* db.delete(AssertionTable).where(lt(AssertionTable.expires, time))
    yield* db.delete(GatewayWindowTable).where(lt(GatewayWindowTable.start, time - 60 * 60 * 1000))
    // Each org keeps its gateway log for its own policy's retention, 30 days by default.
    yield* db.execute(sql`
      delete from gateway_calls c
      where c.at < ${time} - ${day}::bigint * coalesce(
        (select (p.data -> 'gateway' -> 'log' ->> 'retention')::bigint from policies p where p.org = c.org), 30)`)
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
            const inserted = (yield* db
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
              .returning({ id: UsageTable.id }))[0]
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
        day: sql`to_char(to_timestamp(s.at / 1000.0) at time zone 'UTC', 'YYYY-MM-DD')`,
        project: sql`coalesce(s.project, '')`,
        source: sql`s.source`,
      }[input.by]
      // Counts and sums come back as 64-bit values, which Postgres drivers return as strings: cast
      // them to numbers in SQL.
      return yield* db.execute<{
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
        select ${key} as key, count(*)::float8 as requests, count(distinct s.user)::float8 as users,
          sum(s.input)::float8 as input, sum(s.output)::float8 as output, sum(s.reasoning)::float8 as reasoning,
          sum(s.cache_read)::float8 as cache_read, sum(s.cache_write)::float8 as cache_write,
          round(sum(s.cost)::numeric, 6)::float8 as cost
        from usage s join users u on u.id = s.user
        where ${window(input)}
        group by 1 order by cost desc, requests desc`)
    }, Effect.orDie),
    rows: Effect.fn("Store.usage.rows")(function* (input: { org: string; from: number; to: number; user?: string }) {
      return yield* db.execute<Record<string, string | number | null>>(sql`
        select s.id, s.at::float8 as at, u.email, s.session, s.project, s.provider, s.model, s.input::float8 as input,
          s.output::float8 as output, s.reasoning::float8 as reasoning, s.cache_read::float8 as cache_read,
          s.cache_write::float8 as cache_write, s.cost, s.source
        from usage s join users u on u.id = s.user
        where ${window(input)} order by s.at`)
    }, Effect.orDie),
    // Spend since `from` in these orgs: everyone's, one person's, or a group's members'. Rounded to
    // micro-dollars so float summation noise never reaches budgets or the UI.
    spent: Effect.fn("Store.usage.spent")(function* (input: {
      orgs: ReadonlyArray<string>
      from: number
      user?: string
      group?: string
    }) {
      const row = (yield* db
        .select({ n: sql<number | null>`sum(${UsageTable.cost})` })
        .from(UsageTable)
        .where(
          and(
            inArray(UsageTable.org, [...input.orgs]),
            gte(UsageTable.at, input.from),
            input.user ? eq(UsageTable.user, input.user) : undefined,
            input.group
              ? inArray(
                  UsageTable.user,
                  db
                    .select({ user: GroupMemberTable.user })
                    .from(GroupMemberTable)
                    .where(eq(GroupMemberTable.grp, input.group)),
                )
              : undefined,
          ),
        )
        .limit(1))[0]
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
      return (yield* db.select().from(GatewayProviderTable).where(where(orgID, id)).limit(1))[0]
    }, Effect.orDie),
    // `secret` and `headers` are already sealed.
    set: Effect.fn("Store.gateway.set")(function* (
      orgID: string,
      id: string,
      input: {
        kind: GatewayKind
        base: string
        auth: GatewayAuth | null
        secret: string
        hint: string
        headers: string | null
        names: string[]
        query: Record<string, string>
        name: string | null
        models: GatewayModel[]
      },
    ) {
      const time = yield* now
      return (yield* db
        .insert(GatewayProviderTable)
        .values({ org: orgID, id, ...input, created: time, updated: time })
        .onConflictDoUpdate({
          target: [GatewayProviderTable.org, GatewayProviderTable.id],
          set: { ...input, updated: time },
        })
        .returning())[0]
    }, Effect.orDie),
    remove: Effect.fn("Store.gateway.remove")(function* (orgID: string, id: string) {
      const row = (yield* db
        .delete(GatewayProviderTable)
        .where(where(orgID, id))
        .returning({ id: GatewayProviderTable.id }))[0]
      return row !== undefined
    }, Effect.orDie),
  }

  const price = {
    list: Effect.fn("Store.price.list")(function* (orgID: string) {
      return yield* db
        .select()
        .from(PriceTable)
        .where(eq(PriceTable.org, orgID))
        .orderBy(asc(PriceTable.provider), asc(PriceTable.model))
    }, Effect.orDie),
    replace: Effect.fn("Store.price.replace")(function* (orgID: string, prices: ReadonlyArray<Price>) {
      yield* db.transaction(() =>
        Effect.gen(function* () {
          yield* db.delete(PriceTable).where(eq(PriceTable.org, orgID))
          if (prices.length === 0) return
          yield* db.insert(PriceTable).values(
            prices.map((item) => ({
              org: orgID,
              provider: item.provider,
              model: item.model,
              rates: item.rates ?? null,
              discount: item.discount ?? null,
            })),
          )
        }),
      )
    }, Effect.orDie),
    // The rule for one model: its own, else the provider's "*".
    rule: Effect.fn("Store.price.rule")(function* (orgID: string, provider: string, model: string) {
      const rows = yield* db
        .select()
        .from(PriceTable)
        .where(
          and(eq(PriceTable.org, orgID), eq(PriceTable.provider, provider), inArray(PriceTable.model, [model, "*"])),
        )
      return rows.find((row) => row.model === model) ?? rows.find((row) => row.model === "*")
    }, Effect.orDie),
  }

  // Fixed one-minute windows, counted in the database so every replica sees the same totals.
  const rate = {
    // Counts a call into the window and returns the window's totals with it.
    hit: Effect.fn("Store.rate.hit")(function* (orgID: string, userID: string, start: number) {
      return (yield* db
        .insert(GatewayWindowTable)
        .values({ org: orgID, user: userID, start, requests: 1 })
        .onConflictDoUpdate({
          target: [GatewayWindowTable.org, GatewayWindowTable.user, GatewayWindowTable.start],
          set: { requests: sql`${GatewayWindowTable.requests} + 1` },
        })
        .returning({ requests: GatewayWindowTable.requests, tokens: GatewayWindowTable.tokens }))[0]!
    }, Effect.orDie),
    spend: Effect.fn("Store.rate.spend")(function* (orgID: string, userID: string, start: number, tokens: number) {
      yield* db
        .insert(GatewayWindowTable)
        .values({ org: orgID, user: userID, start, tokens })
        .onConflictDoUpdate({
          target: [GatewayWindowTable.org, GatewayWindowTable.user, GatewayWindowTable.start],
          set: { tokens: sql`${GatewayWindowTable.tokens} + ${tokens}` },
        })
    }, Effect.orDie),
  }

  const call = {
    record: Effect.fn("Store.call.record")(function* (row: typeof GatewayCallTable.$inferInsert) {
      return (yield* db.insert(GatewayCallTable).values(row).returning({ id: GatewayCallTable.id }))[0]!.id
    }, Effect.orDie),
    list: Effect.fn("Store.call.list")(function* (input: {
      org: string
      from: number
      to: number
      user?: string
      provider?: string
      failed?: boolean
      before?: number
      limit: number
    }) {
      const { request: _request, response: _response, ...columns } = getColumns(GatewayCallTable)
      return yield* db
        .select({
          ...columns,
          email: UserTable.email,
          bodies: sql<boolean>`(${GatewayCallTable.request} is not null or ${GatewayCallTable.response} is not null)`,
        })
        .from(GatewayCallTable)
        .leftJoin(UserTable, eq(UserTable.id, GatewayCallTable.user))
        .where(
          and(
            eq(GatewayCallTable.org, input.org),
            gte(GatewayCallTable.at, input.from),
            lt(GatewayCallTable.at, input.to),
            input.user ? eq(GatewayCallTable.user, input.user) : undefined,
            input.provider ? eq(GatewayCallTable.provider, input.provider) : undefined,
            input.failed === undefined
              ? undefined
              : input.failed
                ? or(gte(GatewayCallTable.status, 400), sql`${GatewayCallTable.code} is not null`)
                : and(lt(GatewayCallTable.status, 400), isNull(GatewayCallTable.code)),
            input.before ? lt(GatewayCallTable.id, input.before) : undefined,
          ),
        )
        .orderBy(desc(GatewayCallTable.id))
        .limit(input.limit)
    }, Effect.orDie),
    get: Effect.fn("Store.call.get")(function* (orgID: string, id: number) {
      return (yield* db
        .select({ ...getColumns(GatewayCallTable), email: UserTable.email })
        .from(GatewayCallTable)
        .leftJoin(UserTable, eq(UserTable.id, GatewayCallTable.user))
        .where(and(eq(GatewayCallTable.org, orgID), eq(GatewayCallTable.id, id)))
        .limit(1))[0]
    }, Effect.orDie),
  }

  const pending = (row: { org: string; cursor: number }) =>
    db.$count(AuditTable, and(eq(AuditTable.org, row.org), gt(AuditTable.id, row.cursor)))

  const stream = {
    list: Effect.fn("Store.stream.list")(function* (orgID: string) {
      const rows = yield* db
        .select()
        .from(StreamTable)
        .where(eq(StreamTable.org, orgID))
        .orderBy(asc(StreamTable.created))
      return yield* Effect.forEach(rows, (row) => Effect.map(pending(row), (count) => ({ ...row, pending: count })))
    }, Effect.orDie),
    get: Effect.fn("Store.stream.get")(function* (orgID: string, id: string) {
      return (yield* db
        .select()
        .from(StreamTable)
        .where(and(eq(StreamTable.org, orgID), eq(StreamTable.id, id)))
        .limit(1))[0]
    }, Effect.orDie),
    pending: Effect.fn("Store.stream.pending")(function* (row: { org: string; cursor: number }) {
      return yield* pending(row)
    }, Effect.orDie),
    // New streams start after the latest event; history is available as CSV.
    create: Effect.fn("Store.stream.create")(function* (
      orgID: string,
      input: {
        name: string
        target: StreamTarget
        secret: string | null
        headers: string | null
        names: string[]
        enabled: boolean
      },
    ) {
      const latest = (yield* db
        .select({ id: sql<number | null>`max(${AuditTable.id})::float8` })
        .from(AuditTable)
        .where(eq(AuditTable.org, orgID))
        .limit(1))[0]
      const time = yield* now
      return (yield* db
        .insert(StreamTable)
        .values({
          id: Crypto.id("str"),
          org: orgID,
          ...input,
          cursor: latest?.id ?? 0,
          created: time,
          updated: time,
        })
        .returning())[0]
    }, Effect.orDie),
    update: Effect.fn("Store.stream.update")(function* (
      orgID: string,
      id: string,
      patch: Partial<{
        name: string
        target: StreamTarget
        secret: string | null
        headers: string | null
        names: string[]
        enabled: boolean
      }>,
    ) {
      // A change of destination or a resume gets a fresh attempt rather than waiting out a backoff.
      return (yield* db
        .update(StreamTable)
        .set({ ...patch, retry: null, updated: yield* now })
        .where(and(eq(StreamTable.org, orgID), eq(StreamTable.id, id)))
        .returning())[0]
    }, Effect.orDie),
    remove: Effect.fn("Store.stream.remove")(function* (orgID: string, id: string) {
      const row = (yield* db
        .delete(StreamTable)
        .where(and(eq(StreamTable.org, orgID), eq(StreamTable.id, id)))
        .returning({ id: StreamTable.id }))[0]
      return row !== undefined
    }, Effect.orDie),
    // Streams with events to send and no backoff or other delivery in the way.
    due: Effect.fn("Store.stream.due")(function* () {
      const time = yield* now
      return yield* db
        .select()
        .from(StreamTable)
        .where(
          and(
            eq(StreamTable.enabled, true),
            or(isNull(StreamTable.retry), lte(StreamTable.retry, time)),
            or(isNull(StreamTable.lease), lt(StreamTable.lease, time)),
            sql`exists (select 1 from ${AuditTable} where ${AuditTable.org} = ${StreamTable.org} and ${AuditTable.id} > ${StreamTable.cursor})`,
          ),
        )
    }, Effect.orDie),
    // Atomic, so of several workers racing for a stream exactly one wins it.
    claim: Effect.fn("Store.stream.claim")(function* (id: string, ttl: number) {
      const time = yield* now
      const row = (yield* db
        .update(StreamTable)
        .set({ lease: time + ttl })
        .where(and(eq(StreamTable.id, id), or(isNull(StreamTable.lease), lt(StreamTable.lease, time))))
        .returning())[0]
      return row
    }, Effect.orDie),
    events: Effect.fn("Store.stream.events")(function* (row: { org: string; cursor: number }, limit: number) {
      return yield* db
        .select()
        .from(AuditTable)
        .where(and(eq(AuditTable.org, row.org), gt(AuditTable.id, row.cursor)))
        .orderBy(asc(AuditTable.id))
        .limit(limit)
    }, Effect.orDie),
    delivered: Effect.fn("Store.stream.delivered")(function* (id: string, cursor: number) {
      yield* db
        .update(StreamTable)
        .set({ cursor, delivered: yield* now, error: null, failing: null, failures: 0, retry: null, lease: null })
        .where(eq(StreamTable.id, id))
    }, Effect.orDie),
    failed: Effect.fn("Store.stream.failed")(function* (id: string, error: string, retry: number) {
      const time = yield* now
      yield* db
        .update(StreamTable)
        .set({
          error,
          failing: sql`coalesce(${StreamTable.failing}, ${time})`,
          failures: sql`${StreamTable.failures} + 1`,
          retry,
          lease: null,
        })
        .where(eq(StreamTable.id, id))
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

  // An org with its sub-orgs: what an "org" budget covers.
  const tree = Effect.fn("Store.org.tree")(function* (orgID: string) {
    const children = yield* db.select({ id: OrgTable.id }).from(OrgTable).where(eq(OrgTable.parent, orgID))
    return [orgID, ...children.map((child) => child.id)]
  }, Effect.orDie)

  const periods = Effect.gen(function* () {
    const date = new Date(yield* now)
    return {
      day: Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
      month: Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1),
    }
  })

  // What a budget row has spent this period: the whole of what it covers, or null for "member",
  // where each person has their own.
  const spending = Effect.fn("Store.budget.spending")(function* (
    orgID: string,
    row: Budget,
    start: { day: number; month: number },
  ) {
    const from = start[row.period]
    if (row.scope === "member") return null
    if (row.scope === "org") return yield* usage.spent({ orgs: yield* tree(orgID), from })
    if (row.scope === "user") return yield* usage.spent({ orgs: [orgID], from, user: row.target })
    if (row.scope === "group") return yield* usage.spent({ orgs: [orgID], from, group: row.target })
    return yield* usage.spent({ orgs: [row.target], from })
  })

  // The seat limit that governs an org (its own, or its parent's) and how many seats are taken:
  // people with an active membership anywhere in the top-level org's tree.
  const occupied = Effect.fn("Store.seats.usage")(function* (orgID: string) {
    const found = yield* findOrg(orgID)
    const root = found?.parent ? yield* findOrg(found.parent) : found
    if (!root) return { root: orgID, limit: null, used: 0 }
    const row = (yield* db
      .select({ n: sql<number>`count(distinct ${MemberTable.user})::int` })
      .from(MemberTable)
      .where(and(inArray(MemberTable.org, yield* tree(root.id)), isNull(MemberTable.suspended)))
      .limit(1))[0]
    return { root: root.id, limit: root.seats, used: row?.n ?? 0 }
  }, Effect.orDie)

  const seats = {
    usage: occupied,
    // Why adding this person would need a seat there isn't, if it would. Someone already seated
    // elsewhere in the tree doesn't take another.
    full: Effect.fn("Store.seats.full")(function* (orgID: string, userID: string) {
      const taken = yield* occupied(orgID)
      if (taken.limit === null || taken.used < taken.limit) return undefined
      const seated = yield* db.$count(
        MemberTable,
        and(
          eq(MemberTable.user, userID),
          inArray(MemberTable.org, yield* tree(taken.root)),
          isNull(MemberTable.suspended),
        ),
      )
      if (seated > 0) return undefined
      const root = yield* findOrg(taken.root)
      return `${root?.name ?? "This organization"} has no seats left: all ${taken.limit} are taken. An owner can add seats, or free one by removing or suspending someone.`
    }, Effect.orDie),
  }

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
    // Budgets that bind this user, with spend for the current UTC day/month: the org's own, and
    // a parent org's budget and the allowance it gives this org.
    status: Effect.fn("Store.budget.status")(function* (orgID: string, userID: string) {
      const start = yield* periods
      const found = yield* findOrg(orgID)
      const parent = found?.parent ? yield* findOrg(found.parent) : undefined
      const rows = yield* listBudgets(orgID)
      const groups = new Map((yield* group.of(orgID, userID)).map((row) => [row.id, row.name]))
      const own = new Set(rows.filter((row) => row.scope === "user" && row.target === userID).map((row) => row.period))
      const binding = rows.filter((row) => {
        if (row.scope === "org") return true
        if (row.scope === "user") return row.target === userID
        if (row.scope === "group") return groups.has(row.target)
        // Allowances for sub-orgs bind their members, not this org's.
        if (row.scope === "suborg") return false
        // A per-user override replaces the member default for the same period.
        return !own.has(row.period)
      })
      const inherited = parent
        ? (yield* listBudgets(parent.id)).filter(
            (row) => row.scope === "org" || (row.scope === "suborg" && row.target === orgID),
          )
        : []
      const mine = yield* Effect.forEach(
        binding,
        (row): Effect.Effect<BudgetStatus> =>
          Effect.gen(function* () {
            const scope = row.scope === "member" || row.scope === "user" ? row.scope : "org"
            const spent =
              scope === "org"
                ? ((yield* spending(orgID, row, start)) ?? 0)
                : yield* usage.spent({ orgs: [orgID], from: start[row.period], user: userID })
            return {
              scope,
              period: row.period,
              amount: row.amount,
              spent,
              ...(row.scope === "group" ? { name: `${groups.get(row.target)} group` } : {}),
            }
          }),
      )
      const theirs = yield* Effect.forEach(
        inherited,
        (row): Effect.Effect<BudgetStatus> =>
          spending(parent!.id, row, start).pipe(
            Effect.map((spent) => ({
              scope: "org" as const,
              period: row.period,
              amount: row.amount,
              spent: spent ?? 0,
              // The parent's own budget covers everyone under it; its allowance is this org's budget.
              ...(row.scope === "org" ? { name: parent!.name } : {}),
            })),
          ),
      )
      return [...mine, ...theirs]
    }),
    // The org's budgets with this period's spend, and the parent org's budgets that bind it too.
    spend: Effect.fn("Store.budget.spend")(function* (orgID: string) {
      const start = yield* periods
      const found = yield* findOrg(orgID)
      const parent = found?.parent ? yield* findOrg(found.parent) : undefined
      const mine = yield* Effect.forEach(
        yield* listBudgets(orgID),
        (row): Effect.Effect<BudgetSpend> =>
          spending(orgID, row, start).pipe(Effect.map((spent) => ({ ...row, spent, from: null }))),
      )
      const theirs = parent
        ? yield* Effect.forEach(
            (yield* listBudgets(parent.id)).filter(
              (row) => row.scope === "org" || (row.scope === "suborg" && row.target === orgID),
            ),
            (row): Effect.Effect<BudgetSpend> =>
              spending(parent.id, row, start).pipe(Effect.map((spent) => ({ ...row, spent, from: parent.name }))),
          )
        : []
      return [...mine, ...theirs]
    }),
  }

  return {
    org,
    user,
    member,
    sso,
    assertion,
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
    price,
    rate,
    call,
    stream,
    budget,
    seats,
    sweep,
    // Runs an effect atomically; store calls inside it share the transaction. SQL failures are defects.
    transaction: <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
      db
        .transaction(() =>
          Effect.gen(function* () {
            // One at a time across every replica, so a check and the writes that depend on it can't
            // interleave with another request's.
            yield* db.execute(sql`select pg_advisory_xact_lock(hashtext('kilo-organization:store'))`)
            return yield* effect
          }),
        )
        // A failed query or commit is a defect here, as everywhere else in the store. TypeScript
        // can't subtract those errors from a generic E, so the type says what the code does.
        .pipe(Effect.catchIf(failed, Effect.die)) as Effect.Effect<A, E, R>,
  }
})

export interface Interface extends Effect.Success<typeof make> {}

export class Service extends Context.Service<Service, Interface>()("@organization/Store") {}

export const layer = Layer.effect(Service, make)

export const node = LayerNode.make({ service: Service, layer, deps: [Database.node] })
