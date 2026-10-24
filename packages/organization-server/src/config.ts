export * as ServerConfig from "./config"

import { Config, Context, Effect, Layer, Option } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { resolveTxt } from "node:dns/promises"

const day = 24 * 60 * 60 * 1000

export interface Info {
  // Public URL of this server; used for OIDC redirect URIs, device verification links and cookie scoping.
  readonly base: string
  // Key material for sealing secrets at rest (ORGANIZATION_SECRET). SSO cannot be configured without it.
  readonly secret: string | undefined
  // How many reverse proxies stand in front of the server. Each appends the address it saw to
  // X-Forwarded-For, so the client's is that many entries from the end; 0 trusts no header.
  readonly proxy: number
  // Requests per minute each token, and each client address without a token, may make; 0 for no limit.
  readonly limits: { readonly token: number; readonly anonymous: number }
  // Audit history older than this is pruned (milliseconds); undefined keeps it forever.
  readonly retention: number | undefined
  // DNS TXT lookup used for domain verification; injectable for tests.
  readonly txt: (name: string) => Effect.Effect<ReadonlyArray<ReadonlyArray<string>>>
  // Model catalog the gateway prices calls from (models.dev format); undefined prices every call at 0.
  readonly models: string | undefined
}

export class Service extends Context.Service<Service, Info>()("@organization/ServerConfig") {
  static configLayer(input: Info) {
    return Layer.succeed(this, this.of(input))
  }
}

export const port = Config.port("ORGANIZATION_PORT").pipe(Config.withDefault(8787))

// A count of proxies, or true for one.
const proxies = Config.int("ORGANIZATION_TRUST_PROXY").pipe(
  Config.orElse(() => Config.boolean("ORGANIZATION_TRUST_PROXY").pipe(Config.map(Number))),
  Config.withDefault(0),
)

// Where to listen; only the entrypoint needs it. The database is configured in db/database.ts.
export const listen = Config.all({
  port,
  host: Config.string("ORGANIZATION_HOST").pipe(Config.withDefault("0.0.0.0")),
})

// A failed lookup means no record was found, which domain verification reports to the admin.
const txt = (name: string) => Effect.promise(() => resolveTxt(name).catch((): string[][] => []))

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const env = yield* Config.all({
      port,
      base: Config.string("ORGANIZATION_BASE_URL").pipe(Config.option),
      secret: Config.string("ORGANIZATION_SECRET").pipe(Config.option),
      proxy: proxies,
      limit: Config.int("ORGANIZATION_RATE_LIMIT").pipe(Config.withDefault(600)),
      anonymous: Config.int("ORGANIZATION_RATE_LIMIT_ANONYMOUS").pipe(Config.withDefault(300)),
      // 0 (or anything non-positive) keeps audit history forever.
      retention: Config.int("ORGANIZATION_AUDIT_RETENTION_DAYS").pipe(Config.withDefault(365)),
      // Set it empty to turn pricing off, e.g. on servers without internet access.
      models: Config.string("ORGANIZATION_MODELS_URL").pipe(Config.withDefault("https://models.dev/api.json")),
    })
    return Service.of({
      base: Option.getOrElse(env.base, () => `http://localhost:${env.port}`).replace(/\/$/, ""),
      secret: Option.getOrUndefined(env.secret) || undefined,
      proxy: Math.max(0, env.proxy),
      limits: { token: Math.max(0, env.limit), anonymous: Math.max(0, env.anonymous) },
      retention: env.retention > 0 ? env.retention * day : undefined,
      txt,
      models: env.models.trim() || undefined,
    })
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [] })
