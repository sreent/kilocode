import { afterAll, expect, test } from "bun:test"
import { Database as Sqlite } from "bun:sqlite"
import { PGlite } from "@electric-sql/pglite"
import { PgClient } from "@effect/sql-pg"
import { sql } from "drizzle-orm"
import * as PgDrizzle from "drizzle-orm/effect-postgres"
import { Context, Effect, Layer } from "effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Database } from "../src/db/database"
import { Embedded } from "../src/db/embedded"
import { Legacy } from "../src/db/legacy"
import { DatabaseMigration } from "../src/db/migration"

// A database as servers before Postgres wrote it: SQLite, booleans as 0/1 and JSON as text.
const dir = mkdtempSync(path.join(tmpdir(), "organization-legacy-"))
const file = path.join(dir, "enterprise.db")
const lite = new Sqlite(file)
lite.exec(`
  create table orgs (id text primary key, name text not null, slug text not null, parent text, settings text not null, created integer not null);
  create table users (id text primary key, email text not null, name text, external text, active integer not null, created integer not null);
  create table members (org text not null, user text not null, role text not null, created integer not null, suspended integer);
  create table sso (org text primary key, protocol text not null, issuer text not null, client text, secret text, scopes text,
    entry text, certificates text, unsolicited integer not null, enforce integer not null, provision integer not null, updated integer not null);
  create table audit (id integer primary key autoincrement, org text not null, at integer not null, action text not null,
    actor text, email text, target text, details text not null, ip text);
  create table audit_streams (id text primary key, org text not null, name text not null, target text not null, secret text,
    headers text, names text not null, enabled integer not null, cursor integer not null, delivered integer, error text,
    failing integer, failures integer not null, retry integer, lease integer, created integer not null, updated integer not null);
  create table migration (id text primary key, time_completed integer not null);
`)
const at = 1_700_000_000_000
lite.run("insert into orgs values ('org_1', 'Acme', 'acme', null, ?, ?)", [JSON.stringify({ theme: "dark" }), at])
lite.run(
  "insert into users values ('usr_1', 'owner@acme.com', 'Owner', null, 1, ?), ('usr_2', 'gone@acme.com', null, null, 0, ?)",
  [at, at],
)
lite.run("insert into members values ('org_1', 'usr_1', 'owner', ?, null), ('org_1', 'usr_2', 'member', ?, ?)", [
  at,
  at,
  at,
])
lite.run(
  "insert into sso values ('org_1', 'saml', 'https://idp.example.com', null, null, null, 'https://idp.example.com/sso', ?, 1, 1, 0, ?)",
  [JSON.stringify(["-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n"]), at],
)
for (const id of [7, 41])
  lite.run("insert into audit values (?, 'org_1', ?, 'policy.update', 'usr_1', 'owner@acme.com', null, ?, null)", [
    id,
    at + id,
    JSON.stringify({ version: id }),
  ])
lite.run(
  "insert into audit_streams values ('str_1', 'org_1', 'Splunk', ?, 'sealed', null, ?, 0, 41, null, null, null, 0, null, null, ?, ?)",
  [JSON.stringify({ kind: "webhook", url: "https://siem.example.com" }), JSON.stringify(["Authorization"]), at, at],
)
lite.close()

const pg = await PGlite.create()
afterAll(async () => {
  await pg.close()
  rmSync(dir, { recursive: true, force: true })
})

// Runs against a PGlite database through the server's own Postgres client.
const on =
  (target: PGlite) =>
  <A>(effect: (db: Database.Db) => Effect.Effect<A, unknown>) =>
    Effect.runPromise(
      Effect.gen(function* () {
        return yield* effect(yield* PgDrizzle.makeWithDefaults())
      }).pipe(Effect.provide(PgClient.layerFrom(Embedded.client(target)))),
    )
const run = on(pg)

test("copies a SQLite database into an empty Postgres once, keeping ids and decoding values", async () => {
  await run((db) => DatabaseMigration.apply(db))
  await run((db) => Legacy.copy(db, file))
  const rows = async (query: string) => (await pg.query<Record<string, unknown>>(query)).rows

  expect(await rows("select slug, settings from orgs")).toEqual([{ slug: "acme", settings: { theme: "dark" } }])
  expect(await rows("select email, active from users order by email")).toEqual([
    { email: "gone@acme.com", active: false },
    { email: "owner@acme.com", active: true },
  ])
  expect(await rows("select protocol, certificates, unsolicited, enforce, provision from sso")).toEqual([
    {
      protocol: "saml",
      certificates: ["-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n"],
      unsolicited: true,
      enforce: true,
      provision: false,
    },
  ])
  expect(await rows("select id::int, details from audit order by id")).toEqual([
    { id: 7, details: { version: 7 } },
    { id: 41, details: { version: 41 } },
  ])
  // Streams resume after the audit id they last delivered, so ids must not change.
  expect(await rows("select enabled, cursor::int, names, target from audit_streams")).toEqual([
    {
      enabled: false,
      cursor: 41,
      names: ["Authorization"],
      target: { kind: "webhook", url: "https://siem.example.com" },
    },
  ])
  // New audit events continue after the copied ones.
  const [next] = await rows("insert into audit (org, at, action) values ('org_1', 1, 'group.create') returning id::int")
  expect(next).toEqual({ id: 42 })

  // Never twice: a database that already has organizations is left alone.
  await run((db) => Legacy.copy(db, file))
  expect(await rows("select count(*)::int as n from users")).toEqual([{ n: 2 }])
})

test("a single server moving to a Postgres server copies its embedded database in once", async () => {
  const embedded = path.join(dir, "postgres")
  // What the single server kept: its embedded database, at this version's schema.
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const db = Context.get(yield* Layer.build(Database.layerEmbedded(embedded)), Database.Service).db
        yield* db.execute(
          sql`insert into orgs (id, name, slug, settings, created) values ('org_1', 'Acme', 'acme', ${JSON.stringify({ theme: "dark" })}::jsonb, 1)`,
        )
        yield* db.execute(
          sql`insert into users (id, email, active, created) values ('usr_1', 'owner@acme.com', true, 1)`,
        )
        yield* db.execute(
          sql`insert into audit (org, at, action, details) values ('org_1', 1, 'organization.create', '{}'), ('org_1', 2, 'policy.update', '{"version":1}')`,
        )
      }),
    ),
  )
  // The Postgres server it now points at; another PGlite database stands in for it.
  const server = await PGlite.create()
  const into = on(server)
  await into((db) => DatabaseMigration.apply(db))
  await into((db) => Legacy.embedded(db, embedded))
  const rows = async (query: string) => (await server.query<Record<string, unknown>>(query)).rows

  expect(await rows("select slug, settings from orgs")).toEqual([{ slug: "acme", settings: { theme: "dark" } }])
  expect(await rows("select email, active from users")).toEqual([{ email: "owner@acme.com", active: true }])
  expect(await rows("select id::int, action, details from audit order by id")).toEqual([
    { id: 1, action: "organization.create", details: {} },
    { id: 2, action: "policy.update", details: { version: 1 } },
  ])
  const [next] = await rows("insert into audit (org, at, action) values ('org_1', 3, 'group.create') returning id::int")
  expect(next).toEqual({ id: 3 })

  // Never twice, and the embedded database is left as it was.
  await into((db) => Legacy.embedded(db, embedded))
  expect(await rows("select count(*)::int as n from orgs")).toEqual([{ n: 1 }])
  await server.close()
}, 60_000)
