import { Effect } from "effect"
import { define } from "../internal"
import { ProviderV2 } from "../../provider" // kilocode_change
import { Brand } from "../../tucode/brand" // kilocode_change - tucode

export const ZenmuxPlugin = define({
  id: "zenmux",
  effect: Effect.fn(function* (ctx) {
    yield* ctx.catalog.transform(
      Effect.fn(function* (evt) {
        for (const item of evt.provider.list()) {
          if (item.provider.api.type !== "aisdk") continue
          if (item.provider.api.package !== "@ai-sdk/openai-compatible") continue
          if (item.provider.api.url !== "https://zenmux.ai/api/v1") continue
          if (item.provider.id !== ProviderV2.ID.make("zenmux")) continue // kilocode_change
          evt.provider.update(item.provider.id, (provider) => {
            provider.request.headers["HTTP-Referer"] ??= Brand.repository // kilocode_change - tucode
            provider.request.headers["X-Title"] ??= Brand.name // kilocode_change - tucode
          })
        }
      }),
    )
  }),
})
