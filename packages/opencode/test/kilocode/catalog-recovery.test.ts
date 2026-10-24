import { expect } from "bun:test"
import { Effect, Layer, Ref } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { FetchHttpClient } from "effect/unstable/http"
import type { KiloModelsResult } from "@kilocode/kilo-gateway"
import { Auth } from "../../src/auth"
import { ModelCache } from "../../src/provider/model-cache"
import { TestConfig } from "../fixture/config"
import { testInstanceStoreLayer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

type Options = Parameters<ModelCache.KiloModels["fetch"]>[0]
const options = { kilocodeOrganizationId: "org-a", kilocodeToken: "org-token" }
const catalog = {
  models: {
    allowed: {
      id: "allowed",
      name: "Allowed",
      release_date: "",
      attachment: false,
      reasoning: false,
      temperature: true,
      tool_call: true,
      limit: { context: 128000, output: 4096 },
    },
  },
}
const network: KiloModelsResult = { models: {}, error: { kind: "network" } }

function layer(calls: Ref.Ref<Options[]>, results: KiloModelsResult[]) {
  return Layer.fresh(ModelCache.layer).pipe(
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(TestConfig.layer()),
    Layer.provide(Layer.mock(Auth.Service)({ get: () => Effect.succeed(undefined) })),
    Layer.provide(
      Layer.succeed(ModelCache.KiloModelsService, {
        fetch: (options) =>
          Effect.gen(function* () {
            yield* Ref.update(calls, (list) => [...list, options])
            return results.at((yield* Ref.get(calls)).length - 1) ?? results.at(-1)!
          }),
      }),
    ),
  )
}

const it = testEffect(testInstanceStoreLayer)

for (const error of [
  { kind: "unauthorized", status: 401 },
  { kind: "unauthorized", status: 403 },
  { kind: "http", status: 404 },
  { kind: "schema" },
] satisfies NonNullable<KiloModelsResult["error"]>[]) {
  it.effect(`does not retry permanent ${error.kind} ${error.status ?? ""} failures`, () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<Options[]>([])
      yield* ModelCache.Service.use((cache) =>
        Effect.gen(function* () {
          yield* cache.fetch("kilo", options)
          yield* TestClock.adjust("1 hour")
          expect((yield* Ref.get(calls)).length).toBe(1)
          expect(yield* cache.getFailure("kilo")).toEqual(error)
        }),
      ).pipe(Effect.provide(layer(calls, [{ models: {}, error }])))
    }),
  )
}

for (const result of [
  { models: {}, error: { kind: "http", status: 503 } },
  { models: {}, error: { kind: "http", status: 503, retryAfter: 120 } },
  { models: {}, error: { kind: "http", status: 408, retryAfter: 90 } },
  { models: {}, error: { kind: "http", status: 429, retryAfter: 90 } },
  { models: {} },
] satisfies KiloModelsResult[]) {
  it.effect(`recovers ${result.error?.status ?? "empty"} catalogs with the correct delay`, () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<Options[]>([])
      yield* ModelCache.Service.use((cache) =>
        Effect.gen(function* () {
          yield* cache.fetch("kilo", options)
          const seconds = result.error?.retryAfter ?? 30
          yield* TestClock.adjust(`${seconds - 1} seconds`)
          expect((yield* Ref.get(calls)).length).toBe(1)
          yield* TestClock.adjust("1 second")
          expect(yield* cache.get("kilo")).toEqual(catalog.models)
          expect(yield* cache.getFailure("kilo")).toBeUndefined()
        }),
      ).pipe(Effect.provide(layer(calls, [result, catalog])))
    }),
  )
}

it.effect("stops recovering after an unexpected fetch failure instead of retrying it as a network error", () =>
  Effect.gen(function* () {
    const calls = yield* Ref.make<Options[]>([])
    const cache = Layer.fresh(ModelCache.layer).pipe(
      Layer.provide(FetchHttpClient.layer),
      Layer.provide(TestConfig.layer()),
      Layer.provide(Layer.mock(Auth.Service)({ get: () => Effect.succeed(undefined) })),
      Layer.provide(
        Layer.succeed(ModelCache.KiloModelsService, {
          fetch: (options) =>
            Effect.gen(function* () {
              yield* Ref.update(calls, (list) => [...list, options])
              if ((yield* Ref.get(calls)).length === 1) return network
              return yield* Effect.fail(new Error("unexpected"))
            }),
        }),
      ),
    )
    yield* ModelCache.Service.use((service) =>
      Effect.gen(function* () {
        yield* service.fetch("kilo", options)
        yield* TestClock.adjust("30 seconds")
        expect((yield* Ref.get(calls)).length).toBe(2)
        yield* TestClock.adjust("1 hour")
        expect((yield* Ref.get(calls)).length).toBe(2)
      }),
    ).pipe(Effect.provide(cache))
  }),
)

it.effect("isolates account switches, reselected failed cells and cache clearing", () =>
  Effect.gen(function* () {
    const calls = yield* Ref.make<Options[]>([])
    const next = { ...options, kilocodeOrganizationId: "org-b", kilocodeToken: "other-token" }
    yield* ModelCache.Service.use((cache) =>
      Effect.gen(function* () {
        yield* cache.fetch("kilo", options)
        expect(yield* cache.fetch("kilo", next)).toEqual(catalog.models)
        yield* TestClock.adjust("30 seconds")
        expect(yield* Ref.get(calls)).toEqual([options, next])
        expect(yield* cache.fetch("kilo", options)).toEqual({})
        yield* TestClock.adjust("30 seconds")
        expect(yield* cache.get("kilo")).toEqual(catalog.models)
        // A warm catalog from the previous account must not suppress this failed fetch.
        expect(yield* cache.refresh("kilo", next)).toEqual({})
        yield* cache.clear("kilo")
        yield* TestClock.adjust("1 hour")
        expect(yield* Ref.get(calls)).toEqual([options, next, options, next])
        expect(yield* cache.get("kilo")).toBeUndefined()
      }),
    ).pipe(Effect.provide(layer(calls, [network, catalog, catalog, network])))
  }),
)
