export * as Backup from "./backup"

import { Clock, Config, Effect, Option, Schema } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import { promisify } from "node:util"
import { gzip } from "node:zlib"

// Backups of the embedded database: gzipped tarballs of its files, named for when they were taken,
// such as kilo-organization-20261024T153012.345Z.tar.gz. They hold everything the server keeps, sealed
// secrets and the audit log included, so only the server's own user can read them.

const prefix = "kilo-organization-"
const suffix = ".tar.gz"

export class BackupError extends Schema.TaggedErrorClass<BackupError>()("BackupError", {
  message: Schema.String,
}) {}

// Where backups go, how many hours apart the server takes them (0 for none), and how many it keeps.
export const settings = Config.all({
  data: Config.string("ORGANIZATION_DATA").pipe(Config.withDefault("./data")),
  dir: Config.string("ORGANIZATION_BACKUP_DIR").pipe(Config.option),
  hours: Config.number("ORGANIZATION_BACKUP_HOURS").pipe(Config.withDefault(24)),
  keep: Config.int("ORGANIZATION_BACKUP_KEEP").pipe(Config.withDefault(7)),
}).pipe(
  Config.map((env) => ({
    dir: Option.getOrElse(env.dir, () => path.join(env.data, "backups")),
    hours: Math.max(0, env.hours),
    keep: Math.max(1, env.keep),
  })),
)
export type Settings = Config.Success<typeof settings>

// 2026-10-24T15:30:12.345Z as 20261024T153012.345Z.
const stamp = (time: number) => new Date(time).toISOString().replace(/[-:]/g, "")
const parse = (name: string) => {
  const match = name.slice(prefix.length).match(/^(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d\.\d{3})Z/)
  return match ? Date.parse(`${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}Z`) : undefined
}

const fail = (action: string) => (cause: unknown) =>
  new BackupError({ message: `could not ${action}: ${cause instanceof Error ? cause.message : String(cause)}` })

/** The backups in a directory, newest first, with when each was taken. */
export const list = (dir: string) =>
  Effect.promise(() => fs.readdir(dir).catch((): string[] => [])).pipe(
    Effect.map((names) =>
      names
        .filter((name) => name.startsWith(prefix) && name.endsWith(suffix))
        .flatMap((name) => {
          const time = parse(name)
          return time === undefined ? [] : [{ name, path: path.join(dir, name), time }]
        })
        .toSorted((a, b) => b.time - a.time || b.name.localeCompare(a.name)),
    ),
  )

/** Compresses a snapshot into a file. */
export const save = (target: string, tar: Uint8Array) =>
  Effect.gen(function* () {
    const zipped = yield* Effect.tryPromise({ try: () => promisify(gzip)(tar), catch: fail("compress the backup") })
    yield* Effect.tryPromise({
      try: async () => {
        await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 })
        // Written aside and renamed, so a backup that exists is whole.
        await fs.writeFile(`${target}.partial`, zipped, { mode: 0o600 })
        await fs.rename(`${target}.partial`, target)
      },
      catch: fail(`write ${target}`),
    })
    return target
  })

/** Compresses a snapshot into the directory, named for now and an optional label; returns its path. */
export const write = (dir: string, tar: Uint8Array, label?: string) =>
  Effect.gen(function* () {
    const name = `${prefix}${stamp(yield* Clock.currentTimeMillis)}${label ? `-${label}` : ""}${suffix}`
    return yield* save(path.join(dir, name), tar)
  })

/** A name to move a replaced database to, beside it. */
export const aside = (dir: string, time: number) => `${dir}.replaced-${stamp(time)}`

/** Deletes all but the newest `keep` backups. */
export const prune = (dir: string, keep: number) =>
  Effect.gen(function* () {
    const old = (yield* list(dir)).slice(keep)
    for (const backup of old) yield* Effect.promise(() => fs.rm(backup.path, { force: true }))
    return old.length
  })
