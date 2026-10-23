export * as App from "./app"

import { Effect, Layer, Schedule } from "effect"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "@enterprise/protocol/api"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ServerConfig } from "./config"
import { Database } from "./db/database"
import { AccountHandler } from "./handlers/account"
import { GovernanceHandler } from "./handlers/governance"
import { IdentityHandler } from "./handlers/identity"
import { InsightHandler } from "./handlers/insight"
import { OrgHandler } from "./handlers/org"
import { PeopleHandler } from "./handlers/people"
import { HealthHandler, SigninHandler } from "./handlers/public"
import { ScimHandler } from "./handlers/scim"
import { authorizationLayer, orgScopeLayer, scimAuthorizationLayer } from "./middleware/authorization"
import { errorLayer, headersLayer } from "./middleware/error"
import { schemaErrorLayer } from "./middleware/schema-error"
import { Oidc } from "./oidc"
import { ConsoleAssets, consoleRoutes, node as consoleAssets } from "./routes/console"
import { deviceRoutes } from "./routes/device"
import { ssoRoutes } from "./routes/sso"
import { Store } from "./store"

// Application services. Tests and embedders replace nodes (an in-memory database, fixed config)
// with LayerNode.compile replacements, the same way core's server does.
export const services = LayerNode.group([ServerConfig.node, Database.node, Store.node, Oidc.node, consoleAssets])

const handlers = Layer.mergeAll(
  HealthHandler,
  SigninHandler,
  AccountHandler,
  OrgHandler,
  PeopleHandler,
  GovernanceHandler,
  InsightHandler,
  IdentityHandler,
  ScimHandler,
)

// Route tree:
// - apiRoutes: the typed contract from @enterprise/protocol, with its declared middleware.
// - deviceRoutes, ssoRoutes: the browser legs of sign-in, which answer with pages and redirects.
// - consoleRoutes: the admin console and a JSON 404 for everything else.
const apiRoutes = HttpApiBuilder.layer(Api, { openapiPath: "/api/v1/openapi.json" }).pipe(
  Layer.provide(handlers),
  Layer.provide([authorizationLayer, orgScopeLayer, scimAuthorizationLayer, schemaErrorLayer]),
)

export function routes<E>(
  application: Layer.Layer<ServerConfig.Service | Database.Service | Store.Service | Oidc.Service | ConsoleAssets, E>,
) {
  return Layer.mergeAll(apiRoutes, deviceRoutes, ssoRoutes, consoleRoutes).pipe(
    Layer.provide([errorLayer, headersLayer]),
    Layer.provide(application),
  )
}

// Device codes, abandoned SSO logins and audit history past retention, swept hourly.
export const housekeeping = Layer.effectDiscard(
  Effect.gen(function* () {
    const store = yield* Store.Service
    const config = yield* ServerConfig.Service
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
