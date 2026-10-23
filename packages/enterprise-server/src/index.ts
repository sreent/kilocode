#!/usr/bin/env bun
import { Context, Effect, Layer, ManagedRuntime } from "effect"
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

if (command === "bootstrap") {
  const opts = args.values
  if (!opts.org || !opts.slug || !opts.email) {
    console.error(
      "usage: enterprise-server bootstrap --org <name> --slug <slug> --email <owner email> [--name <owner name>]",
    )
    process.exit(1)
  }
  const runtime = ManagedRuntime.make(services)
  const result = await runtime.runPromise(
    bootstrap({ org: opts.org, slug: opts.slug, email: opts.email, name: opts.name }),
  )
  await runtime.dispose()
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
const { handler, dispose } = App.webHandler(layer, { logger: true })

const server = Bun.serve({
  port: listen.port,
  hostname: listen.host,
  maxRequestBodySize: 2 * 1024 * 1024,
  fetch(request, server) {
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
    process.exit(0)
  })
