#!/usr/bin/env bun
import { Cause, Clock, Config, Context, Effect, Exit, Layer, ManagedRuntime } from "effect"
import path from "node:path"
import { parseArgs } from "node:util"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { App } from "./app"
import { Backups } from "./backups"
import { bootstrap, first, settings as seed } from "./bootstrap"
import { ServerConfig } from "./config"
import { Backup } from "./db/backup"
import { Embedded } from "./db/embedded"
import { Observability } from "./observability"
import { RequestContext } from "./request"

const args = parseArgs({
  allowPositionals: true,
  options: {
    org: { type: "string" },
    slug: { type: "string" },
    email: { type: "string" },
    name: { type: "string" },
    out: { type: "string" },
  },
})
const command = args.positionals.at(0) ?? "serve"

// Settings were named ENTERPRISE_* before. Ignoring them would quietly start without the secret or
// the database, so stop and say what to rename.
const stale = Object.keys(process.env).filter((name) => name.startsWith("ENTERPRISE_"))
if (stale.length > 0) {
  const renamed = stale.map((name) => `${name} to ORGANIZATION_${name.slice("ENTERPRISE_".length)}`)
  console.error(`The server's settings were renamed. Rename ${renamed.join(", ")}.`)
  process.exit(1)
}

const services = LayerNode.compile(App.services)
// Why the database could not be opened, for instance: unreachable, or in use by another process.
const reason = (cause: Cause.Cause<unknown>) => {
  const error = Cause.squash(cause)
  return error instanceof Error ? error.message : String(error)
}

if (command === "bootstrap") {
  const opts = args.values
  if (!opts.org || !opts.slug || !opts.email) {
    console.error(
      "usage: organization-server bootstrap --org <name> --slug <slug> --email <owner email> [--name <owner name>]",
    )
    process.exit(1)
  }
  const runtime = ManagedRuntime.make(services)
  const exit = await runtime.runPromiseExit(
    bootstrap({ org: opts.org, slug: opts.slug, email: opts.email, name: opts.name }),
  )
  await runtime.dispose()
  if (Exit.isFailure(exit)) {
    console.error(`bootstrap failed: ${reason(exit.cause)}`)
    process.exit(1)
  }
  const result = exit.value
  console.log(`organization: ${result.org.name} (${result.org.slug})`)
  console.log(`owner:        ${result.user.email}`)
  console.log(`token:        ${result.token}`)
  console.log("\nStore this token securely; it is shown once. Use it as `Authorization: Bearer <token>`.")
  process.exit(0)
}

// Backups and restores of the embedded database, while no server has it open.
if (command === "backup" || command === "restore") {
  if (process.env.ORGANIZATION_DATABASE_URL) {
    console.error(
      "This server keeps its data on a Postgres server (ORGANIZATION_DATABASE_URL). Back it up and restore it with that server's own tools, such as pg_dump and pg_restore.",
    )
    process.exit(1)
  }
  const settings = await Effect.runPromise(
    Config.all({
      data: Config.string("ORGANIZATION_DATA").pipe(Config.withDefault("./data")),
      backup: Backup.settings,
    }),
  )
  const dir = path.join(settings.data, "postgres")
  const file = args.positionals.at(1)
  if (command === "restore" && !file) {
    console.error("usage: organization-server restore <backup file>")
    process.exit(1)
  }
  const exit = await Effect.runPromiseExit(
    command === "backup"
      ? Effect.flatMap(Embedded.backup(dir), (tar) =>
          args.values.out ? Backup.save(args.values.out, tar) : Backup.write(settings.backup.dir, tar),
        )
      : Effect.gen(function* () {
          const archive = new Uint8Array(yield* Effect.promise(() => Bun.file(file!).arrayBuffer()))
          return yield* Embedded.restore(dir, archive, Backup.aside(dir, yield* Clock.currentTimeMillis))
        }),
  )
  if (Exit.isFailure(exit)) {
    const message = reason(exit.cause)
    console.error(`${command} failed: ${message}`)
    if (command === "backup" && message.includes("in use by another process"))
      console.error("A running server backs itself up (see ORGANIZATION_BACKUP_HOURS); send it SIGUSR2 for one now.")
    process.exit(1)
  }
  if (command === "backup") console.log(`backup: ${exit.value}`)
  else
    console.log(
      `restored ${file} into ${dir}.` +
        (exit.value ? ` The database it replaced is in ${exit.value}; delete it once you no longer need it.` : ""),
    )
  process.exit(0)
}

if (command !== "serve") {
  console.error(`unknown command: ${command} (expected "serve", "bootstrap", "backup" or "restore")`)
  process.exit(1)
}

const listen = await Effect.runPromise(ServerConfig.listen)
const config = await Effect.runPromise(
  Effect.gen(function* () {
    return yield* ServerConfig.Service
  }).pipe(Effect.provide(ServerConfig.layer)),
)
// Same ordering as core's server: Observability is provided last so every fiber logs through it.
const layer = Layer.mergeAll(App.routes(services), App.housekeeping.pipe(Layer.provide(services))).pipe(
  Layer.provideMerge(Observability.layer),
)
// The services, and with them the database, start before the server listens, so a database it can't
// reach or open stops it here instead of failing every request. The web handler reuses them.
const memoMap = Layer.makeMemoMapUnsafe()
const runtime = ManagedRuntime.make(services.pipe(Layer.provideMerge(Observability.layer)), { memoMap })
const ready = await runtime.runPromiseExit(Effect.void)
if (Exit.isFailure(ready)) {
  await Effect.runPromise(
    Effect.logError("organization server could not start").pipe(
      Effect.annotateLogs({ error: reason(ready.cause) }),
      Effect.provide(Observability.layer),
    ),
  )
  process.exit(1)
}
// The organization ORGANIZATION_BOOTSTRAP_* describe, on a database that has none yet.
const seeded = await runtime.runPromiseExit(
  Effect.gen(function* () {
    const input = yield* seed
    if (!input) return
    if (yield* first(input))
      yield* Effect.logInfo(
        "created the first organization and its owner, who signs in with ORGANIZATION_BOOTSTRAP_TOKEN",
      ).pipe(Effect.annotateLogs({ org: input.slug, owner: input.email }))
  }),
)
if (Exit.isFailure(seeded)) {
  await Effect.runPromise(
    Effect.logError("organization server could not start").pipe(
      Effect.annotateLogs({ error: reason(seeded.cause) }),
      Effect.provide(Observability.layer),
    ),
  )
  process.exit(1)
}
const { handler, dispose } = App.webHandler(layer, { logger: true, memoMap })

// Gateway calls carry whole conversations, images included, up to the providers' own 32 MB limit;
// the control plane's API stays at 2 MB.
const limit = 2 * 1024 * 1024
const tooLarge = () =>
  Response.json({ _tag: "InvalidRequestError", message: "request body is too large" }, { status: 413 })

const server = Bun.serve({
  port: listen.port,
  hostname: listen.host,
  maxRequestBodySize: 32 * 1024 * 1024,
  fetch(request, server) {
    // A model can think, or stream, for minutes without a byte on the wire; Bun's idle timeout is 10s.
    if (new URL(request.url).pathname.startsWith("/gateway/")) server.timeout(request, 0)
    else if (Number(request.headers.get("content-length") ?? 0) > limit) return tooLarge()
    return handler(request, Context.make(RequestContext.Peer, server.requestIP(request)?.address ?? ""))
  },
})

const warnings = [
  ...(config.secret ? [] : ["ORGANIZATION_SECRET is not set: single sign-on cannot be configured until it is."]),
  ...(config.base.startsWith("https://") || /^http:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(config.base)
    ? []
    : [`ORGANIZATION_BASE_URL (${config.base}) is not https: tokens and session cookies would travel in clear text.`]),
]
await Effect.runPromise(
  Effect.forEach(warnings, (warning) => Effect.logWarning(warning)).pipe(
    Effect.andThen(Effect.logInfo("organization server listening")),
    Effect.annotateLogs({ base: config.base, port: server.port }),
    Effect.provide(Observability.layer),
  ),
)

// `kill -USR2 <pid>` (or `docker kill --signal=USR2 <container>`) backs up the embedded database now.
if (process.platform !== "win32")
  process.on("SIGUSR2", () => void runtime.runPromise(Backups.Service.use((backups) => backups.run())))

for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, async () => {
    await server.stop()
    await dispose()
    await runtime.dispose()
    process.exit(0)
  })
