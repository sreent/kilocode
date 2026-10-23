import { Effect } from "effect"
import { HttpApiBuilder, HttpApiSchema } from "effect/unstable/httpapi"
import { Api } from "@enterprise/protocol/api"
import { InvalidRequestError, NotFoundError } from "@enterprise/protocol/errors"
import { Membership } from "@enterprise/protocol/middleware"
import * as Crypto from "../crypto"
import { ServerConfig } from "../config"
import { RequestContext } from "../request"
import { Store, type GatewayProvider } from "../store"

// Admins see a provider's key only as its last characters, and only when the key is long enough
// that those give nothing away.
export const hint = (key: string) => (key.length >= 16 ? key.slice(-4) : "")

const view = (row: GatewayProvider) => ({
  id: row.id,
  kind: row.kind,
  base: row.base,
  hint: row.hint,
  created: row.created,
  updated: row.updated,
})

export const GatewayHandler = HttpApiBuilder.group(Api, "enterprise.gateway", (handlers) =>
  Effect.gen(function* () {
    const store = yield* Store.Service
    const config = yield* ServerConfig.Service
    const audit = RequestContext.auditor(store, config)

    return handlers
      .handle(
        "gateway.get",
        Effect.fn(function* () {
          const scope = yield* Membership
          return { url: `${config.base}/gateway`, providers: (yield* store.gateway.list(scope.org.id)).map(view) }
        }),
      )
      .handle(
        "gateway.set",
        Effect.fn(function* (ctx) {
          const scope = yield* Membership
          if (!config.secret)
            return yield* new InvalidRequestError({
              message: "set ENTERPRISE_SECRET on the server before adding gateway providers",
            })
          const current = yield* store.gateway.get(scope.org.id, ctx.params.id)
          const key = ctx.payload.key?.trim()
          if (!current && !key) return yield* new InvalidRequestError({ message: "key is required" })
          const row = yield* store.gateway.set(scope.org.id, ctx.params.id, {
            kind: ctx.payload.kind,
            base: ctx.payload.base.replace(/\/+$/, ""),
            secret: key ? yield* Crypto.seal(config.secret, key) : current!.secret,
            hint: key ? hint(key) : current!.hint,
          })
          yield* audit(current ? "gateway.provider_update" : "gateway.provider_create", row!.id, {
            kind: row!.kind,
            base: row!.base,
            key_rotated: current !== undefined && key !== undefined,
          })
          return view(row!)
        }),
      )
      .handle(
        "gateway.remove",
        Effect.fn(function* (ctx) {
          const scope = yield* Membership
          if (!(yield* store.gateway.remove(scope.org.id, ctx.params.id)))
            return yield* new NotFoundError({ message: "gateway provider not found" })
          yield* audit("gateway.provider_remove", ctx.params.id)
          return HttpApiSchema.NoContent.make()
        }),
      )
  }),
)
