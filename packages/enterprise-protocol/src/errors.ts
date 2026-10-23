import { Schema } from "effect"
import { HttpApiSchema } from "effect/unstable/httpapi"

export class InvalidRequestError extends Schema.TaggedErrorClass<InvalidRequestError>()(
  "InvalidRequestError",
  { message: Schema.String, kind: Schema.optional(Schema.String) },
  { httpApiStatus: 400 },
) {}

export class UnauthorizedError extends Schema.TaggedErrorClass<UnauthorizedError>()(
  "UnauthorizedError",
  { message: Schema.String },
  { httpApiStatus: 401 },
) {}

export class ForbiddenError extends Schema.TaggedErrorClass<ForbiddenError>()(
  "ForbiddenError",
  { message: Schema.String },
  { httpApiStatus: 403 },
) {}

// 404 rather than 403 wherever a caller could otherwise probe which orgs or resources exist.
export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()(
  "NotFoundError",
  { message: Schema.String },
  { httpApiStatus: 404 },
) {}

export class ConflictError extends Schema.TaggedErrorClass<ConflictError>()(
  "ConflictError",
  { message: Schema.String },
  { httpApiStatus: 409 },
) {}

// RFC 8628 §3.5 token endpoint errors, which clients branch on by `error`. An ErrorClass rather than
// a tagged one, so the body is exactly `{ "error": ... }` as the RFC specifies.
export class DeviceError extends Schema.ErrorClass<DeviceError>("DeviceError")(
  {
    error: Schema.Literals(["authorization_pending", "slow_down", "access_denied", "expired_token", "invalid_grant"]),
  },
  { httpApiStatus: 400 },
) {}

// SCIM (RFC 7644 §3.12) error bodies, one class per status the provisioning API returns. Untagged and
// sent as application/scim+json, so IdPs receive exactly the RFC's shape.
const scim = {
  schemas: Schema.Array(Schema.String),
  status: Schema.String,
  detail: Schema.String,
  scimType: Schema.optional(Schema.String),
}

export class ScimBadRequest extends Schema.ErrorClass<ScimBadRequest>("ScimBadRequest")(scim, {
  httpApiStatus: 400,
}) {}
export class ScimUnauthorized extends Schema.ErrorClass<ScimUnauthorized>("ScimUnauthorized")(scim, {
  httpApiStatus: 401,
}) {}
export class ScimNotFound extends Schema.ErrorClass<ScimNotFound>("ScimNotFound")(scim, {
  httpApiStatus: 404,
}) {}
export class ScimConflict extends Schema.ErrorClass<ScimConflict>("ScimConflict")(scim, {
  httpApiStatus: 409,
}) {}

export const scimMedia = "application/scim+json"

const scimJson = <S extends Schema.Top>(schema: S) => schema.pipe(HttpApiSchema.asJson({ contentType: scimMedia }))

// ScimAuthorization declares the 401; endpoints declare the rest.
export const ScimUnauthorizedJson = scimJson(ScimUnauthorized)
export const ScimErrors = [scimJson(ScimBadRequest), scimJson(ScimNotFound), scimJson(ScimConflict)] as const

export const scimError = "urn:ietf:params:scim:api:messages:2.0:Error"

export function scimBody(status: number, detail: string, type?: string) {
  return { schemas: [scimError], status: String(status), detail, ...(type ? { scimType: type } : {}) }
}
