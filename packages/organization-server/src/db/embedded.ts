export * as Embedded from "./embedded"

import { Database as Sqlite } from "bun:sqlite"
import { PGlite, type PGliteOptions } from "@electric-sql/pglite"
import { NodeFS } from "@electric-sql/pglite/nodefs"
import { PgClient } from "@effect/sql-pg"
import { Effect, Semaphore, Stream } from "effect"
import type * as SqlConnection from "effect/unstable/sql/SqlConnection"
import { ConstraintError, SqlError, SqlSyntaxError, UniqueViolation, UnknownError } from "effect/unstable/sql/SqlError"
import fs from "node:fs"
import assets from "./pglite.gen"

// Postgres in this process, for a server that runs alone: PGlite (Postgres compiled to WebAssembly)
// keeps its files in a data directory, and the server talks to it through the same Postgres client
// and SQL it uses for a Postgres server. Nothing listens on a port or socket.
//
// PGlite is a single Postgres session, so the client hands it to one query or one transaction at a
// time; a transaction holds it to the end, and no other query can land inside it.

function reason(cause: unknown, operation: string) {
  const props = { cause, message: cause instanceof Error ? cause.message : String(cause), operation }
  const code = (cause as { code?: unknown } | undefined)?.code
  if (code === "23505")
    return new UniqueViolation({ ...props, constraint: (cause as { constraint?: string }).constraint ?? "" })
  if (typeof code === "string" && code.startsWith("23")) return new ConstraintError(props)
  if (typeof code === "string" && code.startsWith("42")) return new SqlSyntaxError(props)
  return new UnknownError(props)
}

function connection(pg: PGlite): SqlConnection.Connection {
  const run = <A>(operation: string, query: () => Promise<A>) =>
    Effect.tryPromise({ try: query, catch: (cause) => new SqlError({ reason: reason(cause, operation) }) })
  const rows = (sql: string, params: ReadonlyArray<unknown>) =>
    run("execute", () => pg.query<Record<string, unknown>>(sql, [...params])).pipe(Effect.map((result) => result.rows))
  return {
    execute: (sql, params, transform) => (transform ? Effect.map(rows(sql, params), transform) : rows(sql, params)),
    executeRaw: (sql, params) => run("execute", () => pg.query(sql, [...params])),
    executeValues: (sql, params) =>
      run("execute", () => pg.query<unknown[]>(sql, [...params], { rowMode: "array" })).pipe(
        Effect.map((result) => result.rows),
      ),
    executeUnprepared: (sql, params, transform) =>
      transform ? Effect.map(rows(sql, params), transform) : rows(sql, params),
    executeStream: () =>
      Stream.fail(new SqlError({ reason: reason(new Error("streaming queries are not supported"), "stream") })),
  }
}

// Built into the binary by script/build.ts; from source, PGlite finds its files in node_modules.
const bundled = Effect.promise(async (): Promise<Partial<PGliteOptions>> => {
  if (!assets) return {}
  const [pglite, initdb] = await Promise.all([
    WebAssembly.compile(await Bun.file(assets.wasm).arrayBuffer()),
    WebAssembly.compile(await Bun.file(assets.initdb).arrayBuffer()),
  ])
  return { pgliteWasmModule: pglite, initdbWasmModule: initdb, fsBundle: Bun.file(assets.data) }
})

// PGlite has no postmaster to keep a second Postgres off its files, so nothing would stop another
// process (a bootstrap while the server runs, a second container on the same volume) from opening the
// directory too, and two Postgres instances on one directory corrupt it. An exclusive SQLite lock on a
// file beside it does: the system releases it when the process ends, however it ends.
const exclusive = (dir: string) =>
  Effect.acquireRelease(
    Effect.suspend(() => {
      const lock = new Sqlite(`${dir}.lock`)
      return Effect.try({
        // The journal in memory: a lock with nothing to roll back needs no second file.
        try: () => lock.exec("pragma journal_mode = memory; begin exclusive"),
        catch: () =>
          new Error(
            `the embedded database in ${dir} is in use by another process. Stop that process first, or have every process share a Postgres server through ORGANIZATION_DATABASE_URL`,
          ),
      }).pipe(
        Effect.as(lock),
        Effect.tapError(() => Effect.sync(() => lock.close())),
        Effect.orDie,
      )
    }),
    (lock) => Effect.sync(() => lock.close()),
  )

// PGlite reaches its files through Emscripten's NODEFS, which has no fsync, and starts Postgres with
// fsync off: a commit reaches the system's cache, which survives the server crashing but not the
// machine. With fsync added and turned on, a commit is on disk when it returns, as on a Postgres server.
type Handle = { nfd?: number; node: unknown }
type Nodefs = {
  stream_ops: { fsync?: (stream: Handle) => number }
  realPath: (node: unknown) => string
  tryFSOperation: <A>(operation: () => A) => A
}
type Module = Parameters<NodeFS["init"]>[1]

class Durable extends NodeFS {
  override async init(pg: PGlite, opts: Module) {
    const result = await super.init(pg, opts)
    const hook = (mod: Parameters<NonNullable<Module["preRun"]>[number]>[0]) => {
      const nodefs = mod.FS.filesystems.NODEFS as unknown as Nodefs
      nodefs.stream_ops.fsync = (stream) =>
        nodefs.tryFSOperation(() => {
          // Postgres syncs directories too, after it creates or renames files in them.
          const fd = stream.nfd ?? fs.openSync(nodefs.realPath(stream.node), "r")
          fs.fsyncSync(fd)
          if (stream.nfd == null) fs.closeSync(fd)
          return 0
        })
    }
    return { emscriptenOpts: { ...result.emscriptenOpts, preRun: [...(result.emscriptenOpts.preRun ?? []), hook] } }
  }
}

// Postgres's own defaults, which PGlite's -F turns off; and the WAL flushed with fsync, since
// Emscripten's fdatasync does nothing.
const synced = [...PGlite.defaultStartParams.filter((param) => param !== "-F"), "-c", "wal_sync_method=fsync"]

/** The PGlite database itself; in memory without a directory. */
export const open = (dir: string | undefined) =>
  Effect.gen(function* () {
    if (dir) {
      fs.mkdirSync(dir, { recursive: true })
      yield* exclusive(dir)
    }
    const options = yield* bundled
    return yield* Effect.acquireRelease(
      Effect.promise(() =>
        PGlite.create({ ...options, ...(dir ? { fs: new Durable(dir), startParams: synced } : {}) }),
      ),
      (pg) => Effect.promise(() => pg.close()),
    )
  })

/** A Postgres client over a PGlite database. */
export const client = (pg: PGlite) =>
  Effect.gen(function* () {
    const semaphore = yield* Semaphore.make(1)
    const shared = connection(pg)
    // Held for the whole scope: one query, or one transaction from BEGIN to COMMIT. Releasing yields,
    // so requests take turns, as on a server, instead of the first running every query before the next.
    const acquirer = Effect.acquireRelease(semaphore.take(1).pipe(Effect.as(shared)), () =>
      semaphore.release(1).pipe(Effect.andThen(Effect.yieldNow)),
    )
    return yield* PgClient.makeWith({
      acquirer,
      transactionAcquirer: acquirer,
      listenAcquirer: Effect.die(new Error("LISTEN is not supported by the embedded database")),
      config: { database: "postgres", username: "postgres" },
    })
  })

/** Postgres embedded in this process, keeping its files in `dir` (or in memory without one). */
export const layer = (dir: string | undefined) => PgClient.layerFrom(Effect.flatMap(open(dir), client))
