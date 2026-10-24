export * as Legacy from "./legacy"

import { Database as Sqlite } from "bun:sqlite"
import { getColumns, getTableName, sql } from "drizzle-orm"
import * as PgDrizzle from "drizzle-orm/effect-postgres"
import type { PgTable } from "drizzle-orm/pg-core"
import { Effect } from "effect"
import { existsSync } from "node:fs"
import path from "node:path"
import type { Database } from "./database"
import { Embedded } from "./embedded"
import { DatabaseMigration } from "./migration"
import {
  AssertionTable,
  AuditTable,
  BudgetTable,
  DeviceTable,
  DomainTable,
  GatewayProviderTable,
  GroupMemberTable,
  GroupTable,
  InviteTable,
  LoginTable,
  MemberTable,
  ModeTable,
  OrgTable,
  PolicyTable,
  SsoTable,
  StreamTable,
  TokenTable,
  UsageTable,
  UserTable,
} from "./schema.sql"

// Where a server's data was before the database it starts on now: the SQLite file servers kept before
// Postgres, or the embedded database of a server now pointed at a Postgres server. The first time a
// server starts on an empty database and finds one, it copies every row across, keeping ids (audit
// streams resume from audit ids), and leaves the original as it was.

// Parents before children, so every foreign key finds its row.
const tables: ReadonlyArray<PgTable> = [
  OrgTable,
  UserTable,
  MemberTable,
  InviteTable,
  GroupTable,
  GroupMemberTable,
  DomainTable,
  TokenTable,
  DeviceTable,
  SsoTable,
  AssertionTable,
  LoginTable,
  PolicyTable,
  ModeTable,
  AuditTable,
  UsageTable,
  BudgetTable,
  GatewayProviderTable,
  StreamTable,
]

// SQLite stored booleans as 0/1 and JSON as text.
function convert(table: PgTable, row: Record<string, unknown>) {
  const columns = getColumns(table)
  const out: Record<string, unknown> = {}
  for (const [key, column] of Object.entries(columns)) {
    if (!(column.name in row)) continue
    const value = row[column.name]
    if (value === null || value === undefined) out[key] = null
    else if (column.columnType === "PgBoolean") out[key] = Boolean(value)
    else if (column.columnType === "PgJsonb") out[key] = typeof value === "string" ? JSON.parse(value) : value
    else out[key] = value
  }
  return out
}

const empty = (db: Database.Db) =>
  db
    .execute<{ n: number }>(sql`select count(*)::int as n from ${OrgTable}`)
    .pipe(Effect.map(([row]) => (row?.n ?? 0) === 0))

// Every table's rows into an empty database, in one transaction; undefined if it wasn't empty.
const fill = <E>(db: Database.Db, read: (table: PgTable) => Effect.Effect<ReadonlyArray<Record<string, unknown>>, E>) =>
  db.transaction(() =>
    Effect.gen(function* () {
      // Replicas starting together on the same data: one copies, the others then find it done.
      yield* db.execute(sql`select pg_advisory_xact_lock(hashtext('kilo-organization:store'))`)
      if (!(yield* empty(db))) return undefined
      let total = 0
      for (const table of tables) {
        const rows = yield* read(table)
        // Batches stay well under Postgres's 65,535 parameters per statement.
        for (let i = 0; i < rows.length; i += 500) yield* db.insert(table).values(rows.slice(i, i + 500))
        total += rows.length
      }
      // Copied audit ids keep their values; new ones continue after them.
      yield* db.execute(
        sql`select setval(pg_get_serial_sequence('audit', 'id'), coalesce((select max(id) from audit), 0) + 1, false)`,
      )
      return total
    }),
  )

export const copy = Effect.fn("Legacy.copy")(function* (db: Database.Db, file: string) {
  if (!existsSync(file) || !(yield* empty(db))) return
  const source = new Sqlite(file, { readonly: true })
  const present = new Set(
    source
      .query<{ name: string }, []>("select name from sqlite_master where type = 'table'")
      .all()
      .map((row) => row.name),
  )
  const copied = yield* fill(db, (table) =>
    Effect.sync(() => {
      const name = getTableName(table)
      if (!present.has(name)) return []
      return source
        .query<Record<string, unknown>, []>(`select * from "${name}"`)
        .all()
        .map((row) => convert(table, row))
    }),
  ).pipe(Effect.ensuring(Effect.sync(() => source.close())))
  if (copied === undefined) return
  yield* Effect.logInfo("copied the SQLite database into Postgres").pipe(Effect.annotateLogs({ file, rows: copied }))
})

export const embedded = Effect.fn("Legacy.embedded")(function* (db: Database.Db, dir: string) {
  if (!existsSync(path.join(dir, "PG_VERSION")) || !(yield* empty(db))) return
  const copied = yield* Effect.gen(function* () {
    const source = yield* PgDrizzle.makeWithDefaults()
    // At this version's schema first, as the server would open it, so the columns match.
    yield* DatabaseMigration.apply(source)
    return yield* fill(db, (table) => source.select().from(table))
  }).pipe(Effect.provide(Embedded.layer(dir)))
  if (copied === undefined) return
  yield* Effect.logInfo("copied the embedded database into the Postgres server").pipe(
    Effect.annotateLogs({ dir, rows: copied }),
  )
})
