import { sql } from "drizzle-orm"
import {
  check,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
  type AnySQLiteColumn,
} from "drizzle-orm/sqlite-core"
import type { GatewayKind, ModelAccess, Policy, Role } from "@enterprise/protocol/schema"

const roles = sql`('owner', 'admin', 'member', 'billing_manager')`

export const OrgTable = sqliteTable("orgs", {
  id: text().primaryKey(),
  name: text().notNull(),
  slug: text().notNull().unique(),
  parent: text().references((): AnySQLiteColumn => OrgTable.id, { onDelete: "cascade" }),
  settings: text({ mode: "json" }).$type<Record<string, unknown>>().notNull().default({}),
  created: integer().notNull(),
})

// Emails are stored lowercase and always looked up lowercase.
export const UserTable = sqliteTable("users", {
  id: text().primaryKey(),
  email: text().notNull().unique(),
  name: text(),
  external: text(),
  active: integer({ mode: "boolean" }).notNull().default(true),
  created: integer().notNull(),
})

export const MemberTable = sqliteTable(
  "members",
  {
    org: text()
      .notNull()
      .references(() => OrgTable.id, { onDelete: "cascade" }),
    user: text()
      .notNull()
      .references(() => UserTable.id, { onDelete: "cascade" }),
    role: text().$type<Role>().notNull(),
    created: integer().notNull(),
    // SCIM active=false suspends a membership without losing its role or history.
    suspended: integer(),
  },
  (table) => [
    primaryKey({ columns: [table.org, table.user] }),
    check("members_role", sql`${table.role} in ${roles}`),
    index("members_user").on(table.user),
  ],
)

export const InviteTable = sqliteTable(
  "invites",
  {
    id: text().primaryKey(),
    org: text()
      .notNull()
      .references(() => OrgTable.id, { onDelete: "cascade" }),
    email: text().notNull(),
    role: text().$type<Role>().notNull(),
    hash: text().notNull().unique(),
    actor: text().references(() => UserTable.id, { onDelete: "set null" }),
    created: integer().notNull(),
    expires: integer().notNull(),
    accepted: integer(),
    revoked: integer(),
  },
  (table) => [
    check("invites_role", sql`${table.role} in ${roles}`),
    index("invites_org_email").on(table.org, table.email),
  ],
)

export const GroupTable = sqliteTable(
  "org_groups",
  {
    id: text().primaryKey(),
    org: text()
      .notNull()
      .references(() => OrgTable.id, { onDelete: "cascade" }),
    name: text().notNull(),
    external: text(),
    models: text({ mode: "json" }).$type<ModelAccess>(),
    created: integer().notNull(),
  },
  (table) => [uniqueIndex("org_groups_org_name").on(table.org, table.name)],
)

export const GroupMemberTable = sqliteTable(
  "group_members",
  {
    grp: text()
      .notNull()
      .references(() => GroupTable.id, { onDelete: "cascade" }),
    user: text()
      .notNull()
      .references(() => UserTable.id, { onDelete: "cascade" }),
  },
  (table) => [primaryKey({ columns: [table.grp, table.user] })],
)

// Domain names are stored lowercase.
export const DomainTable = sqliteTable("domains", {
  name: text().primaryKey(),
  org: text()
    .notNull()
    .references(() => OrgTable.id, { onDelete: "cascade" }),
  token: text().notNull(),
  verified: integer(),
  created: integer().notNull(),
})

export const TokenTable = sqliteTable(
  "tokens",
  {
    id: text().primaryKey(),
    hash: text().notNull().unique(),
    kind: text().$type<"user" | "scim">().notNull(),
    user: text().references(() => UserTable.id, { onDelete: "cascade" }),
    // Every token is bound to one org; see Tokens.issue.
    org: text()
      .notNull()
      .references(() => OrgTable.id, { onDelete: "cascade" }),
    name: text().notNull(),
    created: integer().notNull(),
    expires: integer(),
    used: integer(),
    revoked: integer(),
  },
  (table) => [check("tokens_kind", sql`${table.kind} in ('user', 'scim')`), index("tokens_user").on(table.user)],
)

export const DeviceTable = sqliteTable(
  "devices",
  {
    hash: text().primaryKey(),
    code: text().notNull().unique(),
    org: text()
      .notNull()
      .references(() => OrgTable.id, { onDelete: "cascade" }),
    user: text().references(() => UserTable.id, { onDelete: "cascade" }),
    status: text().$type<"pending" | "approved" | "denied" | "consumed">().notNull(),
    created: integer().notNull(),
    expires: integer().notNull(),
    polled: integer(),
  },
  (table) => [check("devices_status", sql`${table.status} in ('pending', 'approved', 'denied', 'consumed')`)],
)

export const SsoTable = sqliteTable("sso", {
  org: text()
    .primaryKey()
    .references(() => OrgTable.id, { onDelete: "cascade" }),
  issuer: text().notNull(),
  client: text().notNull(),
  // Sealed with ENTERPRISE_SECRET (AES-256-GCM); never stored in clear text.
  secret: text().notNull(),
  scopes: text().notNull(),
  enforce: integer({ mode: "boolean" }).notNull().default(false),
  provision: integer({ mode: "boolean" }).notNull().default(true),
  updated: integer().notNull(),
})

// Pending OIDC sign-ins; single use.
export const LoginTable = sqliteTable("logins", {
  state: text().primaryKey(),
  org: text()
    .notNull()
    .references(() => OrgTable.id, { onDelete: "cascade" }),
  verifier: text().notNull(),
  nonce: text().notNull(),
  device: text(),
  created: integer().notNull(),
})

export const PolicyTable = sqliteTable("policies", {
  org: text()
    .primaryKey()
    .references(() => OrgTable.id, { onDelete: "cascade" }),
  data: text({ mode: "json" }).$type<Policy>().notNull(),
  version: integer().notNull(),
  updated: integer().notNull(),
  actor: text(),
})

export const ModeTable = sqliteTable(
  "modes",
  {
    id: text().primaryKey(),
    org: text()
      .notNull()
      .references(() => OrgTable.id, { onDelete: "cascade" }),
    slug: text().notNull(),
    name: text().notNull(),
    config: text({ mode: "json" }).$type<unknown>().notNull(),
    created: integer().notNull(),
    updated: integer().notNull(),
  },
  (table) => [uniqueIndex("modes_org_slug").on(table.org, table.slug)],
)

export const AuditTable = sqliteTable(
  "audit",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    org: text().notNull(),
    at: integer().notNull(),
    action: text().notNull(),
    actor: text(),
    email: text(),
    target: text(),
    details: text({ mode: "json" }).$type<unknown>().notNull().default({}),
    ip: text(),
  },
  (table) => [index("audit_org_at").on(table.org, table.at)],
)

export const UsageTable = sqliteTable(
  "usage",
  {
    org: text()
      .notNull()
      .references(() => OrgTable.id, { onDelete: "cascade" }),
    // Client-provided per-call id; duplicates are ignored, so clients can safely resend.
    id: text().notNull(),
    user: text()
      .notNull()
      .references(() => UserTable.id, { onDelete: "cascade" }),
    at: integer().notNull(),
    session: text(),
    project: text(),
    provider: text().notNull(),
    model: text().notNull(),
    input: integer().notNull().default(0),
    output: integer().notNull().default(0),
    reasoning: integer().notNull().default(0),
    cache_read: integer().notNull().default(0),
    cache_write: integer().notNull().default(0),
    cost: real().notNull().default(0),
    // "client": reported by a client after the call. "gateway": metered by the gateway as it relayed the call.
    source: text().$type<"client" | "gateway">().notNull().default("client"),
  },
  (table) => [
    primaryKey({ columns: [table.org, table.id] }),
    index("usage_org_at").on(table.org, table.at),
    index("usage_user_at").on(table.user, table.at),
  ],
)

export const BudgetTable = sqliteTable(
  "budgets",
  {
    org: text()
      .notNull()
      .references(() => OrgTable.id, { onDelete: "cascade" }),
    scope: text().$type<"org" | "member" | "user">().notNull(),
    target: text().notNull().default(""),
    period: text().$type<"day" | "month">().notNull(),
    amount: real().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.org, table.scope, table.target, table.period] }),
    check("budgets_scope", sql`${table.scope} in ('org', 'member', 'user')`),
    check("budgets_period", sql`${table.period} in ('day', 'month')`),
  ],
)

// Upstream providers the LLM gateway relays to, with the org's API key for each.
export const GatewayProviderTable = sqliteTable(
  "gateway_providers",
  {
    org: text()
      .notNull()
      .references(() => OrgTable.id, { onDelete: "cascade" }),
    // The client provider id, which is also the gateway path segment.
    id: text().notNull(),
    kind: text().$type<GatewayKind>().notNull(),
    base: text().notNull(),
    // Sealed with ENTERPRISE_SECRET (AES-256-GCM); never stored in clear text.
    secret: text().notNull(),
    hint: text().notNull(),
    created: integer().notNull(),
    updated: integer().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.org, table.id] }),
    check("gateway_providers_kind", sql`${table.kind} in ('anthropic', 'openai', 'openai-compatible')`),
  ],
)
