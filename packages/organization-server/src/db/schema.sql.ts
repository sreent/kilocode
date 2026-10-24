import { sql } from "drizzle-orm"
import {
  bigint,
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
  type AnyPgColumn,
} from "drizzle-orm/pg-core"
import type {
  BudgetScope,
  GatewayAuth,
  GatewayKind,
  GatewayModel,
  ModelAccess,
  Policy,
  Rates,
  Role,
  SsoProtocol,
  StreamTarget,
} from "@organization/protocol/schema"

const roles = sql`('owner', 'admin', 'member', 'billing_manager')`

export const OrgTable = pgTable("orgs", {
  id: text().primaryKey(),
  name: text().notNull(),
  slug: text().notNull().unique(),
  parent: text().references((): AnyPgColumn => OrgTable.id, { onDelete: "cascade" }),
  settings: jsonb().$type<Record<string, unknown>>().notNull().default({}),
  // People who may hold a seat across the org and its sub-orgs; top-level orgs only, null is unlimited.
  seats: integer(),
  created: bigint({ mode: "number" }).notNull(),
})

// Emails are stored lowercase and always looked up lowercase.
export const UserTable = pgTable("users", {
  id: text().primaryKey(),
  email: text().notNull().unique(),
  name: text(),
  external: text(),
  active: boolean().notNull().default(true),
  created: bigint({ mode: "number" }).notNull(),
})

export const MemberTable = pgTable(
  "members",
  {
    org: text()
      .notNull()
      .references(() => OrgTable.id, { onDelete: "cascade" }),
    user: text()
      .notNull()
      .references(() => UserTable.id, { onDelete: "cascade" }),
    role: text().$type<Role>().notNull(),
    created: bigint({ mode: "number" }).notNull(),
    // SCIM active=false suspends a membership without losing its role or history.
    suspended: bigint({ mode: "number" }),
  },
  (table) => [
    primaryKey({ columns: [table.org, table.user] }),
    check("members_role", sql`${table.role} in ${roles}`),
    index("members_user").on(table.user),
  ],
)

export const InviteTable = pgTable(
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
    created: bigint({ mode: "number" }).notNull(),
    expires: bigint({ mode: "number" }).notNull(),
    accepted: bigint({ mode: "number" }),
    revoked: bigint({ mode: "number" }),
  },
  (table) => [
    check("invites_role", sql`${table.role} in ${roles}`),
    index("invites_org_email").on(table.org, table.email),
  ],
)

export const GroupTable = pgTable(
  "org_groups",
  {
    id: text().primaryKey(),
    org: text()
      .notNull()
      .references(() => OrgTable.id, { onDelete: "cascade" }),
    name: text().notNull(),
    external: text(),
    models: jsonb().$type<ModelAccess>(),
    created: bigint({ mode: "number" }).notNull(),
  },
  (table) => [uniqueIndex("org_groups_org_name").on(table.org, table.name)],
)

export const GroupMemberTable = pgTable(
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
export const DomainTable = pgTable("domains", {
  name: text().primaryKey(),
  org: text()
    .notNull()
    .references(() => OrgTable.id, { onDelete: "cascade" }),
  token: text().notNull(),
  verified: bigint({ mode: "number" }),
  created: bigint({ mode: "number" }).notNull(),
})

export const TokenTable = pgTable(
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
    created: bigint({ mode: "number" }).notNull(),
    expires: bigint({ mode: "number" }),
    used: bigint({ mode: "number" }),
    revoked: bigint({ mode: "number" }),
  },
  (table) => [check("tokens_kind", sql`${table.kind} in ('user', 'scim')`), index("tokens_user").on(table.user)],
)

export const DeviceTable = pgTable(
  "devices",
  {
    hash: text().primaryKey(),
    code: text().notNull().unique(),
    org: text()
      .notNull()
      .references(() => OrgTable.id, { onDelete: "cascade" }),
    user: text().references(() => UserTable.id, { onDelete: "cascade" }),
    status: text().$type<"pending" | "approved" | "denied" | "consumed">().notNull(),
    created: bigint({ mode: "number" }).notNull(),
    expires: bigint({ mode: "number" }).notNull(),
    polled: bigint({ mode: "number" }),
  },
  (table) => [check("devices_status", sql`${table.status} in ('pending', 'approved', 'denied', 'consumed')`)],
)

// One single sign-on connection per org, OpenID Connect or SAML 2.0.
export const SsoTable = pgTable(
  "sso",
  {
    org: text()
      .primaryKey()
      .references(() => OrgTable.id, { onDelete: "cascade" }),
    protocol: text().$type<SsoProtocol>().notNull().default("oidc"),
    // OpenID Connect: the issuer URL. SAML: the identity provider's entity ID.
    issuer: text().notNull(),
    // OpenID Connect client. The secret is sealed with ORGANIZATION_SECRET (AES-256-GCM); never stored in clear text.
    client: text(),
    secret: text(),
    scopes: text(),
    // SAML: the identity provider's sign-in URL, its signing certificates (PEM), and whether it may
    // start sign-ins itself (unsolicited responses).
    entry: text(),
    certificates: jsonb().$type<string[]>(),
    unsolicited: boolean().notNull().default(false),
    enforce: boolean().notNull().default(false),
    provision: boolean().notNull().default(true),
    updated: bigint({ mode: "number" }).notNull(),
  },
  (table) => [check("sso_protocol", sql`${table.protocol} in ('oidc', 'saml')`)],
)

// SAML assertions already used to sign in, kept until they expire so a captured response can't be
// replayed.
export const AssertionTable = pgTable(
  "saml_assertions",
  {
    org: text()
      .notNull()
      .references(() => OrgTable.id, { onDelete: "cascade" }),
    id: text().notNull(),
    expires: bigint({ mode: "number" }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.org, table.id] }), index("saml_assertions_expires").on(table.expires)],
)

// Pending sign-ins; single use. For SAML, the nonce is the AuthnRequest ID the response must answer.
export const LoginTable = pgTable("logins", {
  state: text().primaryKey(),
  org: text()
    .notNull()
    .references(() => OrgTable.id, { onDelete: "cascade" }),
  verifier: text().notNull(),
  nonce: text().notNull(),
  device: text(),
  created: bigint({ mode: "number" }).notNull(),
})

export const PolicyTable = pgTable("policies", {
  org: text()
    .primaryKey()
    .references(() => OrgTable.id, { onDelete: "cascade" }),
  data: jsonb().$type<Policy>().notNull(),
  version: integer().notNull(),
  updated: bigint({ mode: "number" }).notNull(),
  actor: text(),
})

export const ModeTable = pgTable(
  "modes",
  {
    id: text().primaryKey(),
    org: text()
      .notNull()
      .references(() => OrgTable.id, { onDelete: "cascade" }),
    slug: text().notNull(),
    name: text().notNull(),
    config: jsonb().$type<unknown>().notNull(),
    created: bigint({ mode: "number" }).notNull(),
    updated: bigint({ mode: "number" }).notNull(),
  },
  (table) => [uniqueIndex("modes_org_slug").on(table.org, table.slug)],
)

export const AuditTable = pgTable(
  "audit",
  {
    id: bigint({ mode: "number" }).primaryKey().generatedByDefaultAsIdentity(),
    org: text().notNull(),
    at: bigint({ mode: "number" }).notNull(),
    action: text().notNull(),
    actor: text(),
    email: text(),
    target: text(),
    details: jsonb().$type<unknown>().notNull().default({}),
    ip: text(),
  },
  (table) => [index("audit_org_at").on(table.org, table.at)],
)

export const UsageTable = pgTable(
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
    at: bigint({ mode: "number" }).notNull(),
    session: text(),
    project: text(),
    provider: text().notNull(),
    model: text().notNull(),
    // 64-bit, so any count the API accepts fits; one that didn't would fail the client's whole batch.
    input: bigint({ mode: "number" }).notNull().default(0),
    output: bigint({ mode: "number" }).notNull().default(0),
    reasoning: bigint({ mode: "number" }).notNull().default(0),
    cache_read: bigint({ mode: "number" }).notNull().default(0),
    cache_write: bigint({ mode: "number" }).notNull().default(0),
    cost: doublePrecision().notNull().default(0),
    // "client": reported by a client after the call. "gateway": metered by the gateway as it relayed the call.
    source: text().$type<"client" | "gateway">().notNull().default("client"),
  },
  (table) => [
    primaryKey({ columns: [table.org, table.id] }),
    index("usage_org_at").on(table.org, table.at),
    index("usage_user_at").on(table.user, table.at),
  ],
)

export const BudgetTable = pgTable(
  "budgets",
  {
    org: text()
      .notNull()
      .references(() => OrgTable.id, { onDelete: "cascade" }),
    scope: text().$type<BudgetScope>().notNull(),
    target: text().notNull().default(""),
    period: text().$type<"day" | "month">().notNull(),
    amount: doublePrecision().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.org, table.scope, table.target, table.period] }),
    check("budgets_scope", sql`${table.scope} in ('org', 'member', 'user', 'group', 'suborg')`),
    check("budgets_period", sql`${table.period} in ('day', 'month')`),
  ],
)

// Upstream providers the LLM gateway relays to, with the org's API key for each.
export const GatewayProviderTable = pgTable(
  "gateway_providers",
  {
    org: text()
      .notNull()
      .references(() => OrgTable.id, { onDelete: "cascade" }),
    // The client provider id, which is also the gateway path segment.
    id: text().notNull(),
    kind: text().$type<GatewayKind>().notNull(),
    base: text().notNull(),
    // How the gateway signs in upstream; null for what the kind expects (protocol defaultAuth).
    auth: jsonb().$type<GatewayAuth>(),
    // Sealed with ORGANIZATION_SECRET (AES-256-GCM); never stored in clear text. The API key, the
    // AWS secret access key or the service account's JSON key, as `auth` says; empty for none.
    secret: text().notNull(),
    hint: text().notNull(),
    // Extra upstream headers: values sealed as JSON, names in clear for admins.
    headers: text(),
    names: jsonb().$type<string[]>().notNull().default([]),
    query: jsonb().$type<Record<string, string>>().notNull().default({}),
    // What clients show for a provider they don't know.
    name: text(),
    models: jsonb().$type<GatewayModel[]>().notNull().default([]),
    created: bigint({ mode: "number" }).notNull(),
    updated: bigint({ mode: "number" }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.org, table.id] }),
    check(
      "gateway_providers_kind",
      sql`${table.kind} in ('anthropic', 'openai', 'openai-compatible', 'bedrock', 'vertex')`,
    ),
  ],
)

// Calls through the gateway in the current minute, per member, so rate limits hold across replicas.
// Rows from earlier minutes are swept.
export const GatewayWindowTable = pgTable(
  "gateway_windows",
  {
    org: text()
      .notNull()
      .references(() => OrgTable.id, { onDelete: "cascade" }),
    user: text()
      .notNull()
      .references(() => UserTable.id, { onDelete: "cascade" }),
    // The window's first millisecond.
    start: bigint({ mode: "number" }).notNull(),
    requests: integer().notNull().default(0),
    tokens: bigint({ mode: "number" }).notNull().default(0),
  },
  (table) => [primaryKey({ columns: [table.org, table.user, table.start] })],
)

// Every call through the gateway, refused or relayed, kept for the policy's retention.
export const GatewayCallTable = pgTable(
  "gateway_calls",
  {
    id: bigint({ mode: "number" }).primaryKey().generatedByDefaultAsIdentity(),
    org: text()
      .notNull()
      .references(() => OrgTable.id, { onDelete: "cascade" }),
    user: text().references(() => UserTable.id, { onDelete: "set null" }),
    at: bigint({ mode: "number" }).notNull(),
    provider: text().notNull(),
    model: text(),
    method: text().notNull(),
    path: text().notNull(),
    status: integer().notNull(),
    code: text(),
    latency: integer().notNull().default(0),
    input: bigint({ mode: "number" }).notNull().default(0),
    output: bigint({ mode: "number" }).notNull().default(0),
    reasoning: bigint({ mode: "number" }).notNull().default(0),
    cache_read: bigint({ mode: "number" }).notNull().default(0),
    cache_write: bigint({ mode: "number" }).notNull().default(0),
    cost: doublePrecision().notNull().default(0),
    session: text(),
    project: text(),
    ip: text(),
    // Kept only while the policy's gateway.log.bodies is on, and cut to a fixed size.
    request: text(),
    response: text(),
  },
  (table) => [index("gateway_calls_org_at").on(table.org, table.at)],
)

// The organization's own rates for a provider's models; model "*" covers all of them.
export const PriceTable = pgTable(
  "prices",
  {
    org: text()
      .notNull()
      .references(() => OrgTable.id, { onDelete: "cascade" }),
    provider: text().notNull(),
    model: text().notNull(),
    rates: jsonb().$type<Rates>(),
    // Percent off the catalog's rates.
    discount: doublePrecision(),
  },
  (table) => [primaryKey({ columns: [table.org, table.provider, table.model] })],
)

// Destinations that receive every new audit event (SIEM webhooks, syslog), with delivery state.
export const StreamTable = pgTable(
  "audit_streams",
  {
    id: text().primaryKey(),
    org: text()
      .notNull()
      .references(() => OrgTable.id, { onDelete: "cascade" }),
    name: text().notNull(),
    target: jsonb().$type<StreamTarget>().notNull(),
    // Sealed with ORGANIZATION_SECRET: a webhook's signing secret, and its extra headers as JSON.
    secret: text(),
    headers: text(),
    names: jsonb().$type<string[]>().notNull().default([]),
    enabled: boolean().notNull().default(true),
    // The id of the last audit event delivered; delivery resumes after it.
    cursor: bigint({ mode: "number" }).notNull().default(0),
    delivered: bigint({ mode: "number" }),
    error: text(),
    // When the current run of failures began, how long it is, and when to try again.
    failing: bigint({ mode: "number" }),
    failures: integer().notNull().default(0),
    retry: bigint({ mode: "number" }),
    // A delivery in progress holds the stream until this time, so replicas never send the same events.
    lease: bigint({ mode: "number" }),
    created: bigint({ mode: "number" }).notNull(),
    updated: bigint({ mode: "number" }).notNull(),
  },
  (table) => [index("audit_streams_org").on(table.org)],
)
