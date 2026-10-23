#!/usr/bin/env bun
import { Cause, Context, Effect, Exit, Layer, ManagedRuntime } from "effect"
import { parseArgs } from "node:util"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { App } from "./app"
import { bootstrap } from "./bootstrap"
import { ServerConfig } from "./config"
import { Observability } from "./observability"
import { RequestContext } from "./request"

const args = parseArgs({
  allowPositionals: true,
  options: {
    org: { type: "string" },
    slug: { type: "string" },
    email: { type: "string" },
    name: { type: "string" },
  },
})
const command = args.positionals.at(0) ?? "serve"
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
      "usage: enterprise-server bootstrap --org <name> --slug <slug> --email <owner email> [--name <owner name>]",
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

if (command !== "serve") {
  console.error(`unknown command: ${command} (expected "serve" or "bootstrap")`)
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
    Effect.logError("enterprise control plane could not start").pipe(
      Effect.annotateLogs({ error: reason(ready.cause) }),
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
  ...(config.secret ? [] : ["ENTERPRISE_SECRET is not set: single sign-on cannot be configured until it is."]),
  ...(config.base.startsWith("https://") || /^http:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(config.base)
    ? []
    : [`ENTERPRISE_BASE_URL (${config.base}) is not https: tokens and session cookies would travel in clear text.`]),
]
await Effect.runPromise(
  Effect.forEach(warnings, (warning) => Effect.logWarning(warning)).pipe(
    Effect.andThen(Effect.logInfo("enterprise control plane listening")),
    Effect.annotateLogs({ base: config.base, port: server.port }),
    Effect.provide(Observability.layer),
  ),
)

for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, async () => {
    await server.stop()
    await dispose()
    await runtime.dispose()
    process.exit(0)
  })
