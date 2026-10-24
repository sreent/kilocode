import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/unstable/httpapi"
import { ScimErrors, scimMedia } from "../errors"
import { ScimAuthorization } from "../middleware"

// SCIM 2.0 (RFC 7643 / RFC 7644) for IdP-driven provisioning (Okta, Entra ID, OneLogin, ...).
// The bearer token decides the org, so one base URL serves every org on the server.

const media = scimMedia
const out = <S extends Schema.Top>(schema: S) => schema.pipe(HttpApiSchema.asJson({ contentType: media }))
// IdPs send either content type; accept both.
const body = <S extends Schema.Top>(schema: S) =>
  [schema, schema.pipe(HttpApiSchema.asJson({ contentType: media }))] as const

const rest = [Schema.Record(Schema.String, Schema.Unknown)] as const
const loose = <F extends Schema.Struct.Fields>(fields: F) => Schema.StructWithRest(Schema.Struct(fields), rest)

const Email = loose({
  value: Schema.String,
  primary: Schema.optional(Schema.Unknown),
  type: Schema.optional(Schema.String),
})
const Name = loose({
  formatted: Schema.optional(Schema.String),
  givenName: Schema.optional(Schema.String),
  familyName: Schema.optional(Schema.String),
})

export const UserInput = loose({
  userName: Schema.String.check(Schema.isMinLength(1)),
  externalId: Schema.optional(Schema.String),
  displayName: Schema.optional(Schema.String),
  name: Schema.optional(Name),
  emails: Schema.optional(Schema.Array(Email)),
  // Entra ID sends booleans as "True"/"False" strings, so this stays untyped until handled.
  active: Schema.optional(Schema.Unknown),
})
export type UserInput = typeof UserInput.Type

export const GroupInput = loose({
  displayName: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  externalId: Schema.optional(Schema.String),
  members: Schema.optional(Schema.Array(loose({ value: Schema.String }))),
})
export type GroupInput = typeof GroupInput.Type

export const PatchOp = loose({
  Operations: Schema.Array(
    loose({ op: Schema.String, path: Schema.optional(Schema.String), value: Schema.optional(Schema.Unknown) }),
  ).check(Schema.isMinLength(1)),
})
export type PatchOp = typeof PatchOp.Type

const Meta = Schema.Struct({ resourceType: Schema.String, created: Schema.String, location: Schema.String })

export const User = Schema.Struct({
  schemas: Schema.Array(Schema.String),
  id: Schema.String,
  externalId: Schema.optional(Schema.String),
  userName: Schema.String,
  displayName: Schema.optional(Schema.String),
  name: Schema.optional(Schema.Struct({ formatted: Schema.String })),
  emails: Schema.Array(Schema.Struct({ value: Schema.String, primary: Schema.Boolean, type: Schema.String })),
  active: Schema.Boolean,
  groups: Schema.Array(Schema.Struct({ value: Schema.String, display: Schema.String })),
  meta: Meta,
})

export const Group = Schema.Struct({
  schemas: Schema.Array(Schema.String),
  id: Schema.String,
  displayName: Schema.String,
  externalId: Schema.optional(Schema.String),
  members: Schema.optional(
    Schema.Array(Schema.Struct({ value: Schema.String, display: Schema.String, $ref: Schema.String })),
  ),
  meta: Meta,
})

const listOf = <S extends Schema.Top>(item: S) =>
  Schema.Struct({
    schemas: Schema.Array(Schema.String),
    totalResults: Schema.Finite,
    startIndex: Schema.Finite,
    itemsPerPage: Schema.Finite,
    Resources: Schema.Array(item),
  })

const page = {
  filter: Schema.optional(Schema.String),
  startIndex: Schema.optional(Schema.NumberFromString),
  count: Schema.optional(Schema.NumberFromString),
  excludedAttributes: Schema.optional(Schema.String),
}
const id = { id: Schema.String }
const errors = ScimErrors

export const ScimGroup = HttpApiGroup.make("organization.scim")
  .add(HttpApiEndpoint.get("config", "/scim/v2/ServiceProviderConfig", { success: out(Schema.Unknown), error: errors }))
  .add(HttpApiEndpoint.get("types", "/scim/v2/ResourceTypes", { success: out(Schema.Unknown), error: errors }))
  .add(HttpApiEndpoint.get("schemas", "/scim/v2/Schemas", { success: out(Schema.Unknown), error: errors }))
  .add(HttpApiEndpoint.get("users.list", "/scim/v2/Users", { query: page, success: out(listOf(User)), error: errors }))
  .add(HttpApiEndpoint.get("users.get", "/scim/v2/Users/:id", { params: id, success: out(User), error: errors }))
  .add(
    HttpApiEndpoint.post("users.create", "/scim/v2/Users", {
      payload: body(UserInput),
      success: out(User).pipe(HttpApiSchema.status(201)),
      error: errors,
    }),
  )
  .add(
    HttpApiEndpoint.put("users.replace", "/scim/v2/Users/:id", {
      params: id,
      payload: body(UserInput),
      success: out(User),
      error: errors,
    }),
  )
  .add(
    HttpApiEndpoint.patch("users.patch", "/scim/v2/Users/:id", {
      params: id,
      payload: body(PatchOp),
      success: out(User),
      error: errors,
    }),
  )
  .add(
    HttpApiEndpoint.delete("users.remove", "/scim/v2/Users/:id", {
      params: id,
      success: HttpApiSchema.NoContent,
      error: errors,
    }),
  )
  .add(
    HttpApiEndpoint.get("groups.list", "/scim/v2/Groups", { query: page, success: out(listOf(Group)), error: errors }),
  )
  .add(
    HttpApiEndpoint.get("groups.get", "/scim/v2/Groups/:id", {
      params: id,
      query: { excludedAttributes: Schema.optional(Schema.String) },
      success: out(Group),
      error: errors,
    }),
  )
  .add(
    HttpApiEndpoint.post("groups.create", "/scim/v2/Groups", {
      payload: body(GroupInput),
      success: out(Group).pipe(HttpApiSchema.status(201)),
      error: errors,
    }),
  )
  .add(
    HttpApiEndpoint.put("groups.replace", "/scim/v2/Groups/:id", {
      params: id,
      payload: body(GroupInput),
      success: out(Group),
      error: errors,
    }),
  )
  .add(
    HttpApiEndpoint.patch("groups.patch", "/scim/v2/Groups/:id", {
      params: id,
      payload: body(PatchOp),
      success: out(Group),
      error: errors,
    }),
  )
  .add(
    HttpApiEndpoint.delete("groups.remove", "/scim/v2/Groups/:id", {
      params: id,
      success: HttpApiSchema.NoContent,
      error: errors,
    }),
  )
  .middleware(ScimAuthorization)
