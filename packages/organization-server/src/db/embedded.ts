export * as Embedded from "./embedded"

import { Database as Sqlite } from "bun:sqlite"
import { PGlite, type PGliteOptions } from "@electric-sql/pglite"
import { NodeFS } from "@electric-sql/pglite/nodefs"
import { PgClient } from "@effect/sql-pg"
import { Context, Effect, Layer, Semaphore, Stream } from "effect"
import type * as SqlConnection from "effect/unstable/sql/SqlConnection"
import { ConstraintError, SqlError, SqlSyntaxError, UniqueViolation, UnknownError } from "effect/unstable/sql/SqlError"
import fs from "node:fs"
import { gunzipSync } from "node:zlib"
import { Backup } from "./backup"
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

// Postgres syncs directories too, after it creates or renames files in them. Windows refuses:
// flushing needs a handle open for writing, which a directory can't have. Postgres's own Windows
// build skips directories, so a refusal is skipped here too; any other error still reaches Postgres.
const directory = (target: string) => {
  try {
    const fd = fs.openSync(target, "r")
    try {
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
  } catch (error) {
    if (!["EPERM", "EACCES", "EISDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error
  }
}

class Durable extends NodeFS {
  override async init(pg: PGlite, opts: Module) {
    const result = await super.init(pg, opts)
    const hook = (mod: Parameters<NonNullable<Module["preRun"]>[number]>[0]) => {
      const nodefs = mod.FS.filesystems.NODEFS as unknown as Nodefs
      nodefs.stream_ops.fsync = (stream) =>
        nodefs.tryFSOperation(() => {
          if (stream.nfd == null) directory(nodefs.realPath(stream.node))
          else fs.fsyncSync(stream.nfd)
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

/** A Postgres client over a PGlite database, taking turns with snapshots when they share `semaphore`. */
export const client = (pg: PGlite, semaphore?: Semaphore.Semaphore) =>
  Effect.gen(function* () {
    const turns = semaphore ?? (yield* Semaphore.make(1))
    const shared = connection(pg)
    // Held for the whole scope: one query, or one transaction from BEGIN to COMMIT. Releasing yields,
    // so requests take turns, as on a server, instead of the first running every query before the next.
    const acquirer = Effect.acquireRelease(turns.take(1).pipe(Effect.as(shared)), () =>
      turns.release(1).pipe(Effect.andThen(Effect.yieldNow)),
    )
    return yield* PgClient.makeWith({
      acquirer,
      transactionAcquirer: acquirer,
      listenAcquirer: Effect.die(new Error("LISTEN is not supported by the embedded database")),
      config: { database: "postgres", username: "postgres" },
    })
  })

// A copy of the database's files as a tarball, taken between queries: Postgres first writes what it
// holds in memory to its files, then they are all read before another query runs. Restoring one is
// like starting after a crash at that moment, so Postgres replays its log and keeps every commit.
export class Snapshot extends Context.Service<Snapshot, Effect.Effect<Uint8Array, Backup.BackupError>>()(
  "@organization/EmbeddedSnapshot",
) {}

const snapshot = (pg: PGlite, semaphore: Semaphore.Semaphore) =>
  semaphore.withPermits(1)(
    Effect.tryPromise({
      try: async () => {
        await pg.exec("checkpoint")
        // Uncompressed, so the files are read at once; compressing waits until queries run again.
        return new Uint8Array(await (await pg.dumpDataDir("none")).arrayBuffer())
      },
      catch: (cause) =>
        new Backup.BackupError({
          message: `could not copy the database: ${cause instanceof Error ? cause.message : String(cause)}`,
        }),
    }),
  )

/** Postgres embedded in this process, keeping its files in `dir` (or in memory without one). */
export const layer = (dir: string | undefined) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const pg = yield* open(dir)
      const semaphore = yield* Semaphore.make(1)
      return Layer.merge(PgClient.layerFrom(client(pg, semaphore)), Layer.succeed(Snapshot, snapshot(pg, semaphore)))
    }),
  )

const missing = (dir: string) =>
  fs.existsSync(`${dir}/PG_VERSION`)
    ? Effect.void
    : Effect.fail(new Backup.BackupError({ message: `there is no embedded database in ${dir}` }))

/** A snapshot of the database in `dir` while no server has it open. */
export const backup = (dir: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* missing(dir)
      return yield* snapshot(yield* open(dir), yield* Semaphore.make(1))
    }),
  )

// The names in a tar archive, or undefined when it isn't one: ustar headers, each followed by its
// file in 512-byte blocks, then blocks of zeros.
function names(tar: Uint8Array) {
  const found = new Set<string>()
  const decoder = new TextDecoder()
  for (let at = 0; at + 512 <= tar.length; ) {
    const header = tar.subarray(at, at + 512)
    if (header.every((byte) => byte === 0)) return found
    const text = (from: number, length: number) =>
      decoder.decode(header.subarray(from, from + length)).replace(/\0[\s\S]*$/, "")
    if (text(257, 5) !== "ustar") return undefined
    const size = parseInt(text(124, 12).trim() || "0", 8)
    if (!Number.isSafeInteger(size) || size < 0) return undefined
    found.add((text(345, 155) + text(0, 100)).replace(/^\/+/, ""))
    at += 512 + Math.ceil(size / 512) * 512
  }
  return undefined
}

const foreign = new Backup.BackupError({ message: "this is not a backup of the organization server's database" })

// PGlite reports a broken archive from a promise nobody awaits, so it only gets archives that hold a
// Postgres data directory.
const unpack = (archive: Uint8Array<ArrayBuffer>) =>
  Effect.gen(function* () {
    // A gzip header; the server's own backups are compressed.
    const tar =
      archive[0] === 0x1f && archive[1] === 0x8b
        ? yield* Effect.try({ try: () => gunzipSync(archive), catch: () => foreign })
        : archive
    const found = names(tar)
    if (!found?.has("PG_VERSION") || !found.has("global/pg_control")) return yield* foreign
    return tar
  })

/**
 * Replaces the database in `dir` with a backup while no server has it open. The one it replaces is
 * moved aside, not deleted; returns where, if there was one.
 */
export const restore = (dir: string, archive: Uint8Array<ArrayBuffer>, aside: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* exclusive(dir)
      const tar = yield* unpack(archive)
      const moved = fs.existsSync(`${dir}/PG_VERSION`) ? aside : undefined
      if (moved) fs.renameSync(dir, moved)
      fs.mkdirSync(dir, { recursive: true })
      const options = yield* bundled
      yield* Effect.tryPromise({
        try: async () => {
          const pg = await PGlite.create({
            ...options,
            fs: new Durable(dir),
            startParams: synced,
            loadDataDir: new Blob([tar], { type: "application/x-tar" }),
          })
          try {
            await pg.query("select count(*) from migration")
          } finally {
            await pg.close()
          }
        },
        catch: (cause) =>
          new Backup.BackupError({
            message: `${foreign.message}: ${cause instanceof Error ? cause.message : String(cause)}`,
          }),
      }).pipe(
        // Put back what was there.
        Effect.tapError(() =>
          Effect.sync(() => {
            fs.rmSync(dir, { recursive: true, force: true })
            if (moved) fs.renameSync(moved, dir)
          }),
        ),
      )
      return moved
    }),
  )
