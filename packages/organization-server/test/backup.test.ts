import { afterAll, expect, test } from "bun:test"
import { PgClient } from "@effect/sql-pg"
import { sql } from "drizzle-orm"
import * as PgDrizzle from "drizzle-orm/effect-postgres"
import { Cause, ConfigProvider, Context, Effect, Exit, Layer } from "effect"
import fs from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Backups } from "../src/backups"
import { Backup } from "../src/db/backup"
import { Database } from "../src/db/database"
import { Embedded } from "../src/db/embedded"
import { DatabaseMigration } from "../src/db/migration"
import { migrations } from "../src/db/migration.gen"

const root = fs.mkdtempSync(path.join(tmpdir(), "organization-backup-"))
afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

const place = (name: string) => ({ dir: path.join(root, name, "postgres"), backups: path.join(root, name, "backups") })
const insert = (id: string) =>
  sql`insert into orgs (id, name, slug, settings, created) values (${id}, ${id}, ${id}, '{}', 1)`
const orgs = (db: Database.Db) =>
  db.execute<{ id: string }>(sql`select id from orgs order by id`).pipe(Effect.map((rows) => rows.map((row) => row.id)))
const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)

// The database and backups the way the server builds them, with backup settings from `env`.
const server = (where: ReturnType<typeof place>, env: Record<string, string> = {}) =>
  Layer.build(Backups.layer.pipe(Layer.provideMerge(Database.layerEmbedded(where.dir, where.backups)))).pipe(
    Effect.map((context) => ({
      ...Context.get(context, Database.Service),
      backups: Context.get(context, Backups.Service),
    })),
    Effect.provideService(
      ConfigProvider.ConfigProvider,
      ConfigProvider.fromEnv({ env: { ORGANIZATION_BACKUP_DIR: where.backups, ...env } }),
    ),
  )

test("the server backs up when one is due, keeps the newest, and a restore brings back that moment", async () => {
  const where = place("schedule")
  const middle = await run(
    Effect.scoped(
      Effect.gen(function* () {
        const { db, backups } = yield* server(where, { ORGANIZATION_BACKUP_KEEP: "2" })
        yield* db.execute(insert("org_1"))
        // None yet, so one is due; then the fresh one is enough.
        yield* backups.due()
        yield* backups.due()
        expect(yield* Backup.list(where.backups)).toHaveLength(1)
        yield* db.execute(insert("org_2"))
        const middle = yield* backups.run()
        yield* db.execute(insert("org_3"))
        yield* backups.run()
        const kept = yield* Backup.list(where.backups)
        expect(kept.map((backup) => backup.path)).toContain(middle!)
        expect(kept).toHaveLength(2)
        expect(fs.statSync(middle!).mode & 0o777).toBe(0o600)
        return middle!
      }),
    ),
  )

  const archive = new Uint8Array(fs.readFileSync(middle))
  const aside = `${where.dir}.replaced`
  expect(await run(Embedded.restore(where.dir, archive, aside))).toBe(aside)
  expect(await run(Effect.scoped(Effect.flatMap(server(where), ({ db }) => orgs(db))))).toEqual(["org_1", "org_2"])
  // What it replaced is kept whole: put back, it has everything.
  fs.rmSync(where.dir, { recursive: true })
  fs.renameSync(aside, where.dir)
  expect(await run(Effect.scoped(Effect.flatMap(server(where), ({ db }) => orgs(db))))).toEqual([
    "org_1",
    "org_2",
    "org_3",
  ])
}, 120_000)

test("an upgrade backs the database up before migrating it", async () => {
  const where = place("upgrade")
  // A database a server from before the last migration left behind.
  await run(
    Effect.scoped(
      Effect.gen(function* () {
        const pg = yield* Embedded.open(where.dir)
        const db = yield* PgDrizzle.makeWithDefaults().pipe(Effect.provide(PgClient.layerFrom(Embedded.client(pg))))
        yield* DatabaseMigration.apply(db, migrations.slice(0, -1))
        yield* db.execute(insert("org_old"))
      }),
    ),
  )
  await run(Effect.scoped(server(where)))
  const [backup, ...rest] = await run(Backup.list(where.backups))
  expect(rest).toHaveLength(0)
  expect(backup.name).toEndWith("-before-upgrade.tar.gz")
  // Nothing left to migrate, nothing more to back up.
  await run(Effect.scoped(server(where)))
  expect(await run(Backup.list(where.backups))).toHaveLength(1)
  // The backup is the database as it was: restored, the server migrates it again.
  await run(Embedded.restore(where.dir, new Uint8Array(fs.readFileSync(backup.path)), `${where.dir}.replaced`))
  expect(await run(Effect.scoped(Effect.flatMap(server(where), ({ db }) => orgs(db))))).toEqual(["org_old"])
  expect(await run(Backup.list(where.backups))).toHaveLength(2)
}, 120_000)

test("backups and restores leave a database a server has open alone, and a bad archive changes nothing", async () => {
  const where = place("guarded")
  const archive = await run(
    Effect.scoped(
      Effect.gen(function* () {
        const { db, backups } = yield* server(where)
        yield* db.execute(insert("org_1"))
        const busy = yield* Effect.exit(Embedded.backup(where.dir))
        expect(Exit.isFailure(busy) && String(Cause.squash(busy.cause))).toContain("in use by another process")
        const target = yield* backups.run()
        return new Uint8Array(fs.readFileSync(target!))
      }),
    ),
  )
  const busy = await run(
    Effect.scoped(Effect.flatMap(server(where), () => Effect.exit(Embedded.restore(where.dir, archive, "/nowhere")))),
  )
  expect(Exit.isFailure(busy) && String(Cause.squash(busy.cause))).toContain("in use by another process")

  const aside = `${where.dir}.replaced`
  for (const bad of [new Uint8Array([1, 2, 3]), new Uint8Array(fs.readFileSync(__filename))]) {
    const exit = await Effect.runPromiseExit(Embedded.restore(where.dir, bad, aside))
    expect(Exit.isFailure(exit) && String(Cause.squash(exit.cause))).toContain("not a backup")
    expect(fs.existsSync(aside)).toBe(false)
  }
  // Stopped, the command-line backup works, and the database still has its data.
  const tar = await run(Embedded.backup(where.dir))
  expect(tar.length).toBeGreaterThan(0)
  expect(await run(Effect.scoped(Effect.flatMap(server(where), ({ db }) => orgs(db))))).toEqual(["org_1"])
  // A directory without a database is said to be one.
  const empty = await Effect.runPromiseExit(Embedded.backup(path.join(root, "empty")))
  expect(Exit.isFailure(empty) && String(Cause.squash(empty.cause))).toContain("there is no embedded database")
}, 120_000)
