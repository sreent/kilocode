export * as Database from "./database"

import { EffectDrizzleSqlite } from "@opencode-ai/effect-drizzle-sqlite"
import { layer as sqliteLayer } from "@opencode-ai/core/database/sqlite.bun"
import { Config, Context, Effect, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { mkdirSync } from "node:fs"
import path from "node:path"
import { DatabaseMigration } from "./migration"

const makeDatabase = EffectDrizzleSqlite.makeWithDefaults()
type DatabaseShape = Effect.Success<typeof makeDatabase>

export interface Interface {
  readonly db: DatabaseShape
}

export class Service extends Context.Service<Service, Interface>()("@enterprise/Database") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = yield* makeDatabase
    // Same connection settings as core's database: wait out lock contention, then WAL.
    yield* db.run("PRAGMA busy_timeout = 5000")
    yield* db.run("PRAGMA journal_mode = WAL")
    yield* db.run("PRAGMA synchronous = NORMAL")
    yield* db.run("PRAGMA foreign_keys = ON")
    yield* DatabaseMigration.apply(db)
    return { db }
  }).pipe(Effect.orDie),
)

export function layerFromPath(filename: string) {
  if (filename !== ":memory:") mkdirSync(path.dirname(path.resolve(filename)), { recursive: true })
  return layer.pipe(Layer.provide(sqliteLayer({ filename, disableWAL: true })))
}

// ENTERPRISE_DB is read when the layer builds, so tests and embedders can replace the node instead.
export const node = LayerNode.make({
  service: Service,
  layer: Layer.unwrap(
    Effect.gen(function* () {
      return layerFromPath(yield* Config.string("ENTERPRISE_DB").pipe(Config.withDefault("./data/enterprise.db")))
    }),
  ),
  deps: [],
})
