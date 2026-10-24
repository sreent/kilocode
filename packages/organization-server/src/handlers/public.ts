import { Clock, Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "@organization/protocol/api"
import { DeviceError, ForbiddenError, InvalidRequestError, NotFoundError } from "@organization/protocol/errors"
import { ServerConfig } from "../config"
import { RequestContext } from "../request"
import { Store } from "../store"

const day = 24 * 60 * 60 * 1000
export const ttl = {
  device: 10 * 60 * 1000,
  // CLI and IDE logins; long-lived so developers aren't interrupted, revocable at any time.
  cli: 90 * day,
  invite: 7 * day,
}
// Seconds a device client must wait between token polls (RFC 8628 §3.2).
export const interval = 5

export const HealthHandler = HttpApiBuilder.group(Api, "organization.health", (handlers) =>
  handlers.handle("health.get", () => Effect.succeed({ ok: true as const })),
)

// RFC 8628 device authorization: the CLI shows a code, the user approves it in the browser via SSO.
export const SigninHandler = HttpApiBuilder.group(Api, "organization.signin", (handlers) =>
  Effect.gen(function* () {
    const store = yield* Store.Service
    const config = yield* ServerConfig.Service
    const address = RequestContext.address(config)

    return handlers
      .handle(
        "device.start",
        Effect.fn(function* (ctx) {
          const org = yield* store.org.get(ctx.payload.org)
          if (!org) return yield* new NotFoundError({ message: "organization not found" })
          if (!(yield* store.sso.get(org.id)))
            return yield* new InvalidRequestError({
              message:
                "single sign-on is not configured for this organization; ask an administrator for an access token",
            })
          const created = yield* store.device.create(org.id, ttl.device)
          return {
            device_code: created.value,
            user_code: created.code,
            verification_uri: `${config.base}/device`,
            verification_uri_complete: `${config.base}/device?code=${created.code}`,
            expires_in: ttl.device / 1000,
            interval,
          }
        }),
      )
      .handle(
        "device.token",
        Effect.fn(function* (ctx) {
          const row = yield* store.device.find(ctx.payload.device_code)
          const time = yield* Clock.currentTimeMillis
          if (!row || row.status === "consumed") return yield* new DeviceError({ error: "invalid_grant" })
          if (row.expires < time) return yield* new DeviceError({ error: "expired_token" })
          if (row.status === "denied") return yield* new DeviceError({ error: "access_denied" })
          if (row.status === "pending") {
            const fast = row.polled != null && time - row.polled < interval * 1000
            yield* store.device.poll(row.hash)
            return yield* new DeviceError({ error: fast ? "slow_down" : "authorization_pending" })
          }
          if (!row.user || !(yield* store.device.consume(row.hash)))
            return yield* new DeviceError({ error: "invalid_grant" })
          const user = (yield* store.user.get(row.user))!
          const org = (yield* store.org.get(row.org))!
          const issued = yield* store.token.issue({
            kind: "user",
            user: user.id,
            org: org.id,
            name: "CLI device login",
            ttl: ttl.cli,
          })
          yield* store.audit.record({
            org: org.id,
            action: "user.login",
            actor: { id: user.id, email: user.email },
            target: user.id,
            details: { method: "device" },
            ip: yield* address,
          })
          return {
            access_token: issued.value,
            token_type: "Bearer" as const,
            expires_in: ttl.cli / 1000,
            user: { id: user.id, email: user.email, name: user.name },
            org: { id: org.id, slug: org.slug, name: org.name },
          }
        }),
      )
      .handle(
        "invite.accept",
        // Invite links are bearer secrets delivered by an admin. Orgs that enforce SSO accept
        // invites only through SSO.
        Effect.fn(function* (ctx) {
          const row = yield* store.invite.find(ctx.params.token)
          if (!row) return yield* new NotFoundError({ message: "invite not found or expired" })
          if ((yield* store.sso.get(row.org))?.enforce)
            return yield* new ForbiddenError({
              message: "this organization requires single sign-on; sign in with SSO to accept your invite",
            })
          const user = yield* store.user.ensure({ email: row.email, name: ctx.payload.name })
          if (!user.active) return yield* new ForbiddenError({ message: "this account is deactivated" })
          const full = yield* store.seats.full(row.org, user.id)
          if (full) return yield* new ForbiddenError({ message: full })
          const issued = yield* store.transaction(
            Effect.gen(function* () {
              if (!(yield* store.invite.accept(row.id)))
                return yield* new NotFoundError({ message: "invite not found or expired" })
              yield* store.member.add(row.org, user.id, row.role)
              return yield* store.token.issue({
                kind: "user",
                user: user.id,
                org: row.org,
                name: "Invite acceptance",
                ttl: ttl.cli,
              })
            }),
          )
          yield* store.audit.record({
            org: row.org,
            action: "user.accept_invite",
            actor: { id: user.id, email: user.email },
            target: user.id,
            details: { role: row.role, invite: row.id },
            ip: yield* address,
          })
          const org = (yield* store.org.get(row.org))!
          return {
            token: issued.value,
            user: { id: user.id, email: user.email, name: user.name },
            org: { id: org.id, slug: org.slug, name: org.name },
          }
        }),
      )
  }),
)
