import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/unstable/httpapi"
import { ConflictError, ForbiddenError, InvalidRequestError, NotFoundError } from "../errors"
import { Authorization, OrgScope } from "../middleware"
import { Requires } from "../roles"
import {
  AuditPage,
  AuditStream,
  AuditStreamCreated,
  AuditStreamInput,
  AuditStreamPatch,
  Budget,
  Domain,
  Effective,
  Gateway,
  GatewayProvider,
  GatewayProviderInput,
  Group,
  GroupName,
  Hostname,
  Instant,
  Invite,
  InviteCreated,
  Issued,
  Member,
  Mode,
  ModelAccess,
  Org,
  Policy,
  PolicyState,
  ProviderID,
  Role,
  ScimToken,
  Slug,
  Sso,
  SsoInput,
  SamlInput,
  StoredMode,
  StreamTest,
  Suborg,
  Token,
  UsageBy,
  UsageRecord,
  UsageSummary,
} from "../schema"

// Everything under /api/v1/orgs/:org. Authorization runs first (outermost), then OrgScope resolves
// the org against the caller's token and membership and checks the endpoint's `Requires` capability.
// Endpoints without one are open to every member and scope what they return by role.

const failures = [ForbiddenError, NotFoundError, ConflictError, InvalidRequestError]
const org = { org: Schema.String }
const csv = Schema.String.pipe(HttpApiSchema.asText({ contentType: "text/csv" }))
const Email = Schema.String.check(
  Schema.isPattern(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, { message: "must be an email address" }),
)
const Name = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200))
const Days = (max: number) => Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: max }))

export const OrgGroup = HttpApiGroup.make("organization.org")
  .add(
    HttpApiEndpoint.get("org.get", "/api/v1/orgs/:org", {
      params: org,
      success: Schema.Struct({ org: Org, role: Role, inherited: Schema.Boolean }),
    }),
  )
  .add(
    HttpApiEndpoint.patch("org.update", "/api/v1/orgs/:org", {
      params: org,
      payload: Schema.Struct({
        name: Schema.optional(Name),
        settings: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
      }),
      success: Schema.Struct({ org: Org }),
      error: failures,
    }).annotate(Requires, "org.write"),
  )
  .add(
    HttpApiEndpoint.get("suborgs.list", "/api/v1/orgs/:org/suborgs", {
      params: org,
      success: Schema.Struct({ suborgs: Schema.Array(Suborg) }),
      error: failures,
    }).annotate(Requires, "suborg.read"),
  )
  .add(
    HttpApiEndpoint.post("suborgs.create", "/api/v1/orgs/:org/suborgs", {
      params: org,
      payload: Schema.Struct({ name: Name, slug: Slug }),
      success: Schema.Struct({ org: Org }).pipe(HttpApiSchema.status(201)),
      error: failures,
    }).annotate(Requires, "suborg.write"),
  )
  .middleware(OrgScope)
  .middleware(Authorization)

export const PeopleGroup = HttpApiGroup.make("organization.people")
  .add(
    HttpApiEndpoint.get("members.list", "/api/v1/orgs/:org/members", {
      params: org,
      success: Schema.Struct({ members: Schema.Array(Member) }),
      error: failures,
    }).annotate(Requires, "member.read"),
  )
  .add(
    HttpApiEndpoint.post("members.add", "/api/v1/orgs/:org/members", {
      params: org,
      payload: Schema.Struct({
        email: Email,
        name: Schema.optional(Schema.String.check(Schema.isMaxLength(200))),
        role: Role.pipe(Schema.optional),
      }),
      success: Schema.Struct({ id: Schema.String, email: Schema.String, role: Role }).pipe(HttpApiSchema.status(201)),
      error: failures,
    }).annotate(Requires, "member.write"),
  )
  .add(
    HttpApiEndpoint.patch("members.update", "/api/v1/orgs/:org/members/:user", {
      params: { ...org, user: Schema.String },
      payload: Schema.Struct({ role: Role }),
      success: Schema.Struct({ id: Schema.String, role: Role }),
      error: failures,
    }).annotate(Requires, "member.write"),
  )
  .add(
    HttpApiEndpoint.delete("members.remove", "/api/v1/orgs/:org/members/:user", {
      params: { ...org, user: Schema.String },
      success: HttpApiSchema.NoContent,
      error: failures,
    }).annotate(Requires, "member.write"),
  )
  // For orgs without SSO: an admin issues a CLI/IDE token for a member and hands it over out of band.
  .add(
    HttpApiEndpoint.post("members.token", "/api/v1/orgs/:org/members/:user/tokens", {
      params: { ...org, user: Schema.String },
      payload: Schema.Struct({
        name: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100))),
        days: Schema.optional(Days(365)),
      }),
      success: Issued.pipe(HttpApiSchema.status(201)),
      error: failures,
    }).annotate(Requires, "token.write"),
  )
  .add(
    HttpApiEndpoint.get("invites.list", "/api/v1/orgs/:org/invites", {
      params: org,
      success: Schema.Struct({ invites: Schema.Array(Invite) }),
      error: failures,
    }).annotate(Requires, "invite.write"),
  )
  .add(
    HttpApiEndpoint.post("invites.create", "/api/v1/orgs/:org/invites", {
      params: org,
      payload: Schema.Struct({ email: Email, role: Role.pipe(Schema.optional), days: Schema.optional(Days(30)) }),
      success: InviteCreated.pipe(HttpApiSchema.status(201)),
      error: failures,
    }).annotate(Requires, "invite.write"),
  )
  .add(
    HttpApiEndpoint.delete("invites.revoke", "/api/v1/orgs/:org/invites/:id", {
      params: { ...org, id: Schema.String },
      success: HttpApiSchema.NoContent,
      error: failures,
    }).annotate(Requires, "invite.write"),
  )
  .add(
    HttpApiEndpoint.get("groups.list", "/api/v1/orgs/:org/groups", {
      params: org,
      success: Schema.Struct({ groups: Schema.Array(Group) }),
      error: failures,
    }).annotate(Requires, "group.read"),
  )
  // Members may only learn the names of the groups they belong to.
  .add(
    HttpApiEndpoint.get("groups.mine", "/api/v1/orgs/:org/groups/mine", {
      params: org,
      success: Schema.Struct({ groups: Schema.Array(GroupName) }),
    }),
  )
  .add(
    HttpApiEndpoint.get("groups.get", "/api/v1/orgs/:org/groups/:id", {
      params: { ...org, id: Schema.String },
      success: Group,
      error: failures,
    }).annotate(Requires, "group.read"),
  )
  .add(
    HttpApiEndpoint.post("groups.create", "/api/v1/orgs/:org/groups", {
      params: org,
      payload: Schema.Struct({ name: Name, models: Schema.optional(Schema.NullOr(ModelAccess)) }),
      success: Group.pipe(HttpApiSchema.status(201)),
      error: failures,
    }).annotate(Requires, "group.write"),
  )
  .add(
    HttpApiEndpoint.patch("groups.update", "/api/v1/orgs/:org/groups/:id", {
      params: { ...org, id: Schema.String },
      payload: Schema.Struct({ name: Schema.optional(Name), models: Schema.optional(Schema.NullOr(ModelAccess)) }),
      success: Group,
      error: failures,
    }).annotate(Requires, "group.write"),
  )
  .add(
    HttpApiEndpoint.put("groups.members", "/api/v1/orgs/:org/groups/:id/members", {
      params: { ...org, id: Schema.String },
      payload: Schema.Struct({ users: Schema.Array(Schema.String).check(Schema.isMaxLength(10_000)) }),
      success: Group,
      error: failures,
    }).annotate(Requires, "group.write"),
  )
  .add(
    HttpApiEndpoint.delete("groups.remove", "/api/v1/orgs/:org/groups/:id", {
      params: { ...org, id: Schema.String },
      success: HttpApiSchema.NoContent,
      error: failures,
    }).annotate(Requires, "group.write"),
  )
  .middleware(OrgScope)
  .middleware(Authorization)

export const GovernanceGroup = HttpApiGroup.make("organization.governance")
  .add(
    HttpApiEndpoint.get("policy.get", "/api/v1/orgs/:org/policy", {
      params: org,
      success: PolicyState,
      error: failures,
    }).annotate(Requires, "policy.read"),
  )
  .add(
    HttpApiEndpoint.put("policy.update", "/api/v1/orgs/:org/policy", {
      params: org,
      payload: Policy,
      success: PolicyState,
      error: failures,
    }).annotate(Requires, "policy.write"),
  )
  // What a client enforces for the calling user. Clients poll it and send back the etag, which
  // turns an unchanged policy into an empty 304.
  .add(
    HttpApiEndpoint.get("policy.effective", "/api/v1/orgs/:org/policy/effective", {
      params: org,
      headers: { "if-none-match": Schema.optional(Schema.String) },
      success: [Schema.Struct({ ...Effective.fields, etag: Schema.String }), HttpApiSchema.Empty(304)],
    }),
  )
  .add(
    HttpApiEndpoint.get("modes.list", "/api/v1/orgs/:org/modes", {
      params: org,
      success: Schema.Struct({ modes: Schema.Array(StoredMode) }),
      error: failures,
    }).annotate(Requires, "mode.read"),
  )
  .add(
    HttpApiEndpoint.post("modes.create", "/api/v1/orgs/:org/modes", {
      params: org,
      payload: Mode,
      success: StoredMode.pipe(HttpApiSchema.status(201)),
      error: failures,
    }).annotate(Requires, "mode.write"),
  )
  .add(
    HttpApiEndpoint.put("modes.update", "/api/v1/orgs/:org/modes/:id", {
      params: { ...org, id: Schema.String },
      payload: Mode,
      success: StoredMode,
      error: failures,
    }).annotate(Requires, "mode.write"),
  )
  .add(
    HttpApiEndpoint.delete("modes.remove", "/api/v1/orgs/:org/modes/:id", {
      params: { ...org, id: Schema.String },
      success: HttpApiSchema.NoContent,
      error: failures,
    }).annotate(Requires, "mode.write"),
  )
  .add(
    HttpApiEndpoint.get("budgets.get", "/api/v1/orgs/:org/budgets", {
      params: org,
      success: Schema.Struct({ budgets: Schema.Array(Budget) }),
      error: failures,
    }).annotate(Requires, "usage.read"),
  )
  .add(
    HttpApiEndpoint.put("budgets.update", "/api/v1/orgs/:org/budgets", {
      params: org,
      payload: Schema.Struct({ budgets: Schema.Array(Budget).check(Schema.isMaxLength(10_000)) }),
      success: Schema.Struct({ budgets: Schema.Array(Budget) }),
      error: failures,
    }).annotate(Requires, "budget.write"),
  )
  .middleware(OrgScope)
  .middleware(Authorization)

const Window = {
  from: Schema.optional(Instant),
  to: Schema.optional(Instant),
}

export const InsightGroup = HttpApiGroup.make("organization.insight")
  .add(
    HttpApiEndpoint.get("audit.list", "/api/v1/orgs/:org/audit", {
      params: org,
      query: {
        action: Schema.optional(Schema.String),
        actor: Schema.optional(Schema.String),
        before: Schema.optional(Schema.NumberFromString),
        limit: Schema.optional(Schema.NumberFromString),
        ...Window,
      },
      success: AuditPage,
      error: failures,
    }).annotate(Requires, "audit.read"),
  )
  .add(
    HttpApiEndpoint.get("audit.export", "/api/v1/orgs/:org/audit/export", {
      params: org,
      query: { action: Schema.optional(Schema.String), actor: Schema.optional(Schema.String), ...Window },
      success: csv,
      error: failures,
    }).annotate(Requires, "audit.read"),
  )
  .add(
    HttpApiEndpoint.get("streams.list", "/api/v1/orgs/:org/audit/streams", {
      params: org,
      success: Schema.Struct({ streams: Schema.Array(AuditStream) }),
      error: failures,
    }).annotate(Requires, "audit.read"),
  )
  .add(
    HttpApiEndpoint.post("streams.create", "/api/v1/orgs/:org/audit/streams", {
      params: org,
      payload: AuditStreamInput,
      success: AuditStreamCreated.pipe(HttpApiSchema.status(201)),
      error: failures,
    }).annotate(Requires, "audit.stream"),
  )
  .add(
    HttpApiEndpoint.patch("streams.update", "/api/v1/orgs/:org/audit/streams/:id", {
      params: { ...org, id: Schema.String },
      payload: AuditStreamPatch,
      success: AuditStream,
      error: failures,
    }).annotate(Requires, "audit.stream"),
  )
  .add(
    HttpApiEndpoint.delete("streams.remove", "/api/v1/orgs/:org/audit/streams/:id", {
      params: { ...org, id: Schema.String },
      success: HttpApiSchema.NoContent,
      error: failures,
    }).annotate(Requires, "audit.stream"),
  )
  // Sends one test event now and reports how the destination answered.
  .add(
    HttpApiEndpoint.post("streams.test", "/api/v1/orgs/:org/audit/streams/:id/test", {
      params: { ...org, id: Schema.String },
      success: StreamTest,
      error: failures,
    }).annotate(Requires, "audit.stream"),
  )
  .add(
    HttpApiEndpoint.post("usage.ingest", "/api/v1/orgs/:org/usage", {
      params: org,
      payload: Schema.Struct({ records: Schema.Array(UsageRecord).check(Schema.isMaxLength(1000)) }),
      success: Schema.Struct({ accepted: Schema.Finite }),
      error: failures,
    }),
  )
  .add(
    HttpApiEndpoint.get("usage.summary", "/api/v1/orgs/:org/usage", {
      params: org,
      query: { by: Schema.optional(UsageBy), user: Schema.optional(Schema.String), ...Window },
      success: UsageSummary,
      error: failures,
    }),
  )
  .add(
    HttpApiEndpoint.get("usage.export", "/api/v1/orgs/:org/usage/export", {
      params: org,
      query: Window,
      success: csv,
      error: failures,
    }).annotate(Requires, "usage.read"),
  )
  .middleware(OrgScope)
  .middleware(Authorization)

export const IdentityGroup = HttpApiGroup.make("organization.identity")
  .add(
    HttpApiEndpoint.get("sso.get", "/api/v1/orgs/:org/sso", { params: org, success: Sso, error: failures }).annotate(
      Requires,
      "sso.write",
    ),
  )
  .add(
    HttpApiEndpoint.put("sso.update", "/api/v1/orgs/:org/sso", {
      params: org,
      payload: SsoInput,
      success: Schema.Struct({ ok: Schema.Literal(true) }),
      error: failures,
    }).annotate(Requires, "sso.write"),
  )
  .add(
    HttpApiEndpoint.put("sso.saml", "/api/v1/orgs/:org/sso/saml", {
      params: org,
      payload: SamlInput,
      success: Schema.Struct({ ok: Schema.Literal(true) }),
      error: failures,
    }).annotate(Requires, "sso.write"),
  )
  .add(
    HttpApiEndpoint.delete("sso.remove", "/api/v1/orgs/:org/sso", {
      params: org,
      success: HttpApiSchema.NoContent,
      error: failures,
    }).annotate(Requires, "sso.write"),
  )
  .add(
    HttpApiEndpoint.get("domains.list", "/api/v1/orgs/:org/domains", {
      params: org,
      success: Schema.Struct({ domains: Schema.Array(Domain) }),
      error: failures,
    }).annotate(Requires, "domain.write"),
  )
  .add(
    HttpApiEndpoint.post("domains.create", "/api/v1/orgs/:org/domains", {
      params: org,
      payload: Schema.Struct({ domain: Hostname }),
      success: Domain.pipe(HttpApiSchema.status(201)),
      error: failures,
    }).annotate(Requires, "domain.write"),
  )
  .add(
    HttpApiEndpoint.post("domains.verify", "/api/v1/orgs/:org/domains/:name/verify", {
      params: { ...org, name: Schema.String },
      success: Schema.Struct({ name: Schema.String, verified: Schema.Finite }),
      error: failures,
    }).annotate(Requires, "domain.write"),
  )
  .add(
    HttpApiEndpoint.delete("domains.remove", "/api/v1/orgs/:org/domains/:name", {
      params: { ...org, name: Schema.String },
      success: HttpApiSchema.NoContent,
      error: failures,
    }).annotate(Requires, "domain.write"),
  )
  .add(
    HttpApiEndpoint.get("scimTokens.list", "/api/v1/orgs/:org/scim/tokens", {
      params: org,
      success: Schema.Struct({ tokens: Schema.Array(Token) }),
      error: failures,
    }).annotate(Requires, "scim.write"),
  )
  .add(
    HttpApiEndpoint.post("scimTokens.create", "/api/v1/orgs/:org/scim/tokens", {
      params: org,
      payload: Schema.Struct({
        name: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100))),
      }),
      success: ScimToken.pipe(HttpApiSchema.status(201)),
      error: failures,
    }).annotate(Requires, "scim.write"),
  )
  .add(
    HttpApiEndpoint.delete("scimTokens.revoke", "/api/v1/orgs/:org/scim/tokens/:id", {
      params: { ...org, id: Schema.String },
      success: HttpApiSchema.NoContent,
      error: failures,
    }).annotate(Requires, "scim.write"),
  )
  .middleware(OrgScope)
  .middleware(Authorization)

// The org's upstream providers for the LLM gateway. Keys are write-only; responses carry a hint.
export const GatewayGroup = HttpApiGroup.make("organization.gateway")
  .add(
    HttpApiEndpoint.get("gateway.get", "/api/v1/orgs/:org/gateway", {
      params: org,
      success: Gateway,
      error: failures,
    }).annotate(Requires, "gateway.read"),
  )
  .add(
    HttpApiEndpoint.put("gateway.set", "/api/v1/orgs/:org/gateway/providers/:id", {
      params: { ...org, id: ProviderID },
      payload: GatewayProviderInput,
      success: GatewayProvider,
      error: failures,
    }).annotate(Requires, "gateway.write"),
  )
  .add(
    HttpApiEndpoint.delete("gateway.remove", "/api/v1/orgs/:org/gateway/providers/:id", {
      params: { ...org, id: Schema.String },
      success: HttpApiSchema.NoContent,
      error: failures,
    }).annotate(Requires, "gateway.write"),
  )
  .middleware(OrgScope)
  .middleware(Authorization)
