import { Clock, Effect } from "effect"
import { HttpApiBuilder, HttpApiSchema } from "effect/unstable/httpapi"
import { Api } from "@organization/protocol/api"
import { ConflictError, InvalidRequestError, NotFoundError } from "@organization/protocol/errors"
import { Membership } from "@organization/protocol/middleware"
import * as Crypto from "../crypto"
import { ServerConfig } from "../config"
import { Oidc } from "../oidc"
import * as Saml from "../saml"
import { RequestContext } from "../request"
import { Store } from "../store"

const record = (row: { name: string; token: string }) => ({ type: "TXT" as const, name: row.name, value: row.token })

export const IdentityHandler = HttpApiBuilder.group(Api, "organization.identity", (handlers) =>
  Effect.gen(function* () {
    const store = yield* Store.Service
    const config = yield* ServerConfig.Service
    const oidc = yield* Oidc.Service
    const audit = RequestContext.auditor(store, config)

    return handlers
      .handle(
        "sso.get",
        Effect.fn(function* () {
          const scope = yield* Membership
          const row = yield* store.sso.get(scope.org.id)
          const oidc = row?.protocol === "oidc" ? row : undefined
          const saml = row?.protocol === "saml" ? row : undefined
          return {
            configured: row != null,
            protocol: row?.protocol ?? null,
            issuer: oidc?.issuer ?? null,
            client_id: oidc?.client ?? null,
            scopes: oidc?.scopes ?? null,
            saml: saml
              ? {
                  entity_id: saml.issuer,
                  sso_url: saml.entry,
                  certificates: saml.certificates.map(Saml.describe),
                  idp_initiated: saml.unsolicited,
                }
              : null,
            enforce: row?.enforce ?? false,
            provision: row ? row.provision : null,
            redirect_uri: `${config.base}/sso/callback`,
            login_url: `${config.base}/sso/${scope.org.slug}/start`,
            service_provider: Saml.provider(config.base, scope.org.slug),
          }
        }),
      )
      .handle(
        "sso.update",
        Effect.fn(function* (ctx) {
          const scope = yield* Membership
          const input = ctx.payload
          if (!config.secret)
            return yield* new InvalidRequestError({
              message: "set ORGANIZATION_SECRET on the server before configuring single sign-on",
            })
          if (!input.scopes.split(/\s+/).includes("openid"))
            return yield* new InvalidRequestError({ message: "scopes must include openid" })
          const current = yield* store.sso.get(scope.org.id)
          const existing = current?.protocol === "oidc" ? current : undefined
          if (!existing && !input.client_secret)
            return yield* new InvalidRequestError({ message: "client_secret is required" })
          // Fail fast on a typo'd issuer instead of at the first user's login.
          yield* oidc
            .discover(input.issuer)
            .pipe(
              Effect.mapError((error) => new InvalidRequestError({ message: `cannot reach issuer: ${error.message}` })),
            )
          yield* store.sso.set(scope.org.id, {
            protocol: "oidc",
            issuer: input.issuer,
            client: input.client_id,
            secret: input.client_secret ? yield* Crypto.seal(config.secret, input.client_secret) : existing!.secret,
            scopes: input.scopes,
            enforce: input.enforce,
            provision: input.provision,
          })
          yield* audit("sso.update", scope.org.id, {
            protocol: "oidc",
            issuer: input.issuer,
            client_id: input.client_id,
            enforce: input.enforce,
            provision: input.provision,
            secret_rotated: input.client_secret != null,
          })
          return { ok: true as const }
        }),
      )
      .handle(
        "sso.saml",
        Effect.fn(function* (ctx) {
          const scope = yield* Membership
          const input = ctx.payload
          const current = yield* store.sso.get(scope.org.id)
          const parsed = yield* Saml.settings(input, current?.protocol === "saml" ? current : undefined).pipe(
            Effect.mapError((error) => new InvalidRequestError({ message: error.message })),
          )
          yield* store.sso.set(scope.org.id, {
            protocol: "saml",
            issuer: parsed.entity,
            entry: parsed.entry,
            certificates: parsed.certificates,
            unsolicited: input.idp_initiated,
            enforce: input.enforce,
            provision: input.provision,
          })
          yield* audit("sso.update", scope.org.id, {
            protocol: "saml",
            entity_id: parsed.entity,
            sso_url: parsed.entry,
            certificates: parsed.certificates.map((pem) => Saml.describe(pem).fingerprint),
            idp_initiated: input.idp_initiated,
            enforce: input.enforce,
            provision: input.provision,
          })
          return { ok: true as const }
        }),
      )
      .handle(
        "sso.remove",
        Effect.fn(function* () {
          const scope = yield* Membership
          yield* store.sso.remove(scope.org.id)
          yield* audit("sso.remove", scope.org.id)
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "domains.list",
        Effect.fn(function* () {
          const rows = yield* store.domain.list((yield* Membership).org.id)
          return { domains: rows.map((row) => ({ name: row.name, verified: row.verified, record: record(row) })) }
        }),
      )
      .handle(
        "domains.create",
        Effect.fn(function* (ctx) {
          const scope = yield* Membership
          if (yield* store.domain.get(ctx.payload.domain))
            return yield* new ConflictError({ message: "this domain is already registered" })
          const row = yield* store.domain.create(scope.org.id, ctx.payload.domain)
          yield* audit("domain.create", row.name)
          return { name: row.name, verified: null, record: record(row) }
        }),
      )
      .handle(
        "domains.verify",
        Effect.fn(function* (ctx) {
          const scope = yield* Membership
          const row = yield* store.domain.get(ctx.params.name)
          if (!row || row.org !== scope.org.id) return yield* new NotFoundError({ message: "domain not found" })
          const records = yield* config.txt(row.name)
          if (!records.some((parts) => parts.join("") === row.token))
            return yield* new InvalidRequestError({
              message: `TXT record not found: add a TXT record on ${row.name} with value ${row.token}`,
            })
          yield* store.domain.verify(row.name)
          yield* audit("sso.set_domain", row.name)
          return { name: row.name, verified: yield* Clock.currentTimeMillis }
        }),
      )
      .handle(
        "domains.remove",
        Effect.fn(function* (ctx) {
          const scope = yield* Membership
          if (!(yield* store.domain.remove(scope.org.id, ctx.params.name)))
            return yield* new NotFoundError({ message: "domain not found" })
          yield* audit("sso.remove_domain", ctx.params.name.toLowerCase())
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "scimTokens.list",
        Effect.fn(function* () {
          return { tokens: yield* store.token.list({ org: (yield* Membership).org.id, kind: "scim" }) }
        }),
      )
      .handle(
        "scimTokens.create",
        Effect.fn(function* (ctx) {
          const scope = yield* Membership
          const name = ctx.payload.name ?? "SCIM"
          const issued = yield* store.token.issue({ kind: "scim", org: scope.org.id, name })
          yield* audit("scim.token_create", issued.id, { name })
          return { id: issued.id, token: issued.value, base: `${config.base}/scim/v2` }
        }),
      )
      .handle(
        "scimTokens.revoke",
        Effect.fn(function* (ctx) {
          const scope = yield* Membership
          const row = yield* store.token.get(ctx.params.id)
          if (!row || row.kind !== "scim" || row.org !== scope.org.id)
            return yield* new NotFoundError({ message: "token not found" })
          yield* store.token.revoke(row.id)
          yield* audit("scim.token_revoke", row.id)
          return HttpApiSchema.NoContent.make()
        }),
      )
  }),
)
