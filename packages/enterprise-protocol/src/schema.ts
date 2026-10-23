import { Effect, Schema } from "effect"

// Domain schemas for the enterprise control plane. The server validates with them, the CLI and
// the admin console decode with them, so the three can never disagree about a shape.

const Text = Schema.String.check(Schema.isMinLength(1))
const Count = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))
const Whole = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const Time = Schema.Finite
const list = <S extends Schema.Top>(item: S) => Schema.Array(item).pipe(Schema.withDecodingDefault(Effect.succeed([])))

// ---- roles and organizations --------------------------------------------------------------

export const Role = Schema.Literals(["owner", "admin", "member", "billing_manager"])
export type Role = typeof Role.Type

export const Slug = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{1,62}$/))

export const Org = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  slug: Schema.String,
  parent: Schema.NullOr(Schema.String),
  settings: Schema.Record(Schema.String, Schema.Unknown),
  created: Time,
})
export type Org = typeof Org.Type

export const OrgAccess = Schema.Struct({
  id: Schema.String,
  slug: Schema.String,
  name: Schema.String,
  parent: Schema.NullOr(Schema.String),
  role: Role,
  inherited: Schema.Boolean,
})

export const Person = Schema.Struct({ id: Schema.String, email: Schema.String, name: Schema.NullOr(Schema.String) })

export const Me = Schema.Struct({ user: Person, orgs: Schema.Array(OrgAccess) })

export const Token = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literals(["user", "scim"]),
  user: Schema.NullOr(Schema.String),
  org: Schema.String,
  name: Schema.String,
  created: Time,
  expires: Schema.NullOr(Time),
  used: Schema.NullOr(Time),
  revoked: Schema.NullOr(Time),
})

// A secret shown exactly once, at creation.
export const Issued = Schema.Struct({ id: Schema.String, token: Schema.String })

export const Member = Schema.Struct({
  id: Schema.String,
  email: Schema.String,
  name: Schema.NullOr(Schema.String),
  role: Role,
  active: Schema.Boolean,
  joined: Time,
  groups: Schema.Array(Schema.String),
})

export const Invite = Schema.Struct({
  id: Schema.String,
  email: Schema.String,
  role: Role,
  created: Time,
  expires: Time,
})

export const InviteCreated = Schema.Struct({
  id: Schema.String,
  // Bearer secret: deliver it to the invitee privately. With SSO, signing in consumes the invite instead.
  token: Schema.String,
  accept: Schema.String,
  sso: Schema.NullOr(Schema.String),
})

export const Signin = Schema.Struct({
  token: Schema.String,
  user: Person,
  org: Schema.Struct({ id: Schema.String, slug: Schema.String, name: Schema.String }),
})

// ---- model access, MCP and permissions ----------------------------------------------------

// Model access policy for a set of members: everything, an explicit selection, or nothing.
export const ModelAccess = Schema.Struct({
  mode: Schema.Literals(["all", "selected", "none"]),
  items: list(Text),
})
export type ModelAccess = typeof ModelAccess.Type

export const Action = Schema.Literals(["allow", "ask", "deny"])

// Same shape as the CLI `permission` config: one action, or patterns mapped to actions.
export const Permission = Schema.Record(Schema.String, Schema.Union([Action, Schema.Record(Schema.String, Action)]))
export type Permission = typeof Permission.Type

const rest = [Schema.Record(Schema.String, Schema.Unknown)] as const

// Same shape as CLI `mcp` config entries, so org servers can be pushed to clients verbatim.
export const LocalServer = Schema.StructWithRest(
  Schema.Struct({
    type: Schema.Literal("local"),
    command: Schema.Array(Schema.String).check(Schema.isMinLength(1)),
    environment: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  }),
  rest,
)
export const RemoteServer = Schema.StructWithRest(
  Schema.Struct({
    type: Schema.Literal("remote"),
    url: Schema.String.check(Schema.isPattern(/^https?:\/\/\S+$/)),
    headers: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  }),
  rest,
)
export const Server = Schema.Union([LocalServer, RemoteServer])
export type Server = typeof Server.Type

export const Policy = Schema.Struct({
  models: Schema.Struct({
    // Org-wide ceiling. A bare provider id ("openai") blocks all of its models; anything with a
    // slash is a glob over "provider/model" ("openrouter/*:free", "kilo/anthropic/claude-opus-*").
    blocked: list(Text),
    // Applies to every member before group grants are unioned in. Unset means no restriction.
    default: Schema.optional(ModelAccess),
  }).pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  mcp: Schema.Struct({
    // "open": any server not blocked may run. "allowlist": only servers matching `allow` may run.
    mode: Schema.Literals(["open", "allowlist"]).pipe(Schema.withDecodingDefault(Effect.succeed("open" as const))),
    // Globs over the server target: the URL of a remote server, the command line of a local one.
    // Server names are chosen by users and are never trusted for matching.
    allow: list(Text),
    block: list(Text),
    // Org-provided servers pushed into every client's config.
    servers: Schema.Record(Schema.String, Server).pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  }).pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  // Deny rules are enforced as hard rules on clients; allow/ask rules become defaults users can tighten.
  permission: Permission.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  // Org-wide rules appended to the agent system prompt.
  instructions: Schema.optional(Schema.String.check(Schema.isMaxLength(50_000))),
  // Session sharing and syncing sessions to the upstream vendor's cloud. Off unless an org opts in.
  share: Schema.Literals(["allowed", "disabled"]).pipe(Schema.withDecodingDefault(Effect.succeed("disabled" as const))),
  telemetry: Schema.Struct({
    // Product analytics sent to the upstream vendor. Off unless an org opts in.
    product: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  }).pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  gateway: Schema.Struct({
    // Only providers routed through the gateway may be used; clients refuse every other provider.
    exclusive: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  }).pipe(Schema.withDecodingDefault(Effect.succeed({}))),
})
export type Policy = typeof Policy.Type

export const PolicyState = Schema.Struct({ policy: Policy, version: Count, updated: Schema.NullOr(Time) })

export const AgentMode = Schema.Literals(["primary", "subagent", "all"])

// Org custom modes, delivered to clients as locked agents.
export const Mode = Schema.Struct({
  slug: Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]*$/), Schema.isMaxLength(64)),
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  description: Schema.String.check(Schema.isMaxLength(2000)).pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  prompt: Schema.String.check(Schema.isMaxLength(50_000)),
  model: Schema.optional(Schema.String),
  mode: AgentMode.pipe(Schema.withDecodingDefault(Effect.succeed("primary" as const))),
  permission: Schema.optional(Permission),
})
export type Mode = typeof Mode.Type

export const StoredMode = Schema.Struct({ ...Mode.fields, id: Schema.String, created: Time, updated: Time })

export const Agent = Schema.Struct({
  description: Schema.String,
  prompt: Schema.String,
  mode: AgentMode,
  model: Schema.optional(Schema.String),
  permission: Schema.optional(Permission),
})

export const Group = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  external: Schema.NullOr(Schema.String),
  models: Schema.NullOr(ModelAccess),
  members: Schema.Array(Person),
  created: Time,
})

export const GroupName = Schema.Struct({ id: Schema.String, name: Schema.String })

// ---- budgets, usage, audit ----------------------------------------------------------------

export const BudgetScope = Schema.Literals(["org", "member", "user"])
export const Period = Schema.Literals(["day", "month"])

export const Budget = Schema.Struct({
  scope: BudgetScope,
  target: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  period: Period,
  amount: Count.check(Schema.isLessThanOrEqualTo(10_000_000)),
})

export const BudgetStatus = Schema.Struct({ scope: BudgetScope, period: Period, amount: Count, spent: Count })
export type BudgetStatus = typeof BudgetStatus.Type

export const UsageRecord = Schema.Struct({
  id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  at: Whole,
  session: Schema.optional(Schema.String.check(Schema.isMaxLength(200))),
  project: Schema.optional(Schema.String.check(Schema.isMaxLength(500))),
  provider: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  model: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300)),
  tokens: Schema.Struct({
    input: Whole.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
    output: Whole.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
    reasoning: Whole.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
    cache: Schema.Struct({
      read: Whole.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
      write: Whole.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
    }).pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  }).pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  cost: Count.check(Schema.isLessThanOrEqualTo(1_000_000)).pipe(Schema.withDecodingDefault(Effect.succeed(0))),
})
export type UsageRecord = typeof UsageRecord.Type

// "source" separates usage the gateway metered from usage that clients reported.
export const UsageBy = Schema.Literals(["user", "model", "provider", "day", "project", "source"])
export type UsageBy = typeof UsageBy.Type

export const UsageRow = Schema.Struct({
  key: Schema.String,
  requests: Count,
  users: Count,
  input: Count,
  output: Count,
  reasoning: Count,
  cache_read: Count,
  cache_write: Count,
  cost: Count,
})

export const UsageSummary = Schema.Struct({ by: UsageBy, from: Time, to: Time, rows: Schema.Array(UsageRow) })

export const AuditEvent = Schema.Struct({
  id: Schema.Finite,
  org: Schema.String,
  at: Time,
  action: Schema.String,
  actor: Schema.NullOr(Schema.String),
  email: Schema.NullOr(Schema.String),
  target: Schema.NullOr(Schema.String),
  details: Schema.Unknown,
  ip: Schema.NullOr(Schema.String),
})

export const AuditPage = Schema.Struct({ events: Schema.Array(AuditEvent), next: Schema.NullOr(Schema.Finite) })

// Destinations that receive every new audit event: a SIEM's HTTPS collector, or a syslog server.
export const StreamKind = Schema.Literals(["webhook", "syslog"])
export type StreamKind = typeof StreamKind.Type

// Header names a webhook may set itself (an authorization header for the collector, say); the
// signature and delivery headers are always the server's.
const HeaderName = Schema.String.check(
  Schema.isPattern(/^(?!x-enterprise-)[a-z0-9][a-z0-9-]{0,63}$/i, { message: "must be a header name" }),
)

// A DNS name, an IPv4 address or a bare IPv6 address.
const Host = Schema.String.check(
  Schema.isMaxLength(253),
  Schema.isPattern(/^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*|[0-9a-f:]+)$/i, {
    message: "must be a host name or IP address",
  }),
)

export const StreamTarget = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("webhook"),
    url: Schema.String.check(Schema.isPattern(/^https?:\/\/\S+$/, { message: "must be an http(s) URL" })),
  }),
  Schema.Struct({
    kind: Schema.Literal("syslog"),
    host: Host,
    port: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 })),
    tls: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  }),
])
export type StreamTarget = typeof StreamTarget.Type

export const AuditStream = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  target: StreamTarget,
  // Names of the extra headers a webhook sends; their values are write-only.
  headers: Schema.Array(Schema.String),
  enabled: Schema.Boolean,
  // Events not yet delivered.
  pending: Count,
  delivered: Schema.NullOr(Time),
  error: Schema.NullOr(Schema.String),
  failing: Schema.NullOr(Time),
  created: Time,
})

export const AuditStreamInput = Schema.Struct({
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
  target: StreamTarget,
  headers: Schema.optional(Schema.Record(HeaderName, Schema.String.check(Schema.isMaxLength(4096)))),
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
})

export const AuditStreamPatch = Schema.Struct({
  name: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100))),
  target: Schema.optional(StreamTarget),
  // Replaces every extra header; omit to keep them.
  headers: Schema.optional(Schema.Record(HeaderName, Schema.String.check(Schema.isMaxLength(4096)))),
  enabled: Schema.optional(Schema.Boolean),
})

// A new webhook's signing secret, shown once. Receivers check each delivery with it.
export const AuditStreamCreated = Schema.Struct({ stream: AuditStream, secret: Schema.NullOr(Schema.String) })

export const StreamTest = Schema.Struct({ ok: Schema.Boolean, error: Schema.NullOr(Schema.String) })

// Accepts epoch milliseconds or anything Date.parse understands (ISO dates).
export const Instant = Schema.String.check(
  Schema.makeFilter((value) => /^\d+$/.test(value) || !Number.isNaN(Date.parse(value)), {
    title: "epoch milliseconds or an ISO date",
  }),
)

export function instant(value: string | undefined, fallback: number) {
  if (!value) return fallback
  return /^\d+$/.test(value) ? Number(value) : Date.parse(value)
}

// ---- identity: SSO, domains, SCIM tokens --------------------------------------------------

export const Sso = Schema.Struct({
  configured: Schema.Boolean,
  issuer: Schema.NullOr(Schema.String),
  client_id: Schema.NullOr(Schema.String),
  scopes: Schema.NullOr(Schema.String),
  enforce: Schema.Boolean,
  provision: Schema.NullOr(Schema.Boolean),
  redirect_uri: Schema.String,
  login_url: Schema.String,
})

export const SsoInput = Schema.Struct({
  issuer: Schema.String.check(Schema.isPattern(/^https?:\/\/\S+$/)),
  client_id: Text,
  client_secret: Schema.optional(Text),
  scopes: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed("openid email profile"))),
  enforce: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  provision: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
})

export const Hostname = Schema.String.check(
  Schema.isPattern(/^(?=.{1,253}$)([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,63}$/, {
    message: "must be a domain name like example.com",
  }),
)

export const Domain = Schema.Struct({
  name: Schema.String,
  verified: Schema.NullOr(Time),
  record: Schema.Struct({ type: Schema.Literal("TXT"), name: Schema.String, value: Schema.String }),
})

export const ScimToken = Schema.Struct({ id: Schema.String, token: Schema.String, base: Schema.String })

export const Suborg = Schema.Struct({ ...Org.fields, members: Count, spent: Count })

// ---- LLM gateway --------------------------------------------------------------------------

// The API an upstream speaks. It decides which endpoints the gateway forwards and how it reads
// token usage from responses.
export const GatewayKind = Schema.Literals(["anthropic", "openai", "openai-compatible"])
export type GatewayKind = typeof GatewayKind.Type

// A client provider id ("anthropic", "openrouter"): clients send that provider's requests here.
export const ProviderID = Schema.String.check(
  Schema.isPattern(/^[a-z0-9][a-z0-9._-]{0,63}$/, { message: "must be a provider id like anthropic or openrouter" }),
)

export const GatewayProvider = Schema.Struct({
  id: Schema.String,
  kind: GatewayKind,
  // Upstream base URL, including the API version path (https://api.anthropic.com/v1).
  base: Schema.String,
  // The key's last characters, so admins can tell keys apart. The key itself is write-only.
  hint: Schema.String,
  created: Time,
  updated: Time,
})

export const GatewayProviderInput = Schema.Struct({
  kind: GatewayKind,
  base: Schema.String.check(Schema.isPattern(/^https?:\/\/[^\s?#]+$/, { message: "must be an http(s) URL" })),
  // Required for a new provider; omit it to keep the current key.
  key: Schema.optional(Text.check(Schema.isMaxLength(4096))),
})

export const Gateway = Schema.Struct({
  // Clients reach provider `id` at `${url}/${id}`.
  url: Schema.String,
  providers: Schema.Array(GatewayProvider),
})

// What a client needs to route a provider through the gateway.
export const GatewayRoute = Schema.Struct({ id: Schema.String, kind: GatewayKind })

// ---- device login (RFC 8628) --------------------------------------------------------------

export const DeviceStart = Schema.Struct({
  device_code: Schema.String,
  user_code: Schema.String,
  verification_uri: Schema.String,
  verification_uri_complete: Schema.String,
  expires_in: Count,
  interval: Count,
})

export const DeviceGrant = Schema.Struct({
  access_token: Schema.String,
  token_type: Schema.Literal("Bearer"),
  expires_in: Count,
  user: Person,
  org: Schema.Struct({ id: Schema.String, slug: Schema.String, name: Schema.String }),
})

// ---- the effective policy a client enforces -----------------------------------------------

export const Effective = Schema.Struct({
  org: Schema.Struct({ id: Schema.String, slug: Schema.String, name: Schema.String }),
  user: Schema.Struct({ id: Schema.String, email: Schema.String, role: Role }),
  ttl: Count,
  version: Count,
  groups: Schema.Array(Schema.String),
  models: Schema.Struct({ allow: Schema.NullOr(Schema.Array(Schema.String)), deny: Schema.Array(Schema.String) }),
  mcp: Schema.Struct({
    allow: Schema.NullOr(Schema.Array(Schema.String)),
    deny: Schema.Array(Schema.String),
    servers: Schema.Record(Schema.String, Server),
  }),
  permission: Permission,
  instructions: Schema.NullOr(Schema.String),
  agents: Schema.Record(Schema.String, Agent),
  share: Schema.Literals(["allowed", "disabled"]),
  telemetry: Schema.Struct({ product: Schema.Boolean }),
  budget: Schema.Struct({ exceeded: Schema.Boolean, limits: Schema.Array(BudgetStatus) }),
  // Providers whose requests go through the control plane, which holds their keys and meters
  // usage itself. Defaults keep policies cached by older clients decodable.
  gateway: Schema.Struct({
    exclusive: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
    providers: list(GatewayRoute),
  }).pipe(Schema.withDecodingDefault(Effect.succeed({}))),
})
export type Effective = typeof Effective.Type
