import { Effect } from "effect"
import { HttpApiBuilder, HttpApiSchema } from "effect/unstable/httpapi"
import { Api } from "@enterprise/protocol/api"
import { ConflictError, ForbiddenError, NotFoundError } from "@enterprise/protocol/errors"
import { Caller, Membership } from "@enterprise/protocol/middleware"
import type { Role } from "@enterprise/protocol/schema"
import { ServerConfig } from "../config"
import { RequestContext } from "../request"
import { Store } from "../store"
import { ttl } from "./public"
import { changed, delta } from "./shared"

const day = 24 * 60 * 60 * 1000

// Only owners grant the owner role or manage another owner's membership.
const guard = Effect.fn(function* (current: Role | undefined, next?: Role) {
  const scope = yield* Membership
  if (scope.role === "owner") return
  if (current === "owner" || next === "owner")
    return yield* new ForbiddenError({ message: "only owners can manage owners" })
})

export const PeopleHandler = HttpApiBuilder.group(Api, "enterprise.people", (handlers) =>
  Effect.gen(function* () {
    const store = yield* Store.Service
    const config = yield* ServerConfig.Service
    const audit = RequestContext.auditor(store, config)

    const group = Effect.fn(function* (id: string) {
      const scope = yield* Membership
      const row = yield* store.group.get(scope.org.id, id)
      if (!row) return yield* new NotFoundError({ message: "group not found" })
      const members = yield* store.group.members(row.id)
      return {
        id: row.id,
        name: row.name,
        external: row.external,
        models: store.group.access(row),
        members: members.map((user) => ({ id: user.id, email: user.email, name: user.name })),
        created: row.created,
      }
    })

    // An organization must keep at least one owner. Checked with the write in one store transaction,
    // so two owners demoting each other at once can't leave none.
    const lastOwner = Effect.fn(function* (orgID: string) {
      if ((yield* store.member.owners(orgID)) <= 1)
        return yield* new ConflictError({ message: "an organization must keep at least one owner" })
    })

    return handlers
      .handle(
        "members.list",
        Effect.fn(function* () {
          const scope = yield* Membership
          const rows = yield* store.member.list(scope.org.id)
          const members = yield* Effect.forEach(rows, (row) =>
            store.group.of(scope.org.id, row.id).pipe(
              Effect.map((groups) => ({
                id: row.id,
                email: row.email,
                name: row.name,
                role: row.role,
                active: row.active && row.suspended == null,
                joined: row.joined,
                groups: groups.map((group) => group.name),
              })),
            ),
          )
          return { members }
        }),
      )
      .handle(
        "members.add",
        Effect.fn(function* (ctx) {
          const scope = yield* Membership
          const role = ctx.payload.role ?? "member"
          yield* guard(undefined, role)
          const user = yield* store.user.ensure({ email: ctx.payload.email, name: ctx.payload.name })
          if (yield* store.member.get(scope.org.id, user.id))
            return yield* new ConflictError({ message: "already a member" })
          yield* store.member.add(scope.org.id, user.id, role)
          yield* audit("member.add", user.id, { email: user.email, role })
          return { id: user.id, email: user.email, role }
        }),
      )
      .handle(
        "members.update",
        Effect.fn(function* (ctx) {
          const scope = yield* Membership
          const target = ctx.params.user
          const current = yield* store.transaction(
            Effect.gen(function* () {
              const current = yield* store.member.get(scope.org.id, target)
              if (!current) return yield* new NotFoundError({ message: "member not found" })
              yield* guard(current.role, ctx.payload.role)
              if (current.role === "owner" && ctx.payload.role !== "owner") yield* lastOwner(scope.org.id)
              yield* store.member.set(scope.org.id, target, ctx.payload.role)
              return current
            }),
          )
          yield* audit("member.change_role", target, { from: current.role, to: ctx.payload.role })
          return { id: target, role: ctx.payload.role }
        }),
      )
      .handle(
        "members.remove",
        Effect.fn(function* (ctx) {
          const scope = yield* Membership
          const target = ctx.params.user
          const current = yield* store.transaction(
            Effect.gen(function* () {
              const current = yield* store.member.get(scope.org.id, target)
              if (!current) return yield* new NotFoundError({ message: "member not found" })
              yield* guard(current.role)
              if (current.role === "owner") yield* lastOwner(scope.org.id)
              yield* store.member.remove(scope.org.id, target)
              return current
            }),
          )
          const email = (yield* store.user.get(target))?.email
          yield* audit("member.remove", target, { role: current.role, email })
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "members.token",
        // For orgs without SSO: an admin issues a CLI/IDE token for a member and hands it over out of band.
        Effect.fn(function* (ctx) {
          const scope = yield* Membership
          if ((yield* store.sso.get(scope.org.id))?.enforce)
            return yield* new ForbiddenError({
              message: "this organization enforces single sign-on; members sign in with SSO",
            })
          const target = ctx.params.user
          const current = yield* store.member.get(scope.org.id, target)
          if (!current || current.suspended) return yield* new NotFoundError({ message: "member not found" })
          yield* guard(current.role)
          const name = ctx.payload.name ?? "Admin-issued token"
          const days = ctx.payload.days ?? 90
          const issued = yield* store.token.issue({
            kind: "user",
            user: target,
            org: scope.org.id,
            name,
            ttl: days * day,
          })
          yield* audit("token.create", target, { token: issued.id, name, days, issued_by_admin: true })
          return { id: issued.id, token: issued.value }
        }),
      )
      .handle(
        "invites.list",
        Effect.fn(function* () {
          const scope = yield* Membership
          const rows = yield* store.invite.pending(scope.org.id)
          return {
            invites: rows.map((row) => ({
              id: row.id,
              email: row.email,
              role: row.role,
              created: row.created,
              expires: row.expires,
            })),
          }
        }),
      )
      .handle(
        "invites.create",
        Effect.fn(function* (ctx) {
          const scope = yield* Membership
          const caller = yield* Caller
          const role = ctx.payload.role ?? "member"
          yield* guard(undefined, role)
          const existing = yield* store.user.find(ctx.payload.email)
          if (existing && (yield* store.member.get(scope.org.id, existing.id)))
            return yield* new ConflictError({ message: "already a member" })
          const created = yield* store.invite.create({
            org: scope.org.id,
            email: ctx.payload.email,
            role,
            actor: caller.user.id,
            ttl: ctx.payload.days ? ctx.payload.days * day : ttl.invite,
          })
          yield* audit("user.send_invite", created.id, { email: ctx.payload.email, role })
          const sso = yield* store.sso.get(scope.org.id)
          return {
            id: created.id,
            token: created.value,
            accept: `${config.base}/api/v1/invites/${created.value}/accept`,
            sso: sso ? `${config.base}/sso/${scope.org.slug}/start` : null,
          }
        }),
      )
      .handle(
        "invites.revoke",
        Effect.fn(function* (ctx) {
          const scope = yield* Membership
          if (!(yield* store.invite.revoke(scope.org.id, ctx.params.id)))
            return yield* new NotFoundError({ message: "invite not found" })
          yield* audit("user.revoke_invite", ctx.params.id)
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "groups.list",
        Effect.fn(function* () {
          const scope = yield* Membership
          const rows = yield* store.group.list(scope.org.id)
          return { groups: yield* Effect.forEach(rows, (row) => group(row.id)) }
        }),
      )
      .handle(
        "groups.mine",
        // Members only learn the names of the groups they belong to.
        Effect.fn(function* () {
          const scope = yield* Membership
          const caller = yield* Caller
          const rows = yield* store.group.of(scope.org.id, caller.user.id)
          return { groups: rows.map((row) => ({ id: row.id, name: row.name })) }
        }),
      )
      .handle("groups.get", (ctx) => group(ctx.params.id))
      .handle(
        "groups.create",
        Effect.fn(function* (ctx) {
          const scope = yield* Membership
          if ((yield* store.group.list(scope.org.id)).some((row) => row.name === ctx.payload.name))
            return yield* new ConflictError({ message: "a group with this name exists" })
          const row = yield* store.group.create(scope.org.id, ctx.payload)
          yield* audit("group.create", row.id, { name: ctx.payload.name, models: ctx.payload.models ?? null })
          return yield* group(row.id)
        }),
      )
      .handle(
        "groups.update",
        Effect.fn(function* (ctx) {
          const scope = yield* Membership
          const before = yield* group(ctx.params.id)
          yield* store.group.update(scope.org.id, before.id, ctx.payload)
          const after = yield* group(before.id)
          yield* audit("group.update", before.id, { changed: changed(before, after), models: after.models })
          return after
        }),
      )
      .handle(
        "groups.members",
        Effect.fn(function* (ctx) {
          const scope = yield* Membership
          const before = yield* group(ctx.params.id)
          yield* store.group.assign(scope.org.id, before.id, ctx.payload.users)
          const after = yield* group(before.id)
          yield* audit("group.update", before.id, {
            members: delta(
              before.members.map((user) => user.email),
              after.members.map((user) => user.email),
            ),
          })
          return after
        }),
      )
      .handle(
        "groups.remove",
        Effect.fn(function* (ctx) {
          const scope = yield* Membership
          const row = yield* group(ctx.params.id)
          yield* store.group.remove(scope.org.id, row.id)
          yield* audit("group.delete", row.id, { name: row.name })
          return HttpApiSchema.NoContent.make()
        }),
      )
  }),
)
