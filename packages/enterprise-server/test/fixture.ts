import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { sql } from "drizzle-orm"
import { Context, Effect, Layer, ManagedRuntime, References } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import type { Role } from "@enterprise/protocol/schema"
import { App } from "../src/app"
import { bootstrap } from "../src/bootstrap"
import { ServerConfig } from "../src/config"
import { Database } from "../src/db/database"
import { Pricing } from "../src/pricing"
import { RequestContext } from "../src/request"
import { ConsoleAssets, node as consoleAssets } from "../src/routes/console"
import { Store } from "../src/store"

export const base = "http://localhost:8787"

// Model prices the gateway tests are metered with, in models.dev's shape (USD per million tokens).
export const prices = {
  anthropic: {
    models: {
      "claude-sonnet-4": { cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 } },
    },
  },
  openai: { models: { "gpt-5": { cost: { input: 1.25, output: 10, cache_read: 0.125 } } } },
  together: { models: { "llama-4": { cost: { input: 0.2, output: 0.6 } } } },
}

// The store with every Effect-returning function turned into a Promise, for test setup and assertions.
type Promised<T> = {
  readonly [K in keyof T]: T[K] extends (...args: infer A) => Effect.Effect<infer R, infer _E, infer _R>
    ? (...args: A) => Promise<R>
    : T[K] extends (...args: infer A) => infer R
      ? (...args: A) => R
      : Promised<T[K]>
}

function promised<T extends object>(target: T, run: <A>(effect: Effect.Effect<A, unknown>) => Promise<A>): Promised<T> {
  return new Proxy(target, {
    get(object, key) {
      const value: unknown = Reflect.get(object, key)
      if (typeof value === "function")
        return (...args: unknown[]) => {
          const result: unknown = value(...args)
          return Effect.isEffect(result) ? run(result as Effect.Effect<unknown, unknown>) : result
        }
      if (value && typeof value === "object") return promised(value, run)
      return value
    },
  }) as Promised<T>
}

// A tiny stand-in for the console build, so routing and headers are tested without building it.
const assets = (() => {
  const dir = mkdtempSync(path.join(tmpdir(), "enterprise-console-"))
  mkdirSync(path.join(dir, "assets"))
  writeFileSync(
    path.join(dir, "index.html"),
    `<!doctype html><script type="module" src="/admin/assets/index.js"></script>`,
  )
  writeFileSync(path.join(dir, "assets/index.js"), "export {}")
  return dir
})()

export async function setup(overrides: Partial<ServerConfig.Info> = {}) {
  const config: ServerConfig.Info = {
    base,
    secret: "test-secret",
    proxy: false,
    retention: undefined,
    txt: () => Effect.succeed([]),
    models: undefined,
    ...overrides,
  }
  // One memo map for the web handler and the test runtime, so both see the same in-memory database.
  const memoMap = Layer.makeMemoMapUnsafe()
  const services = LayerNode.compile(App.services, [
    [Database.node, Database.layerFromPath(":memory:")],
    [ServerConfig.node, ServerConfig.Service.configLayer(config)],
    [consoleAssets, ConsoleAssets.fromDirectory(assets)],
    [Pricing.node, Pricing.Service.fromCatalog(prices)],
  ])
  const runtime = ManagedRuntime.make(services, { memoMap })
  // Expected rejections log warnings; keep test output to real problems.
  const quiet = Layer.succeed(References.MinimumLogLevel, "Error")
  const { handler } = App.webHandler(App.routes(services).pipe(Layer.provide(quiet)), { memoMap })
  const run = <A>(effect: Effect.Effect<A, unknown, Store.Service | Database.Service>) => runtime.runPromise(effect)
  const store = promised(
    await run(
      Effect.gen(function* () {
        return yield* Store.Service
      }),
    ),
    run,
  )
  const peer = Context.make(RequestContext.Peer, "203.0.113.7")

  const server = {
    request: (route: string, init?: RequestInit) => handler(new Request(`${base}${route}`, init), peer),
  }
  const call = async (
    method: string,
    route: string,
    opts: { token?: string; body?: unknown; headers?: Record<string, string> } = {},
  ) => {
    const res = await server.request(route, {
      method,
      headers: {
        ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
        ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
        ...opts.headers,
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    })
    const text = await res.text()
    const data = text && res.headers.get("content-type")?.includes("json") ? JSON.parse(text) : text
    return { status: res.status, data, headers: res.headers }
  }
  // Raw SQL against the test database, for states the API cannot reach (such as a fresh poll window).
  const exec = (statement: string) =>
    run(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* db.run(sql.raw(statement))
      }).pipe(Effect.orDie),
    )
  const owner = await run(bootstrap({ org: "Acme", slug: "acme", email: "owner@acme.com", name: "Olive Owner" }))
  // Adds a member with a role and returns a CLI token for them.
  const join = async (email: string, role: Role, org = owner.org.id) => {
    const user = await store.user.ensure({ email })
    await store.member.add(org, user.id, role)
    return { user, token: (await store.token.issue({ kind: "user", user: user.id, org, name: "test" })).value }
  }
  // A real listening server, for clients that speak HTTP (the CLI's contract tests).
  const listen = () => {
    const bun = Bun.serve({ port: 0, fetch: (request) => handler(request, peer) })
    return { url: `http://localhost:${bun.port}`, stop: () => bun.stop(true) }
  }
  return { store, config, server, call, owner, join, exec, listen, runtime }
}

export type Env = Awaited<ReturnType<typeof setup>>
