import { afterAll, expect, spyOn, test } from "bun:test"
import { sql } from "drizzle-orm"
import { Cause, Context, Effect, Exit, Layer } from "effect"
import fs from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Database } from "../src/db/database"

const root = fs.mkdtempSync(path.join(tmpdir(), "organization-embedded-"))
afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

const open = (dir: string) =>
  Layer.build(Database.layerEmbedded(dir)).pipe(Effect.map((ctx) => Context.get(ctx, Database.Service)))
const insert = sql`insert into orgs (id, name, slug, settings, created) values ('org_1', 'Acme', 'acme', '{}', 1)`

test("an embedded database directory is open in one place at a time, and keeps its data", async () => {
  const dir = path.join(root, "postgres")
  const count = (db: Database.Db) =>
    db.execute<{ n: number }>(sql`select count(*)::int as n from orgs`).pipe(Effect.map(([row]) => row?.n))

  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const first = yield* open(dir)
        yield* first.db.execute(insert)
        // A second server, or a bootstrap while the server runs, would corrupt the files.
        const second = yield* Effect.exit(Effect.scoped(open(dir)))
        expect(Exit.isFailure(second)).toBe(true)
        if (Exit.isFailure(second))
          expect(String(Cause.squash(second.cause))).toContain(
            `the embedded database in ${dir} is in use by another process`,
          )
      }),
    ),
  )
  // Closed, it opens again, with what the first one wrote.
  const n = await Effect.runPromise(Effect.scoped(open(dir).pipe(Effect.flatMap((db) => count(db.db)))))
  expect(n).toBe(1)
}, 60_000)

test("a commit to an embedded database is on disk when it returns", async () => {
  const sync = spyOn(fs, "fsyncSync")
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const db = (yield* open(path.join(root, "durable"))).db
        sync.mockClear()
        yield* db.execute(insert)
        // The WAL, flushed before the commit returns; not just handed to the system's cache.
        expect(sync).toHaveBeenCalled()
      }),
    ),
  )
  sync.mockRestore()
}, 60_000)
