import { Effect } from "effect"
import { define } from "../internal"
import { ProviderV2 } from "../../provider" // kilocode_change
import { Brand } from "../../tucode/brand" // kilocode_change - tucode

export const VercelPlugin = define({
  id: "vercel",
  effect: Effect.fn(function* (ctx) {
    yield* ctx.catalog.transform(
      Effect.fn(function* (evt) {
        for (const item of evt.provider.list()) {
          if (item.provider.api.type !== "aisdk") continue
          if (item.provider.api.package !== "@ai-sdk/vercel") continue
          if (item.provider.id !== ProviderV2.ID.make("vercel")) continue // kilocode_change
          evt.provider.update(item.provider.id, (provider) => {
            provider.request.headers["http-referer"] = Brand.repository // kilocode_change - tucode
            provider.request.headers["x-title"] = Brand.name // kilocode_change - tucode
          })
        }
      }),
    )
    yield* ctx.aisdk.sdk(
      Effect.fn(function* (evt) {
        if (evt.package !== "@ai-sdk/vercel") return
        const mod = yield* Effect.promise(() => import("@ai-sdk/vercel"))
        evt.sdk = mod.createVercel(evt.options)
      }),
    )
  }),
})
