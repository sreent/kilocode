export * as DatabaseMigration from "./migration"

import { sql } from "drizzle-orm"
import { Effect } from "effect"
import type { Database } from "./database"
import { migrations } from "./migration.gen"

// Generated from the Drizzle schema by `bun run migration`, append-only, each applied once.
export type Migration = {
  id: string
  up: (tx: { run: (statement: string) => Effect.Effect<unknown, unknown> }) => Effect.Effect<void, unknown>
}

export function apply(db: Database.Db, input: ReadonlyArray<Migration> = migrations) {
  // Replicas may start together: one applies what is missing, in one transaction, while the others
  // wait on the lock and then find nothing left to do.
  return db.transaction(() =>
    Effect.gen(function* () {
      yield* db.execute(sql`SELECT pg_advisory_xact_lock(hashtext('kilo-organization:migrations'))`)
      yield* db.execute(
        sql`CREATE TABLE IF NOT EXISTS ${sql.identifier("migration")} (id TEXT PRIMARY KEY, time_completed BIGINT NOT NULL)`,
      )
      const rows = yield* db.execute<{ id: string }>(sql`SELECT id FROM ${sql.identifier("migration")}`)
      const done = new Set(rows.map((row) => row.id))
      for (const migration of input) {
        if (done.has(migration.id)) continue
        yield* migration.up({ run: (statement) => db.execute(sql.raw(statement)) })
        yield* db.execute(
          sql`INSERT INTO ${sql.identifier("migration")} (id, time_completed) VALUES (${migration.id}, ${Date.now()})`,
        )
      }
    }),
  )
}

/** The migrations an existing database still needs; none for a new one, which has nothing to lose. */
export function pending(db: Database.Db, input: ReadonlyArray<Migration> = migrations) {
  return Effect.gen(function* () {
    const found = yield* db.execute<{ found: boolean }>(sql`SELECT to_regclass('migration') IS NOT NULL AS found`)
    if (!found[0]?.found) return []
    const rows = yield* db.execute<{ id: string }>(sql`SELECT id FROM ${sql.identifier("migration")}`)
    const done = new Set(rows.map((row) => row.id))
    return input.filter((migration) => !done.has(migration.id)).map((migration) => migration.id)
  })
}
