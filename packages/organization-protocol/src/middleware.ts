import { Context } from "effect"
import { HttpApiMiddleware } from "effect/unstable/httpapi"
import { ForbiddenError, InvalidRequestError, NotFoundError, ScimUnauthorizedJson, UnauthorizedError } from "./errors"
import type { Org, Role } from "./schema"

export const cookie = "org_session"

// The authenticated user and the token they presented. Tokens are bound to one org.
export class Caller extends Context.Service<
  Caller,
  {
    readonly user: { readonly id: string; readonly email: string; readonly name: string | null }
    readonly token: { readonly id: string; readonly org: string }
    // Browser sessions ride on an ambient cookie; writes must prove same-origin (CSRF).
    readonly cookie: boolean
  }
>()("@organization/Caller") {}

// The org an org-scoped request targets, and the caller's role in it.
export class Membership extends Context.Service<
  Membership,
  { readonly org: Org; readonly role: Role; readonly inherited: boolean }
>()("@organization/Membership") {}

// The org a SCIM token provisions.
export class Provisioner extends Context.Service<
  Provisioner,
  { readonly org: Org; readonly token: { readonly id: string; readonly name: string } }
>()("@organization/Provisioner") {}

// Bearer tokens (CLI, IDEs, API clients) or the admin console's session cookie. Credentials are read
// from the request directly rather than as HttpApiSecurity alternatives: Effect retries the next
// alternative when the handler fails, which would run a handler twice and turn its 404 into a 401.
export class Authorization extends HttpApiMiddleware.Service<Authorization, { provides: Caller }>()(
  "@organization/Authorization",
  { error: [UnauthorizedError, ForbiddenError] },
) {}

// Resolves `/api/v1/orgs/:org` against the caller's token and membership.
export class OrgScope extends HttpApiMiddleware.Service<OrgScope, { provides: Membership; requires: Caller }>()(
  "@organization/OrgScope",
  { error: [NotFoundError, ForbiddenError] },
) {}

export class ScimAuthorization extends HttpApiMiddleware.Service<ScimAuthorization, { provides: Provisioner }>()(
  "@organization/ScimAuthorization",
  { error: ScimUnauthorizedJson },
) {}

// Turns request decoding failures into a 400 the client can read (SCIM endpoints answer in SCIM's
// own error format). Declared once on the whole API.
export class SchemaErrorMiddleware extends HttpApiMiddleware.Service<SchemaErrorMiddleware>()(
  "@organization/SchemaError",
  { error: InvalidRequestError },
) {}
