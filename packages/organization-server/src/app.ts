export * as App from "./app"

import { Effect, Layer, Schedule } from "effect"
import { HttpClient, HttpRouter, HttpServer } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "@organization/protocol/api"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Backups } from "./backups"
import { ServerConfig } from "./config"
import { Database } from "./db/database"
import { AccountHandler } from "./handlers/account"
import { GatewayHandler } from "./handlers/gateway"
import { GovernanceHandler } from "./handlers/governance"
import { IdentityHandler } from "./handlers/identity"
import { InsightHandler } from "./handlers/insight"
import { OrgHandler } from "./handlers/org"
import { PeopleHandler } from "./handlers/people"
import { HealthHandler, SigninHandler } from "./handlers/public"
import { ScimHandler } from "./handlers/scim"
import { authorizationLayer, orgScopeLayer, scimAuthorizationLayer } from "./middleware/authorization"
import { errorLayer, headersLayer } from "./middleware/error"
import { rateLimitApiLayer, rateLimitLayer } from "./middleware/ratelimit"
import { schemaErrorLayer } from "./middleware/schema-error"
import { httpClient, Oidc } from "./oidc"
import { Pricing } from "./pricing"
import { RateLimit } from "./ratelimit"
import { ConsoleAssets, consoleRoutes, node as consoleAssets } from "./routes/console"
import { deviceRoutes } from "./routes/device"
import { gatewayRoutes } from "./routes/gateway"
import { ssoRoutes } from "./routes/sso"
import { Reports } from "./reports"
import { Store } from "./store"
import { Streams } from "./streams"

// Application services. Tests and embedders replace nodes (an in-memory database, fixed config)
// with LayerNode.compile replacements, the same way core's server does.
export const services = LayerNode.group([
  ServerConfig.node,
  Database.node,
  Store.node,
  Oidc.node,
  Pricing.node,
  Streams.node,
  Reports.node,
  RateLimit.node,
  Backups.node,
  httpClient,
  consoleAssets,
])

const handlers = Layer.mergeAll(
  HealthHandler,
  SigninHandler,
  AccountHandler,
  OrgHandler,
  PeopleHandler,
  GovernanceHandler,
  InsightHandler,
  IdentityHandler,
  GatewayHandler,
  ScimHandler,
)

// Route tree:
// - apiRoutes: the typed contract from @organization/protocol, with its declared middleware.
// - deviceRoutes, ssoRoutes: the browser legs of sign-in, which answer with pages and redirects.
// - gatewayRoutes: the LLM gateway, which speaks each provider's own API rather than ours.
// - consoleRoutes: the admin console and a JSON 404 for everything else.
const apiRoutes = HttpApiBuilder.layer(Api, { openapiPath: "/api/v1/openapi.json" }).pipe(
  Layer.provide(handlers),
  Layer.provide([authorizationLayer, orgScopeLayer, scimAuthorizationLayer, schemaErrorLayer, rateLimitApiLayer]),
)

export function routes<E>(
  application: Layer.Layer<
    | ServerConfig.Service
    | Database.Service
    | Store.Service
    | Oidc.Service
    | Pricing.Service
    | Streams.Service
    | Reports.Service
    | RateLimit.Service
    | HttpClient.HttpClient
    | ConsoleAssets,
    E
  >,
) {
  return Layer.mergeAll(apiRoutes, deviceRoutes, ssoRoutes, gatewayRoutes, consoleRoutes).pipe(
    Layer.provide([errorLayer, headersLayer, rateLimitLayer]),
    Layer.provide(application),
  )
}

// Device codes, abandoned SSO logins and audit history past retention, swept hourly. Model prices
// are loaded at startup and refreshed daily, so gateway calls rarely wait for the catalog. Audit
// streams are delivered every few seconds, and due reports and backups looked for every few minutes.
export const housekeeping = Layer.effectDiscard(
  Effect.gen(function* () {
    const store = yield* Store.Service
    const config = yield* ServerConfig.Service
    const pricing = yield* Pricing.Service
    const streams = yield* Streams.Service
    const reports = yield* Reports.Service
    const backups = yield* Backups.Service
    yield* Effect.forkScoped(pricing.refresh().pipe(Effect.repeat(Schedule.spaced("1 day"))))
    yield* Effect.forkScoped(backups.due().pipe(Effect.repeat(Schedule.spaced("10 minutes"))))
    yield* Effect.forkScoped(streams.run().pipe(Effect.repeat(Schedule.spaced("5 seconds"))))
    yield* Effect.forkScoped(reports.run().pipe(Effect.repeat(Schedule.spaced("5 minutes"))))
    const sweep = store
      .sweep(config.retention)
      .pipe(
        Effect.tap((pruned) =>
          pruned > 0
            ? Effect.logInfo("pruned audit events past retention").pipe(Effect.annotateLogs({ pruned }))
            : Effect.void,
        ),
      )
    yield* Effect.forkScoped(sweep.pipe(Effect.repeat(Schedule.spaced("1 hour"))))
  }),
)

type RouteRequirements =
  | HttpRouter.HttpRouter
  | HttpRouter.Request<"Error", unknown>
  | HttpRouter.Request<"GlobalError", unknown>
  | Layer.Success<typeof HttpServer.layerServices>

export function webHandler<E>(
  layer: Layer.Layer<never, E, RouteRequirements>,
  options: { readonly memoMap?: Layer.MemoMap; readonly logger?: boolean } = {},
) {
  return HttpRouter.toWebHandler(layer.pipe(Layer.provide(HttpServer.layerServices)), {
    disableLogger: !options.logger,
    memoMap: options.memoMap,
  })
}
