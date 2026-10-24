export * as Database from "./database"

import { PgClient } from "@effect/sql-pg"
import * as PgDrizzle from "drizzle-orm/effect-postgres"
import { Config, Context, Effect, Layer, Option, Redacted } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import path from "node:path"
import { Embedded } from "./embedded"
import { Legacy } from "./legacy"
import { DatabaseMigration } from "./migration"

const makeDatabase = PgDrizzle.makeWithDefaults()
export type Db = Effect.Success<typeof makeDatabase>

export interface Interface {
  readonly db: Db
}

export class Service extends Context.Service<Service, Interface>()("@organization/Database") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = yield* makeDatabase
    yield* DatabaseMigration.apply(db)
    return { db }
  }).pipe(Effect.orDie),
)

/** A Postgres server. Every replica of the control plane can share it. */
export function layerFromUrl(url: string, connections = 10) {
  return layer.pipe(Layer.provide(PgClient.layer({ url: Redacted.make(url), maxConnections: connections })))
}

/** Postgres embedded in this process, with its files in `dir`; in memory without one. One server only. */
export function layerEmbedded(dir: string | undefined) {
  return layer.pipe(Layer.provide(Embedded.layer(dir)))
}

/** Over a Postgres client the caller provides, such as one for a PGlite database it keeps open. */
export function layerFrom<E>(client: Layer.Layer<PgClient.PgClient, E>) {
  return layer.pipe(Layer.provide(client))
}

// Read when the layer builds, so tests and embedders can replace the node instead. On an empty
// database, the server first copies in what it kept before: the embedded database when it now has a
// Postgres server, then the SQLite file (ORGANIZATION_DB) of servers from before Postgres.
export const node = LayerNode.make({
  service: Service,
  layer: Layer.unwrap(
    Effect.gen(function* () {
      const env = yield* Config.all({
        url: Config.string("ORGANIZATION_DATABASE_URL").pipe(Config.option),
        pool: Config.int("ORGANIZATION_DATABASE_POOL").pipe(Config.withDefault(10)),
        data: Config.string("ORGANIZATION_DATA").pipe(Config.withDefault("./data")),
        legacy: Config.string("ORGANIZATION_DB").pipe(Config.option),
      })
      const base = Option.match(env.url, {
        onSome: (url) => layerFromUrl(url, env.pool),
        onNone: () => layerEmbedded(path.join(env.data, "postgres")),
      })
      const legacy = Option.getOrElse(env.legacy, () => path.join(env.data, "enterprise.db"))
      const copy = Layer.effectDiscard(
        Effect.gen(function* () {
          const db = (yield* Service).db
          // A single server moving to a Postgres server brings its embedded database along.
          if (Option.isSome(env.url)) yield* Legacy.embedded(db, path.join(env.data, "postgres"))
          yield* Legacy.copy(db, legacy)
        }).pipe(Effect.orDie),
      )
      return copy.pipe(Layer.provideMerge(base))
    }),
  ),
  deps: [],
})
