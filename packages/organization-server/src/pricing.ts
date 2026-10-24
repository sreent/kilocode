export * as Pricing from "./pricing"

import { Clock, Context, Effect, Layer, Option, Schema, Semaphore } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ServerConfig } from "./config"
import { httpClient } from "./oidc"

// Prices for calls the gateway meters, from a models.dev-style catalog: the same source and the
// same arithmetic clients use, so gateway-metered and client-reported spend agree.

const Rate = Schema.Struct({
  input: Schema.Finite,
  output: Schema.Finite,
  cache_read: Schema.optional(Schema.Finite),
  cache_write: Schema.optional(Schema.Finite),
})

// Prices per million tokens.
export const Cost = Schema.Struct({
  ...Rate.fields,
  tiers: Schema.optional(
    Schema.Array(
      Schema.Struct({ ...Rate.fields, tier: Schema.Struct({ type: Schema.Literal("context"), size: Schema.Finite }) }),
    ),
  ),
  context_over_200k: Schema.optional(Rate),
})
export type Cost = typeof Cost.Type

// Input and output exclude cache and reasoning tokens, as in usage records.
export type Tokens = {
  readonly input: number
  readonly output: number
  readonly reasoning: number
  readonly read: number
  readonly write: number
}

// Mirrors the CLI's Session.getUsage: the context tier is chosen by the whole prompt, and
// reasoning is charged at the output rate.
export function price(cost: Cost | undefined, tokens: Tokens) {
  if (!cost) return 0
  const context = tokens.input + tokens.read + tokens.write
  const rate =
    cost.tiers
      ?.filter((item) => item.tier.type === "context" && context > item.tier.size)
      .sort((a, b) => b.tier.size - a.tier.size)[0] ??
    (cost.context_over_200k && context > 200_000 ? cost.context_over_200k : cost)
  const total =
    tokens.input * rate.input +
    (tokens.output + tokens.reasoning) * rate.output +
    tokens.read * (rate.cache_read ?? 0) +
    tokens.write * (rate.cache_write ?? 0)
  return Number.isFinite(total) ? Math.max(0, total / 1_000_000) : 0
}

// "provider/model" -> cost. Entries that don't decode are skipped, so one bad model in a large
// third-party catalog can't take pricing down.
export type Catalog = ReadonlyMap<string, Cost>

const decodeCost = Schema.decodeUnknownOption(Cost)

export function catalog(data: unknown): Catalog {
  const result = new Map<string, Cost>()
  if (!data || typeof data !== "object") return result
  for (const [provider, entry] of Object.entries(data)) {
    const models = (entry as { models?: unknown } | null)?.models
    if (!models || typeof models !== "object") continue
    for (const [model, info] of Object.entries(models)) {
      const cost = decodeCost((info as { cost?: unknown } | null)?.cost)
      if (Option.isSome(cost)) result.set(`${provider}/${model}`, cost.value)
    }
  }
  return result
}

export interface Interface {
  // What a call cost, or 0 when the model has no price.
  readonly cost: (provider: string, model: string, tokens: Tokens) => Effect.Effect<number>
  // Reloads the catalog; on failure the previous one stays in use.
  readonly refresh: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@organization/Pricing") {
  // A fixed catalog, for tests and air-gapped deployments wired in code.
  static fromCatalog(data: unknown) {
    const prices = catalog(data)
    return Layer.succeed(
      this,
      this.of({
        cost: (provider, model, tokens) => Effect.succeed(price(prices.get(`${provider}/${model}`), tokens)),
        refresh: () => Effect.void,
      }),
    )
  }
}

const day = 24 * 60 * 60 * 1000
const minute = 60 * 1000

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* ServerConfig.Service
    const http = yield* HttpClient.HttpClient
    const lock = yield* Semaphore.make(1)
    const state: { prices: Catalog; loaded?: number; tried?: number } = { prices: new Map() }

    // An http(s) URL, or a path to a local copy of the catalog.
    const download = (source: string) =>
      /^https?:\/\//.test(source)
        ? http
            .execute(HttpClientRequest.get(source).pipe(HttpClientRequest.acceptJson))
            .pipe(
              Effect.flatMap((response) =>
                response.status === 200 ? response.json : Effect.fail(new Error(`HTTP ${response.status}`)),
              ),
            )
        : Effect.tryPromise(() => Bun.file(source).json())

    const load = Effect.fn("Pricing.load")(function* (force: boolean) {
      const source = config.models
      if (!source) return
      const time = yield* Clock.currentTimeMillis
      // Retry a failed download after a few minutes rather than on every call.
      if (!force && state.loaded !== undefined && time - state.loaded < day) return
      if (!force && state.tried !== undefined && time - state.tried < 5 * minute) return
      state.tried = time
      const result = yield* download(source).pipe(Effect.timeout("30 seconds"), Effect.result)
      if (result._tag === "Failure") {
        yield* Effect.logWarning("could not load model prices; gateway calls are priced from the last catalog").pipe(
          Effect.annotateLogs({ source, error: String(result.failure) }),
        )
        return
      }
      const prices = catalog(result.success)
      state.prices = prices
      state.loaded = time
      yield* Effect.logInfo("loaded model prices").pipe(Effect.annotateLogs({ source, models: prices.size }))
    })

    const cost = Effect.fn("Pricing.cost")(function* (provider: string, model: string, tokens: Tokens) {
      yield* lock.withPermit(load(false))
      return price(state.prices.get(`${provider}/${model}`), tokens)
    })

    return Service.of({ cost, refresh: () => lock.withPermit(load(true)) })
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [ServerConfig.node, httpClient] })
