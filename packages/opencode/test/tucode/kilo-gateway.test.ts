// kilocode_change - new file (tucode)
import { afterEach, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Flag } from "@opencode-ai/core/flag/flag"
import * as Log from "@opencode-ai/core/util/log"
import { Auth } from "../../src/auth"
import { ModelCache } from "../../src/provider/model-cache"
import { Server } from "../../src/server/server"
import { blocked } from "../../src/tucode/guard"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"
import { resetDatabase } from "../fixture/db"
import { testEffectShared } from "../lib/effect"

const it = testEffectShared(Layer.merge(AppNodeBuilder.build(ModelCache.node), AppNodeBuilder.build(Auth.node)))

void Log.init({ print: false })

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

function request(path: string, dir: string) {
  return Effect.promise(async () => {
    const result = await Server.Default().app.request(path, { headers: { "x-kilo-directory": dir } })
    expect(result.status).toBe(200)
    return result.json() as Promise<{ all: { id: string }[]; connected: string[] }>
  })
}

// tucode has no Kilo Gateway: even with Kilo credentials, a Kilo organization and the provider enabled
// in config, no "kilo" provider is listed and nothing asks Kilo for its models. (Features that need a Kilo
// sign-in may still try Kilo's other endpoints when such credentials are injected; the network guard
// refuses those in the product.)
it.live("never lists the Kilo Gateway or fetches its catalog", () =>
  Effect.gen(function* () {
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        const previous = Flag.KILO_DISABLE_MODELS_FETCH
        Flag.KILO_DISABLE_MODELS_FETCH = true
        return previous
      }),
      (previous) =>
        Effect.sync(() => {
          Flag.KILO_DISABLE_MODELS_FETCH = previous
        }),
    )
    const cache = yield* ModelCache.Service
    yield* cache.clear("kilo")
    const env = {
      KILO_AUTH_CONTENT: process.env.KILO_AUTH_CONTENT,
      KILO_API_KEY: process.env.KILO_API_KEY,
      KILO_ORG_ID: process.env.KILO_ORG_ID,
    }
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        process.env.KILO_AUTH_CONTENT = JSON.stringify({
          kilo: { type: "oauth", access: "test-token", refresh: "test-refresh", expires: 0, accountId: "org-oauth" },
        })
        process.env.KILO_API_KEY = "test-key"
        process.env.KILO_ORG_ID = "org-env"
      }),
      () =>
        Effect.sync(() => {
          for (const [key, value] of Object.entries(env)) {
            if (value === undefined) delete process.env[key]
            else process.env[key] = value
          }
        }),
    )
    const kilo: string[] = []
    const original = globalThis.fetch
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        globalThis.fetch = Object.assign(
          async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
            if (blocked(url)) {
              kilo.push(url)
              return new Response(null, { status: 500 })
            }
            return original(input, init)
          },
          { preconnect: original.preconnect },
        )
      }),
      () =>
        Effect.sync(() => {
          globalThis.fetch = original
        }),
    )
    const tmp = yield* Effect.acquireRelease(
      Effect.promise(() =>
        tmpdir({
          config: {
            formatter: false,
            lsp: false,
            enabled_providers: ["kilo", "external"],
            provider: {
              kilo: { options: { kilocodeOrganizationId: "org-config" } },
              external: {
                npm: "@ai-sdk/openai-compatible",
                options: { apiKey: "external-test-key" },
                models: { independent: { name: "Independent", limit: { context: 128000, output: 4096 } } },
              },
            },
          },
        }),
      ),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    )
    const providers = yield* request("/provider", tmp.path)
    expect(providers.all.map((item) => item.id)).not.toContain("kilo")
    expect(providers.connected).not.toContain("kilo")
    expect(providers.connected).toContain("external")
    expect(kilo.filter((url) => new URL(url).pathname.endsWith("/models"))).toEqual([])
  }),
)
