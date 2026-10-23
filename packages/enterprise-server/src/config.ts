export * as ServerConfig from "./config"

import { Config, Context, Effect, Layer, Option } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { resolveTxt } from "node:dns/promises"

const day = 24 * 60 * 60 * 1000

export interface Info {
  // Public URL of this server; used for OIDC redirect URIs, device verification links and cookie scoping.
  readonly base: string
  // Key material for sealing secrets at rest (ENTERPRISE_SECRET). SSO cannot be configured without it.
  readonly secret: string | undefined
  // Trust X-Forwarded-For for audit IPs when running behind a reverse proxy.
  readonly proxy: boolean
  // Audit history older than this is pruned (milliseconds); undefined keeps it forever.
  readonly retention: number | undefined
  // DNS TXT lookup used for domain verification; injectable for tests.
  readonly txt: (name: string) => Effect.Effect<ReadonlyArray<ReadonlyArray<string>>>
  // Model catalog the gateway prices calls from (models.dev format); undefined prices every call at 0.
  readonly models: string | undefined
}

export class Service extends Context.Service<Service, Info>()("@enterprise/ServerConfig") {
  static configLayer(input: Info) {
    return Layer.succeed(this, this.of(input))
  }
}

export const port = Config.port("ENTERPRISE_PORT").pipe(Config.withDefault(8787))

// Where to listen; only the entrypoint needs it. The database is configured in db/database.ts.
export const listen = Config.all({
  port,
  host: Config.string("ENTERPRISE_HOST").pipe(Config.withDefault("0.0.0.0")),
})

// A failed lookup means no record was found, which domain verification reports to the admin.
const txt = (name: string) => Effect.promise(() => resolveTxt(name).catch((): string[][] => []))

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const env = yield* Config.all({
      port,
      base: Config.string("ENTERPRISE_BASE_URL").pipe(Config.option),
      secret: Config.string("ENTERPRISE_SECRET").pipe(Config.option),
      proxy: Config.boolean("ENTERPRISE_TRUST_PROXY").pipe(Config.withDefault(false)),
      // 0 (or anything non-positive) keeps audit history forever.
      retention: Config.int("ENTERPRISE_AUDIT_RETENTION_DAYS").pipe(Config.withDefault(365)),
      // Set it empty to turn pricing off, e.g. on servers without internet access.
      models: Config.string("ENTERPRISE_MODELS_URL").pipe(Config.withDefault("https://models.dev/api.json")),
    })
    return Service.of({
      base: Option.getOrElse(env.base, () => `http://localhost:${env.port}`).replace(/\/$/, ""),
      secret: Option.getOrUndefined(env.secret) || undefined,
      proxy: env.proxy,
      retention: env.retention > 0 ? env.retention * day : undefined,
      txt,
      models: env.models.trim() || undefined,
    })
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [] })
