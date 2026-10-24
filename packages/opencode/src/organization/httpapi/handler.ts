// kilocode_change - new file (organization)
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "@/server/routes/instance/httpapi/api"
import { Organization } from "../organization"
import { OrganizationSigninError } from "./group"

export const organizationHandlers = HttpApiBuilder.group(InstanceHttpApi, "org", (handlers) =>
  Effect.gen(function* () {
    const organization = yield* Organization.Service

    const status = Effect.fn("OrganizationHttpApi.status")(function* () {
      const cfg = yield* organization.settings()
      if (cfg) yield* organization.ready()
      const info = yield* organization.status()
      const policy = info.policy
      return {
        enabled: cfg !== undefined,
        source: cfg?.source,
        url: cfg?.url || undefined,
        org: cfg?.org ? { slug: cfg.org, name: policy?.org.name } : undefined,
        required: cfg?.required ?? false,
        user: policy ? { email: policy.user.email, role: policy.user.role } : undefined,
        policy: policy && info.fetched ? { version: policy.version, fetched: info.fetched } : undefined,
        blocked: yield* organization.blocked(),
        error: info.error ?? cfg?.error,
        gateway: policy?.gateway.providers.map((item) => item.id) ?? [],
        signin: yield* organization.signin.pending(),
      }
    })

    const failed = (error: Organization.SigninError) =>
      new OrganizationSigninError({ name: "OrganizationSigninError", message: error.message })

    return handlers
      .handle("status", () => status())
      .handle(
        "signin",
        Effect.fn("OrganizationHttpApi.signin")(function* (ctx) {
          const input = { url: ctx.payload.url, org: ctx.payload.org }
          yield* (
            ctx.payload.token
              ? Effect.asVoid(organization.signin.token({ ...input, token: ctx.payload.token }))
              : Effect.asVoid(organization.signin.start(input))
          ).pipe(Effect.mapError(failed))
          return yield* status()
        }),
      )
      .handle(
        "wait",
        Effect.fn("OrganizationHttpApi.wait")(function* () {
          yield* organization.signin.finish().pipe(Effect.mapError(failed))
          return yield* status()
        }),
      )
      .handle(
        "signout",
        Effect.fn("OrganizationHttpApi.signout")(function* () {
          yield* organization.signout()
          return yield* status()
        }),
      )
  }),
)
