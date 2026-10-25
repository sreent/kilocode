// kilocode_change - new file (organization)
import { afterAll, afterEach, beforeEach, expect } from "bun:test"
import { ConfigProvider, Effect, Layer, ScopedCache } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { ModelsDev } from "@opencode-ai/core/models-dev"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Auth } from "@/auth"
import { GlobalBus } from "@/bus/global"
import { Config } from "@/config/config"
import type { InstanceState } from "@/effect/instance-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Organization } from "@/organization"
import { Provider } from "@/provider/provider"
import { Env } from "../../src/env"
import { Plugin } from "../../src/plugin/index"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { setup } from "../../../organization-server/test/fixture"

// A running client follows the organization policy without a restart: once a refresh brings a
// policy that changes what clients see, the model list is rebuilt and clients are told to refetch.

const cp = await setup({}, { isolated: true })
const http = cp.listen()
const admin = (body: unknown) =>
  fetch(`${http.url}/api/v1/orgs/acme/policy`, {
    method: "PUT",
    headers: { authorization: `Bearer ${cp.owner.token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  })

const member = await cp.join("live@acme.com", "member")

// Each test's services read the environment as it is when they start, like a new CLI process.
beforeEach(() => {
  process.env.KILO_ORG_URL = http.url
  process.env.KILO_ORG = "acme"
  process.env.KILO_ORG_TOKEN = member.token
})
afterEach(async () => {
  await disposeAllInstances()
  delete process.env.KILO_ORG_URL
  delete process.env.KILO_ORG
  delete process.env.KILO_ORG_TOKEN
})
afterAll(async () => {
  await http.stop()
  await cp.runtime.dispose()
})

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      Provider.node,
      Organization.node,
      FSUtil.node,
      Env.node,
      Config.node,
      Auth.node,
      Plugin.node,
      ModelsDev.node,
      RuntimeFlags.node,
    ]),
  ).pipe(
    Layer.provide(
      Layer.effect(
        ConfigProvider.ConfigProvider,
        Effect.sync(() => ConfigProvider.fromEnv()),
      ),
    ),
  ),
)

const custom = ProviderV2.ID.make("custom")

it.instance(
  "followed state is rebuilt, in stage order, only when the policy changes what clients see",
  Effect.gen(function* () {
    expect((yield* Effect.promise(() => admin({}))).status).toBe(200)
    const organization = yield* Organization.Service
    yield* organization.ready()
    const built: string[] = []
    const dropped: string[] = []
    const follow = (name: string, stage: number) =>
      Effect.gen(function* () {
        const cache = yield* ScopedCache.make({
          lookup: (_: string) =>
            Effect.sync(() => void built.push(name)).pipe(
              Effect.andThen(Effect.addFinalizer(() => Effect.sync(() => void dropped.push(name)))),
            ),
          capacity: Number.POSITIVE_INFINITY,
        })
        yield* organization.follow({ cache } as unknown as InstanceState.InstanceState<void>, stage)
        return cache
      })
    // Registered out of order: the config stage must still be dropped before the one built on it.
    const providers = yield* follow("providers", 1)
    const config = yield* follow("config", 0)
    const build = Effect.all([ScopedCache.get(providers, "/work"), ScopedCache.get(config, "/work")])
    yield* build

    // An unchanged policy rebuilds nothing.
    yield* organization.refresh()
    yield* build
    expect(built).toEqual(["providers", "config"])
    expect(dropped).toEqual([])

    expect((yield* Effect.promise(() => admin({ instructions: "Be brief." }))).status).toBe(200)
    yield* organization.refresh()
    expect(dropped).toEqual(["config", "providers"])
    yield* build
    expect(built).toEqual(["providers", "config", "providers", "config"])
  }),
)

it.instance(
  "a policy change reaches the model list of a running client",
  Effect.gen(function* () {
    expect((yield* Effect.promise(() => admin({}))).status).toBe(200)
    const organization = yield* Organization.Service
    yield* organization.ready()
    expect(Object.keys((yield* Provider.use.list())[custom]?.models ?? {}).toSorted()).toEqual(["fast", "smart"])

    const events: string[] = []
    const listener = (event: { payload: { type: string } }) => void events.push(event.payload.type)
    GlobalBus.on("event", listener)
    // Nothing changed: no rebuild, no event.
    yield* organization.refresh()
    expect(events).not.toContain("global.config.updated")

    expect((yield* Effect.promise(() => admin({ models: { blocked: ["custom/smart"] } }))).status).toBe(200)
    yield* organization.refresh()
    GlobalBus.off("event", listener)
    expect(events).toContain("global.config.updated")

    expect(Object.keys((yield* Provider.use.list())[custom].models)).toEqual(["fast"])
    const refused = yield* Provider.use.getModel(custom, ModelV2.ID.make("smart")).pipe(Effect.flip)
    expect(refused.message).toContain("The model custom/smart is not allowed by your organization's policy.")
  }),
  {
    config: {
      // Only this provider, so Kilo's model catalog refresh can't rebuild the list behind the test's back.
      enabled_providers: ["custom"],
      provider: {
        custom: {
          name: "Custom",
          npm: "@ai-sdk/openai-compatible",
          api: "https://llm.example.com/v1",
          models: { fast: { name: "Fast" }, smart: { name: "Smart" } },
          options: { apiKey: "custom-key" },
        },
      },
    },
  },
)
