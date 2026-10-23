// kilocode_change - new file (enterprise)
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "@/server/routes/instance/httpapi/api"
import { Enterprise } from "../enterprise"
import { EnterpriseSigninError } from "./group"

export const enterpriseHandlers = HttpApiBuilder.group(InstanceHttpApi, "enterprise", (handlers) =>
  Effect.gen(function* () {
    const enterprise = yield* Enterprise.Service

    const status = Effect.fn("EnterpriseHttpApi.status")(function* () {
      const cfg = yield* enterprise.settings()
      if (cfg) yield* enterprise.ready()
      const info = yield* enterprise.status()
      const policy = info.policy
      return {
        enabled: cfg !== undefined,
        source: cfg?.source,
        url: cfg?.url || undefined,
        org: cfg?.org ? { slug: cfg.org, name: policy?.org.name } : undefined,
        required: cfg?.required ?? false,
        user: policy ? { email: policy.user.email, role: policy.user.role } : undefined,
        policy: policy && info.fetched ? { version: policy.version, fetched: info.fetched } : undefined,
        blocked: yield* enterprise.blocked(),
        error: info.error ?? cfg?.error,
        gateway: policy?.gateway.providers.map((item) => item.id) ?? [],
        signin: yield* enterprise.signin.pending(),
      }
    })

    const failed = (error: Enterprise.SigninError) =>
      new EnterpriseSigninError({ name: "EnterpriseSigninError", message: error.message })

    return handlers
      .handle("status", () => status())
      .handle(
        "signin",
        Effect.fn("EnterpriseHttpApi.signin")(function* (ctx) {
          const input = { url: ctx.payload.url, org: ctx.payload.org }
          yield* (
            ctx.payload.token
              ? Effect.asVoid(enterprise.signin.token({ ...input, token: ctx.payload.token }))
              : Effect.asVoid(enterprise.signin.start(input))
          ).pipe(Effect.mapError(failed))
          return yield* status()
        }),
      )
      .handle(
        "wait",
        Effect.fn("EnterpriseHttpApi.wait")(function* () {
          yield* enterprise.signin.finish().pipe(Effect.mapError(failed))
          return yield* status()
        }),
      )
      .handle(
        "signout",
        Effect.fn("EnterpriseHttpApi.signout")(function* () {
          yield* enterprise.signout()
          return yield* status()
        }),
      )
  }),
)
