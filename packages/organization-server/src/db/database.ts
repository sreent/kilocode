export * as Database from "./database"

import { PgClient } from "@effect/sql-pg"
import * as PgDrizzle from "drizzle-orm/effect-postgres"
import { Config, Context, Effect, Layer, Option, Redacted } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import path from "node:path"
import { Backup } from "./backup"
import { Embedded } from "./embedded"
import { Legacy } from "./legacy"
import { DatabaseMigration } from "./migration"

const makeDatabase = PgDrizzle.makeWithDefaults()
export type Db = Effect.Success<typeof makeDatabase>

export interface Interface {
  readonly db: Db
  // A copy of the embedded database's files to back up. A Postgres server has its own backup tools.
  readonly snapshot: Effect.Effect<Uint8Array, Backup.BackupError> | undefined
}

export class Service extends Context.Service<Service, Interface>()("@organization/Database") {}

// With `backups`, an embedded database that an upgrade is about to migrate is backed up there first.
const make = (backups?: string) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const db = yield* makeDatabase
      const snapshot = Option.getOrUndefined(yield* Effect.serviceOption(Embedded.Snapshot))
      const pending = snapshot && backups ? yield* DatabaseMigration.pending(db) : []
      if (snapshot && backups && pending.length > 0)
        yield* snapshot.pipe(
          Effect.flatMap((tar) => Backup.write(backups, tar, "before-upgrade")),
          Effect.flatMap((target) =>
            Effect.logInfo("backed up the database before upgrading it").pipe(
              Effect.annotateLogs({ backup: target, migrations: pending.join(", ") }),
            ),
          ),
          // Migrations run in one transaction either way; an upgrade isn't held up for want of a backup.
          Effect.catch((error) =>
            Effect.logError("upgrading the database without a backup").pipe(
              Effect.annotateLogs({ error: error.message }),
            ),
          ),
        )
      yield* DatabaseMigration.apply(db)
      return { db, snapshot }
    }).pipe(Effect.orDie),
  )
const layer = make()

/** A Postgres server. Every replica of the control plane can share it. */
export function layerFromUrl(url: string, connections = 10) {
  return layer.pipe(Layer.provide(PgClient.layer({ url: Redacted.make(url), maxConnections: connections })))
}

/**
 * Postgres embedded in this process, with its files in `dir`; in memory without one. One server only.
 * With `backups`, upgrades back it up there before they migrate it.
 */
export function layerEmbedded(dir: string | undefined, backups?: string) {
  return make(backups).pipe(Layer.provide(Embedded.layer(dir)))
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
        backup: Backup.settings,
      })
      const base = Option.match(env.url, {
        onSome: (url) => layerFromUrl(url, env.pool),
        onNone: () => layerEmbedded(path.join(env.data, "postgres"), env.backup.dir),
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
