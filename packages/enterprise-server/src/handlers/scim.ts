import { Effect, Schema } from "effect"
import { HttpApiBuilder, HttpApiSchema } from "effect/unstable/httpapi"
import { Api } from "@enterprise/protocol/api"
import { ScimBadRequest, ScimConflict, ScimNotFound, scimBody } from "@enterprise/protocol/errors"
import type { UserInput } from "@enterprise/protocol/groups/scim"
import { Provisioner } from "@enterprise/protocol/middleware"
import { ServerConfig } from "../config"
import { RequestContext } from "../request"
import { Store, type Group, type User } from "../store"

// SCIM 2.0 (RFC 7643 / RFC 7644) provisioning for IdPs (Okta, Entra ID, OneLogin, ...). Users are
// scoped to the provisioning org: only people with a membership there (active or suspended) exist.

const urn = {
  user: "urn:ietf:params:scim:schemas:core:2.0:User",
  group: "urn:ietf:params:scim:schemas:core:2.0:Group",
  list: "urn:ietf:params:scim:api:messages:2.0:ListResponse",
  type: "urn:ietf:params:scim:schemas:core:2.0:ResourceType",
}

const bad = (detail: string, type?: string) => new ScimBadRequest(scimBody(400, detail, type))
const missing = (detail: string) => new ScimNotFound(scimBody(404, detail))

// Entra ID sends booleans as "True"/"False" strings.
function bool(value: unknown) {
  if (typeof value === "string") return value.toLowerCase() === "true"
  return value === true
}

// The `attr eq "value"` filters IdPs use to look up existing resources.
const filter = Effect.fn(function* (text: string | undefined) {
  if (!text) return undefined
  const match = text.trim().match(/^([\w.$]+(?:\[[^\]]*\])?(?:\.\w+)?)\s+eq\s+"((?:[^"\\]|\\.)*)"$/i)
  if (!match) return yield* bad(`unsupported filter: ${text}`, "invalidFilter")
  return { attr: match[1].toLowerCase(), value: match[2].replaceAll('\\"', '"') }
})

function page<T>(query: { startIndex?: number; count?: number }, rows: ReadonlyArray<T>) {
  const start = Math.max(query.startIndex || 1, 1)
  const count = Math.min(Math.max(query.count ?? 100, 0), 500)
  const slice = rows.slice(start - 1, start - 1 + count)
  return {
    schemas: [urn.list],
    totalResults: rows.length,
    startIndex: start,
    itemsPerPage: slice.length,
    Resources: slice,
  }
}

const excludes = (value: string | undefined) => (value ?? "").toLowerCase().split(",").includes("members")

type Name = NonNullable<UserInput["name"]>

function fullname(name: Name | undefined, display: string | undefined) {
  if (display) return display
  if (name?.formatted) return name.formatted
  const joined = [name?.givenName, name?.familyName].filter(Boolean).join(" ")
  return joined || undefined
}

const Emails = Schema.Array(Schema.Struct({ value: Schema.String, primary: Schema.optional(Schema.Unknown) }))
const decodeEmails = Schema.decodeUnknownOption(Emails)
const Partial = Schema.Record(Schema.String, Schema.Unknown)
const decodePartial = Schema.decodeUnknownOption(Partial)
const decodeName = Schema.decodeUnknownOption(
  Schema.Struct({
    formatted: Schema.optional(Schema.String),
    givenName: Schema.optional(Schema.String),
    familyName: Schema.optional(Schema.String),
  }),
)
const Members = Schema.Array(Schema.Struct({ value: Schema.String }))
const decodeMembers = Schema.decodeUnknownOption(Members)

const address = Effect.fn(function* (input: {
  userName?: string
  emails?: ReadonlyArray<{ value: string; primary?: unknown }>
}) {
  const primary = input.emails?.find((email) => bool(email.primary)) ?? input.emails?.at(0)
  const value = input.userName?.includes("@") ? input.userName : primary?.value
  if (!value || !value.includes("@"))
    return yield* bad("userName or a primary email must be an email address", "invalidValue")
  return value.trim().toLowerCase()
})

export const ScimHandler = HttpApiBuilder.group(Api, "enterprise.scim", (handlers) =>
  Effect.gen(function* () {
    const store = yield* Store.Service
    const config = yield* ServerConfig.Service
    const base = `${config.base}/scim/v2`

    const record = Effect.fn(function* (action: string, target: string, details?: Record<string, unknown>) {
      const scope = yield* Provisioner
      yield* store.audit.record({
        org: scope.org.id,
        action,
        actor: { id: null, email: `scim:${scope.token.name}` },
        target,
        details,
        ip: yield* RequestContext.address(config),
      })
    })

    const user = Effect.fn(function* (row: User) {
      const scope = yield* Provisioner
      const membership = yield* store.member.get(scope.org.id, row.id)
      const groups = yield* store.group.of(scope.org.id, row.id)
      // Absent attributes are omitted rather than sent as null (RFC 7643 §2.5).
      return {
        schemas: [urn.user],
        id: row.id,
        ...(row.external ? { externalId: row.external } : {}),
        userName: row.email,
        ...(row.name ? { displayName: row.name, name: { formatted: row.name } } : {}),
        emails: [{ value: row.email, primary: true, type: "work" }],
        active: row.active && membership != null && membership.suspended == null,
        groups: groups.map((group) => ({ value: group.id, display: group.name })),
        meta: {
          resourceType: "User",
          created: new Date(row.created).toISOString(),
          location: `${base}/Users/${row.id}`,
        },
      }
    })

    const group = Effect.fn(function* (row: Group, members = true) {
      const list = members ? yield* store.group.members(row.id) : undefined
      return {
        schemas: [urn.group],
        id: row.id,
        displayName: row.name,
        ...(row.external ? { externalId: row.external } : {}),
        ...(list
          ? {
              members: list.map((member) => ({
                value: member.id,
                display: member.email,
                $ref: `${base}/Users/${member.id}`,
              })),
            }
          : {}),
        meta: {
          resourceType: "Group",
          created: new Date(row.created).toISOString(),
          location: `${base}/Groups/${row.id}`,
        },
      }
    })

    const member = Effect.fn(function* (id: string) {
      const scope = yield* Provisioner
      const row = yield* store.user.get(id)
      if (!row || !(yield* store.member.get(scope.org.id, row.id))) return yield* missing(`user ${id} not found`)
      return row
    })

    const reload = Effect.fn(function* (id: string) {
      return yield* user((yield* store.user.get(id))!)
    })

    // Applies identity fields only when no org outside this one depends on the account.
    const identity = Effect.fn(function* (row: User, input: { email?: string; name?: string; external?: string }) {
      const scope = yield* Provisioner
      if ((yield* store.member.foreign(row.id, scope.org.id)) > 0) return row
      if (input.email && input.email !== row.email) {
        const clash = yield* store.user.find(input.email)
        if (clash && clash.id !== row.id)
          return yield* new ScimConflict(scimBody(409, `userName ${input.email} is already in use`, "uniqueness"))
      }
      return yield* store.user.update(row.id, { email: input.email, name: input.name, external: input.external })
    })

    const activate = Effect.fn(function* (row: User, active: boolean) {
      const scope = yield* Provisioner
      const current = yield* store.member.get(scope.org.id, row.id)
      if (!current || (current.suspended == null) === active) return
      yield* store.member.suspend(scope.org.id, row.id, !active)
      yield* record(active ? "scim.user_activate" : "scim.user_deactivate", row.id, { email: row.email })
    })

    const owned = Effect.fn(function* (id: string) {
      const scope = yield* Provisioner
      const row = yield* store.group.get(scope.org.id, id)
      if (!row) return yield* missing(`group ${id} not found`)
      return row
    })

    const join = Effect.fn(function* (id: string, values: ReadonlyArray<{ value: string }>) {
      const scope = yield* Provisioner
      for (const entry of values)
        if (!(yield* store.group.join(scope.org.id, id, entry.value)))
          return yield* bad(`user ${entry.value} is not provisioned`, "invalidValue")
    })

    return handlers
      .handle("config", () =>
        Effect.succeed({
          schemas: ["urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig"],
          patch: { supported: true },
          bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
          filter: { supported: true, maxResults: 500 },
          changePassword: { supported: false },
          sort: { supported: false },
          etag: { supported: false },
          authenticationSchemes: [
            {
              type: "oauthbearertoken",
              name: "OAuth Bearer Token",
              description: "Org-scoped SCIM token",
              primary: true,
            },
          ],
        }),
      )
      .handle("types", () =>
        Effect.succeed({
          schemas: [urn.list],
          totalResults: 2,
          Resources: [
            { schemas: [urn.type], id: "User", name: "User", endpoint: "/Users", schema: urn.user },
            { schemas: [urn.type], id: "Group", name: "Group", endpoint: "/Groups", schema: urn.group },
          ],
        }),
      )
      .handle("schemas", () =>
        Effect.succeed({
          schemas: [urn.list],
          totalResults: 2,
          Resources: [
            { id: urn.user, name: "User", description: "User account" },
            { id: urn.group, name: "Group", description: "Group of users" },
          ],
        }),
      )
      .handle(
        "users.list",
        Effect.fn(function* (ctx) {
          const scope = yield* Provisioner
          const query = yield* filter(ctx.query.filter)
          const rows = yield* store.member.list(scope.org.id)
          const matched: typeof rows = []
          for (const row of rows) {
            if (!query) matched.push(row)
            else if (query.attr === "username" || query.attr.startsWith("emails")) {
              if (row.email === query.value.toLowerCase()) matched.push(row)
            } else if (query.attr === "externalid") {
              if (row.external === query.value) matched.push(row)
            } else if (query.attr === "id") {
              if (row.id === query.value) matched.push(row)
            } else return yield* bad(`unsupported filter attribute: ${query.attr}`, "invalidFilter")
          }
          return page(ctx.query, yield* Effect.forEach(matched, user))
        }),
      )
      .handle(
        "users.get",
        Effect.fn(function* (ctx) {
          return yield* user(yield* member(ctx.params.id))
        }),
      )
      .handle(
        "users.create",
        Effect.fn(function* (ctx) {
          const scope = yield* Provisioner
          const input = ctx.payload
          const email = yield* address(input)
          const existing = yield* store.user.find(email)
          if (existing && (yield* store.member.get(scope.org.id, existing.id)))
            return yield* new ScimConflict(scimBody(409, `userName ${email} is already provisioned`, "uniqueness"))
          const name = fullname(input.name, input.displayName)
          const row = existing
            ? yield* identity(existing, { name, external: input.externalId })
            : yield* store.user.ensure({ email, name, external: input.externalId })
          if (!row.active) yield* store.user.update(row.id, { active: true })
          yield* store.member.add(scope.org.id, row.id, "member")
          if (input.active !== undefined && !bool(input.active)) yield* store.member.suspend(scope.org.id, row.id, true)
          yield* record("scim.user_create", row.id, { email })
          return yield* reload(row.id)
        }),
      )
      .handle(
        "users.replace",
        Effect.fn(function* (ctx) {
          const row = yield* member(ctx.params.id)
          const input = ctx.payload
          const next = yield* identity(row, {
            email: yield* address(input),
            name: fullname(input.name, input.displayName),
            external: input.externalId,
          })
          if (input.active !== undefined) yield* activate(next, bool(input.active))
          yield* record("scim.user_update", row.id, { email: next.email })
          return yield* reload(row.id)
        }),
      )
      .handle(
        "users.patch",
        Effect.fn(function* (ctx) {
          const row = yield* member(ctx.params.id)
          const changes: {
            email?: string
            name?: string
            given?: string
            family?: string
            external?: string
            active?: boolean
          } = {}
          for (const op of ctx.payload.Operations) {
            if (op.op.toLowerCase() === "remove") continue
            // Without a path the value is a partial resource; with one it's a single attribute.
            const updates = op.path
              ? { [op.path]: op.value }
              : decodePartial(op.value).pipe((option) => (option._tag === "Some" ? option.value : {}))
            for (const [path, value] of Object.entries(updates)) {
              const key = path.toLowerCase()
              if (key === "active") changes.active = bool(value)
              if (key === "username" && typeof value === "string") changes.email = value
              if (key.startsWith("emails")) {
                const list = decodeEmails(Array.isArray(value) ? value : [{ value, primary: true }])
                const emails = list._tag === "Some" ? list.value : []
                const primary = emails.find((email) => bool(email.primary)) ?? emails.at(0)
                if (primary?.value.includes("@") && !changes.email) changes.email = primary.value
              }
              if ((key === "displayname" || key === "name.formatted") && typeof value === "string") changes.name = value
              if (key === "name.givenname" && typeof value === "string") changes.given = value
              if (key === "name.familyname" && typeof value === "string") changes.family = value
              if (key === "name") {
                const parsed = decodeName(value)
                if (parsed._tag === "Some") changes.name = fullname(parsed.value, undefined)
              }
              if (key === "externalid" && typeof value === "string") changes.external = value
            }
          }
          const name = changes.name ?? ([changes.given, changes.family].filter(Boolean).join(" ") || undefined)
          const next = yield* identity(row, {
            email: changes.email?.trim().toLowerCase(),
            name,
            external: changes.external,
          })
          if (changes.active !== undefined) yield* activate(next, changes.active)
          yield* record("scim.user_update", row.id, { email: next.email, active: changes.active })
          return yield* reload(row.id)
        }),
      )
      .handle(
        "users.remove",
        Effect.fn(function* (ctx) {
          const scope = yield* Provisioner
          const row = yield* member(ctx.params.id)
          yield* store.member.remove(scope.org.id, row.id)
          // Fully deprovisioned once no org holds a membership: deactivating also revokes every token.
          if ((yield* store.member.count(row.id)) === 0) yield* store.user.update(row.id, { active: false })
          yield* record("scim.user_delete", row.id, { email: row.email })
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "groups.list",
        Effect.fn(function* (ctx) {
          const scope = yield* Provisioner
          const query = yield* filter(ctx.query.filter)
          const rows = yield* store.group.list(scope.org.id)
          const matched: typeof rows = []
          for (const row of rows) {
            if (!query) matched.push(row)
            else if (query.attr === "displayname") {
              if (row.name === query.value) matched.push(row)
            } else if (query.attr === "externalid") {
              if (row.external === query.value) matched.push(row)
            } else if (query.attr === "id") {
              if (row.id === query.value) matched.push(row)
            } else return yield* bad(`unsupported filter attribute: ${query.attr}`, "invalidFilter")
          }
          const members = !excludes(ctx.query.excludedAttributes)
          return page(ctx.query, yield* Effect.forEach(matched, (row) => group(row, members)))
        }),
      )
      .handle(
        "groups.get",
        Effect.fn(function* (ctx) {
          return yield* group(yield* owned(ctx.params.id), !excludes(ctx.query.excludedAttributes))
        }),
      )
      .handle(
        "groups.create",
        Effect.fn(function* (ctx) {
          const scope = yield* Provisioner
          const input = ctx.payload
          if ((yield* store.group.list(scope.org.id)).some((row) => row.name === input.displayName))
            return yield* new ScimConflict(scimBody(409, `group ${input.displayName} already exists`, "uniqueness"))
          const row = yield* store.group.create(scope.org.id, { name: input.displayName, external: input.externalId })
          yield* join(row.id, input.members ?? [])
          yield* record("scim.group_create", row.id, { name: row.name })
          return yield* group(row)
        }),
      )
      .handle(
        "groups.replace",
        Effect.fn(function* (ctx) {
          const scope = yield* Provisioner
          const row = yield* owned(ctx.params.id)
          const input = ctx.payload
          yield* store.group.update(scope.org.id, row.id, { name: input.displayName, external: input.externalId })
          yield* store.group.assign(scope.org.id, row.id, [])
          yield* join(row.id, input.members ?? [])
          yield* record("scim.group_update", row.id, { name: input.displayName })
          return yield* group(yield* owned(row.id))
        }),
      )
      .handle(
        "groups.patch",
        Effect.fn(function* (ctx) {
          const scope = yield* Provisioner
          const row = yield* owned(ctx.params.id)
          for (const op of ctx.payload.Operations) {
            const kind = op.op.toLowerCase()
            const path = op.path?.toLowerCase()
            const decoded = decodeMembers(op.value)
            const list = decoded._tag === "Some" ? decoded.value : []
            if (path?.startsWith("members[") && kind === "remove") {
              const id = op.path!.match(/value\s+eq\s+"([^"]+)"/i)?.[1]
              if (id) yield* store.group.leave(row.id, id)
              continue
            }
            if (path === "members") {
              if (kind === "add") yield* join(row.id, list)
              if (kind === "remove" && list.length)
                for (const entry of list) yield* store.group.leave(row.id, entry.value)
              if (kind === "remove" && !list.length) yield* store.group.assign(scope.org.id, row.id, [])
              if (kind === "replace") {
                yield* store.group.assign(scope.org.id, row.id, [])
                yield* join(row.id, list)
              }
              continue
            }
            if (path === "displayname" && typeof op.value === "string")
              yield* store.group.update(scope.org.id, row.id, { name: op.value })
            if (path === "externalid" && typeof op.value === "string")
              yield* store.group.update(scope.org.id, row.id, { external: op.value })
            const partial = path ? undefined : decodePartial(op.value)
            if (partial?._tag === "Some") {
              const value = partial.value
              if (typeof value.displayName === "string")
                yield* store.group.update(scope.org.id, row.id, { name: value.displayName })
              if (typeof value.externalId === "string")
                yield* store.group.update(scope.org.id, row.id, { external: value.externalId })
              const entries = decodeMembers(value.members)
              if (entries._tag === "Some" && kind === "replace") yield* store.group.assign(scope.org.id, row.id, [])
              if (entries._tag === "Some") yield* join(row.id, entries.value)
            }
          }
          yield* record("scim.group_update", row.id, { operations: ctx.payload.Operations.length })
          return yield* group(yield* owned(row.id))
        }),
      )
      .handle(
        "groups.remove",
        Effect.fn(function* (ctx) {
          const scope = yield* Provisioner
          const row = yield* owned(ctx.params.id)
          yield* store.group.remove(scope.org.id, row.id)
          yield* record("scim.group_delete", row.id, { name: row.name })
          return HttpApiSchema.NoContent.make()
        }),
      )
  }),
)
