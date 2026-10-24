import { Clock, Effect } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"
import { HttpApiBuilder, HttpApiSchema } from "effect/unstable/httpapi"
import { Api } from "@organization/protocol/api"
import { InvalidRequestError, NotFoundError } from "@organization/protocol/errors"
import { Membership } from "@organization/protocol/middleware"
import { defaultAuth, instant, type GatewayAuth } from "@organization/protocol/schema"
import * as Crypto from "../crypto"
import { ServerConfig } from "../config"
import { Google } from "../google"
import { RequestContext } from "../request"
import { Store, type GatewayCall, type GatewayProvider } from "../store"
import { Upstream } from "../upstream"

// Admins see a provider's key only as its last characters, and only when the key is long enough
// that those give nothing away.
export const hint = (key: string) => (key.length >= 16 ? key.slice(-4) : "")

// What tells a credential apart: a key's last characters, an AWS access key id's, a service account's email.
function identify(auth: GatewayAuth, key: string) {
  if (auth.type === "none") return ""
  if (auth.type === "aws") return auth.access_key.slice(-4)
  if (auth.type === "google") {
    const account = Google.parse(key)
    return typeof account === "string" ? "" : account.client_email
  }
  return hint(key)
}

// Provider ids whose own client SDK differs from the API the gateway speaks; a provider defined
// with them would make clients load the wrong SDK.
const reserved = new Set(["amazon-bedrock", "google-vertex", "google-vertex-anthropic", "azure"])

const view = (row: GatewayProvider) => ({
  id: row.id,
  kind: row.kind,
  base: row.base,
  auth: Upstream.auth(row),
  hint: row.hint,
  headers: row.names,
  query: row.query,
  name: row.name,
  models: row.models,
  created: row.created,
  updated: row.updated,
})

const call = (row: Omit<GatewayCall, "request" | "response"> & { email: string | null; bodies: boolean }) => ({
  id: row.id,
  at: row.at,
  user: row.user && row.email ? { id: row.user, email: row.email } : null,
  provider: row.provider,
  model: row.model,
  method: row.method,
  path: row.path,
  status: row.status,
  code: row.code,
  latency: row.latency,
  tokens: {
    input: row.input,
    output: row.output,
    reasoning: row.reasoning,
    read: row.cache_read,
    write: row.cache_write,
  },
  cost: row.cost,
  session: row.session,
  project: row.project,
  ip: row.ip,
  bodies: row.bodies,
})

const day = 24 * 60 * 60 * 1000

export const GatewayHandler = HttpApiBuilder.group(Api, "organization.gateway", (handlers) =>
  Effect.gen(function* () {
    const store = yield* Store.Service
    const config = yield* ServerConfig.Service
    const http = yield* HttpClient.HttpClient
    const token = Google.tokens(http)
    const audit = RequestContext.auditor(store, config)

    return handlers
      .handle(
        "gateway.get",
        Effect.fn(function* () {
          const scope = yield* Membership
          return { url: `${config.base}/gateway`, providers: (yield* store.gateway.list(scope.org.id)).map(view) }
        }),
      )
      .handle(
        "gateway.set",
        Effect.fn(function* (ctx) {
          const scope = yield* Membership
          if (!config.secret)
            return yield* new InvalidRequestError({
              message: "set ORGANIZATION_SECRET on the server before adding gateway providers",
            })
          const input = ctx.payload
          const id = ctx.params.id
          const current = yield* store.gateway.get(scope.org.id, id)
          const auth = input.auth ?? defaultAuth(input.kind)
          const invalid = (message: string) => new InvalidRequestError({ message })

          if (input.kind === "bedrock" && auth.type !== "aws" && auth.type !== "bearer")
            return yield* invalid("Bedrock takes an AWS access key, or a Bedrock API key as a bearer key")
          if (input.kind === "vertex" && auth.type !== "google")
            return yield* invalid("Vertex AI takes a Google Cloud service account key")
          if (auth.type === "aws" && input.kind !== "bedrock" && input.kind !== "openai-compatible")
            return yield* invalid("an AWS access key signs requests to Amazon Bedrock only")
          const custom = input.kind === "bedrock" || input.kind === "vertex"
          if (custom && input.models.length === 0)
            return yield* invalid(
              "list the models clients may use; Bedrock and Vertex model ids aren't in their catalog",
            )
          if (input.models.length > 0 && reserved.has(id))
            return yield* invalid(
              `${id} is the id of a provider clients have their own SDK for; use another id, such as ${input.kind === "vertex" ? "vertex-claude" : "bedrock-claude"}`,
            )
          const ids = new Set<string>()
          for (const model of input.models) {
            if (ids.has(model.id)) return yield* invalid(`the model ${model.id} is listed twice`)
            ids.add(model.id)
          }

          const key = input.key?.trim()
          const before = current ? Upstream.auth(current) : undefined
          // A different kind of credential, or another AWS access key, needs its own secret; an API
          // key stays one whichever header carries it.
          const family = (item: GatewayAuth) => (item.type === "bearer" || item.type === "header" ? "key" : item.type)
          const changed =
            !before ||
            family(before) !== family(auth) ||
            (before.type === "aws" && auth.type === "aws" && before.access_key !== auth.access_key)
          if (auth.type !== "none" && changed && !key)
            return yield* invalid(
              auth.type === "aws"
                ? "the AWS secret access key is required"
                : auth.type === "google"
                  ? "the service account's JSON key is required"
                  : "key is required",
            )
          if (auth.type === "google" && key) {
            const account = Google.parse(key)
            if (typeof account === "string") return yield* invalid(`the service account key ${account}`)
          }
          const secret = key ?? (auth.type === "none" ? "" : undefined)
          const headers =
            input.headers === undefined
              ? { sealed: current?.headers ?? null, names: current?.names ?? [] }
              : yield* Effect.gen(function* () {
                  const entries = Object.entries(input.headers!).map(
                    ([name, value]) => [name.toLowerCase(), value] as const,
                  )
                  return entries.length === 0
                    ? { sealed: null, names: [] }
                    : {
                        sealed: yield* Crypto.seal(config.secret!, JSON.stringify(Object.fromEntries(entries))),
                        names: entries.map(([name]) => name).sort(),
                      }
                })
          const row = yield* store.gateway.set(scope.org.id, id, {
            kind: input.kind,
            base: input.base.replace(/\/+$/, ""),
            // The default is stored as null, so it follows the kind if an admin switches kinds.
            auth: input.auth ?? null,
            secret: secret !== undefined ? yield* Crypto.seal(config.secret, secret) : current!.secret,
            hint: secret !== undefined ? identify(auth, secret) : current!.hint,
            headers: headers.sealed,
            names: headers.names,
            query: { ...input.query },
            name: input.name ?? null,
            models: input.models.map((model) => ({ ...model })),
          })
          yield* audit(current ? "gateway.provider_update" : "gateway.provider_create", row!.id, {
            kind: row!.kind,
            base: row!.base,
            auth: auth.type,
            headers: headers.names,
            query: Object.keys(row!.query),
            models: row!.models.length,
            key_rotated: current !== undefined && key !== undefined,
          })
          return view(row!)
        }),
      )
      .handle(
        "gateway.remove",
        Effect.fn(function* (ctx) {
          const scope = yield* Membership
          if (!(yield* store.gateway.remove(scope.org.id, ctx.params.id)))
            return yield* new NotFoundError({ message: "gateway provider not found" })
          yield* audit("gateway.provider_remove", ctx.params.id)
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "gateway.discover",
        Effect.fn(function* (ctx) {
          const scope = yield* Membership
          const provider = yield* store.gateway.get(scope.org.id, ctx.params.id)
          if (!provider) return yield* new NotFoundError({ message: "gateway provider not found" })
          if (provider.kind === "bedrock" || provider.kind === "vertex")
            return yield* new InvalidRequestError({
              message:
                "Bedrock and Vertex don't list Claude models through this API; add the model ids you have access to",
            })
          if (!config.secret)
            return yield* new InvalidRequestError({ message: "ORGANIZATION_SECRET is not set on the server" })
          const listed = yield* Effect.gen(function* () {
            const key = yield* Crypto.unseal(config.secret!, provider.secret)
            const headers = provider.headers
              ? (JSON.parse(yield* Crypto.unseal(config.secret!, provider.headers)) as Record<string, string>)
              : {}
            const prepared = yield* Upstream.prepare({
              provider,
              secrets: { key, headers },
              method: "GET",
              url: `${provider.base}/models`,
              headers: { accept: "application/json" },
              body: undefined,
              token,
            })
            const response = yield* http
              .execute(HttpClientRequest.get(prepared.url).pipe(HttpClientRequest.setHeaders(prepared.headers)))
              .pipe(
                Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
                Effect.timeout("30 seconds"),
              )
            if (response.status !== 200)
              return yield* Effect.fail(new Error(`the upstream answered ${response.status}`))
            return (yield* response.json) as { data?: unknown }
          }).pipe(
            Effect.mapError(
              (error) =>
                new InvalidRequestError({
                  message: `could not list ${provider.id}'s models: ${error instanceof Error ? error.message : String(error)}`,
                }),
            ),
          )
          const models = (Array.isArray(listed.data) ? listed.data : [])
            .filter((item): item is { id: string; display_name?: unknown } => typeof item?.id === "string")
            .map((item) => ({
              id: item.id,
              ...(typeof item.display_name === "string" ? { name: item.display_name } : {}),
            }))
            .sort((a, b) => a.id.localeCompare(b.id))
          return { models }
        }),
      )
      .handle(
        "gateway.calls",
        Effect.fn(function* (ctx) {
          const scope = yield* Membership
          const now = yield* Clock.currentTimeMillis
          const rows = yield* store.call.list({
            org: scope.org.id,
            from: ctx.query.from ? instant(ctx.query.from, 0) : now - 30 * day,
            to: ctx.query.to ? instant(ctx.query.to, 0) : now + 1,
            user: ctx.query.user,
            provider: ctx.query.provider,
            failed: ctx.query.failed === undefined ? undefined : ctx.query.failed === "true",
            before: ctx.query.before,
            limit: Math.min(Math.max(ctx.query.limit || 100, 1), 1000),
          })
          const calls = rows.map(call)
          return { calls, next: calls.length > 0 ? calls.at(-1)!.id : null }
        }),
      )
      .handle(
        "gateway.call",
        Effect.fn(function* (ctx) {
          const scope = yield* Membership
          const row = yield* store.call.get(scope.org.id, ctx.params.id)
          if (!row) return yield* new NotFoundError({ message: "gateway call not found" })
          const { request, response, ...rest } = row
          return {
            ...call({ ...rest, bodies: request !== null || response !== null }),
            request,
            response,
          }
        }),
      )
  }),
)
