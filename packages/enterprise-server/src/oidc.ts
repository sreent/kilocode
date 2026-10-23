export * as Oidc from "./oidc"

import { Clock, Context, Effect, Layer, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose"

// OpenID Connect relying party: discovery, the authorization-code exchange with PKCE, ID token
// verification and the optional userinfo lookup.

const Url = Schema.String.check(Schema.isPattern(/^https?:\/\/\S+$/))

const Discovery = Schema.Struct({
  issuer: Schema.String,
  authorization_endpoint: Url,
  token_endpoint: Url,
  jwks_uri: Url,
  userinfo_endpoint: Schema.optional(Url),
  token_endpoint_auth_methods_supported: Schema.optional(Schema.Array(Schema.String)),
})
export type Discovery = typeof Discovery.Type

const Tokens = Schema.Struct({ id_token: Schema.String, access_token: Schema.optional(Schema.String) })

export class OidcError extends Schema.TaggedErrorClass<OidcError>()("OidcError", { message: Schema.String }) {}

const hour = 60 * 60 * 1000
const trim = (issuer: string) => issuer.replace(/\/$/, "")

export interface Interface {
  readonly discover: (issuer: string) => Effect.Effect<Discovery, OidcError>
  // Exchanges an authorization code. Discovery's default is client_secret_basic; client_secret_post
  // is used when that is all the IdP offers.
  readonly exchange: (input: {
    readonly doc: Discovery
    readonly client: string
    readonly secret: string
    readonly code: string
    readonly verifier: string
    readonly redirect: string
  }) => Effect.Effect<typeof Tokens.Type, OidcError>
  readonly verify: (doc: Discovery, token: string, audience: string) => Effect.Effect<JWTPayload, OidcError>
  // Claims from the userinfo endpoint, when the IdP has one and describes the same subject.
  readonly userinfo: (doc: Discovery, access: string, subject: unknown) => Effect.Effect<Record<string, unknown>>
}

export class Service extends Context.Service<Service, Interface>()("@enterprise/Oidc") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient
    const documents = new Map<string, { at: number; doc: Discovery }>()
    const keys = new Map<string, ReturnType<typeof createRemoteJWKSet>>()
    const decodeDiscovery = Schema.decodeUnknownEffect(Discovery)
    const decodeTokens = Schema.decodeUnknownEffect(Tokens)
    const json = (request: HttpClientRequest.HttpClientRequest) =>
      http
        .execute(HttpClientRequest.acceptJson(request))
        .pipe(Effect.flatMap((response) => Effect.map(response.json, (body) => ({ status: response.status, body }))))

    const discover = Effect.fn("Oidc.discover")(function* (issuer: string) {
      const time = yield* Clock.currentTimeMillis
      const hit = documents.get(issuer)
      if (hit && time - hit.at < hour) return hit.doc
      const response = yield* json(HttpClientRequest.get(`${trim(issuer)}/.well-known/openid-configuration`)).pipe(
        Effect.mapError((error) => new OidcError({ message: `OIDC discovery failed for ${issuer}: ${error.message}` })),
      )
      if (response.status !== 200)
        return yield* new OidcError({ message: `OIDC discovery failed for ${issuer}: HTTP ${response.status}` })
      const doc = yield* decodeDiscovery(response.body).pipe(
        Effect.mapError(() => new OidcError({ message: `OIDC discovery document from ${issuer} is invalid` })),
      )
      // OIDC Discovery 1.0 §4.3: the advertised issuer must match the one we were configured with.
      if (trim(doc.issuer) !== trim(issuer))
        return yield* new OidcError({ message: `OIDC issuer mismatch: ${doc.issuer}` })
      documents.set(issuer, { at: time, doc })
      return doc
    })

    const exchange = Effect.fn("Oidc.exchange")(function* (input: Parameters<Interface["exchange"]>[0]) {
      const basic = (input.doc.token_endpoint_auth_methods_supported ?? ["client_secret_basic"]).includes(
        "client_secret_basic",
      )
      const form = {
        grant_type: "authorization_code",
        code: input.code,
        redirect_uri: input.redirect,
        code_verifier: input.verifier,
        ...(basic ? {} : { client_id: input.client, client_secret: input.secret }),
      }
      const request = HttpClientRequest.post(input.doc.token_endpoint).pipe(
        HttpClientRequest.bodyUrlParams(form),
        // RFC 6749 §2.3.1: credentials are form-encoded before Basic encoding.
        basic
          ? HttpClientRequest.setHeader(
              "authorization",
              `Basic ${btoa(`${encodeURIComponent(input.client)}:${encodeURIComponent(input.secret)}`)}`,
            )
          : (request) => request,
      )
      const response = yield* json(request).pipe(
        Effect.mapError((error) => new OidcError({ message: `Token exchange failed: ${error.message}` })),
      )
      if (response.status !== 200)
        return yield* new OidcError({ message: `Token exchange failed (HTTP ${response.status}).` })
      return yield* decodeTokens(response.body).pipe(
        Effect.mapError(() => new OidcError({ message: "The identity provider did not return an ID token." })),
      )
    })

    const verify = Effect.fn("Oidc.verify")(function* (doc: Discovery, token: string, audience: string) {
      const set = keys.get(doc.jwks_uri) ?? createRemoteJWKSet(new URL(doc.jwks_uri))
      keys.set(doc.jwks_uri, set)
      const verified = yield* Effect.tryPromise({
        try: () => jwtVerify(token, set, { issuer: doc.issuer, audience }),
        catch: (error) => new OidcError({ message: `Invalid ID token: ${(error as Error).message}` }),
      })
      return verified.payload
    })

    const userinfo = Effect.fn("Oidc.userinfo")(function* (doc: Discovery, access: string, subject: unknown) {
      if (!doc.userinfo_endpoint) return {}
      const response = yield* json(
        HttpClientRequest.get(doc.userinfo_endpoint).pipe(HttpClientRequest.bearerToken(access)),
      ).pipe(Effect.orElseSucceed(() => undefined))
      if (!response || response.status !== 200) return {}
      const body = response.body
      if (typeof body !== "object" || body === null || Array.isArray(body)) return {}
      // OIDC Core §5.3.2: userinfo must describe the same subject as the ID token.
      if ((body as Record<string, unknown>).sub !== subject) return {}
      return body as Record<string, unknown>
    })

    return Service.of({ discover, exchange, verify, userinfo })
  }),
)

const httpClient = LayerNode.make({ service: HttpClient.HttpClient, layer: FetchHttpClient.layer, deps: [] })

export const node = LayerNode.make({ service: Service, layer, deps: [httpClient] })
