export * as Upstream from "./upstream"

import { AwsV4Signer } from "aws4fetch"
import { Effect } from "effect"
import { defaultAuth, type GatewayAuth } from "@organization/protocol/schema"
import { Google } from "./google"
import type { GatewayProvider } from "./store"

// How the gateway presents itself to a provider's upstream: the admin's extra query parameters
// and headers, then the credential, as a header, an AWS signature or a Google access token.

// A provider's secrets, unsealed for one call.
export type Secrets = { readonly key: string; readonly headers: Readonly<Record<string, string>> }

export const auth = (provider: Pick<GatewayProvider, "auth" | "kind">): GatewayAuth =>
  provider.auth ?? defaultAuth(provider.kind)

export const prepare = Effect.fn("Upstream.prepare")(function* (input: {
  readonly provider: GatewayProvider
  readonly secrets: Secrets
  readonly method: "GET" | "POST"
  readonly url: string
  // Lowercase names.
  readonly headers: Readonly<Record<string, string>>
  readonly body: Uint8Array | undefined
  readonly token: (account: Google.Account) => Effect.Effect<string, Error>
}) {
  const url = new URL(input.url)
  for (const [name, value] of Object.entries(input.provider.query)) url.searchParams.set(name, value)
  const headers: Record<string, string> = { ...input.headers }
  for (const [name, value] of Object.entries(input.secrets.headers)) headers[name.toLowerCase()] = value
  const method = auth(input.provider)
  if (method.type === "bearer") headers.authorization = `Bearer ${input.secrets.key}`
  if (method.type === "header") headers[method.name.toLowerCase()] = input.secrets.key
  if (method.type === "google") {
    const account = Google.parse(input.secrets.key)
    if (typeof account === "string") return yield* Effect.fail(new Error(`the service account key ${account}`))
    headers.authorization = `Bearer ${yield* input.token(account)}`
  }
  if (method.type === "aws") {
    const signed = yield* Effect.promise(() =>
      new AwsV4Signer({
        method: input.method,
        url: url.toString(),
        headers,
        body: input.body as Uint8Array<ArrayBuffer> | undefined,
        accessKeyId: method.access_key,
        secretAccessKey: input.secrets.key,
        service: "bedrock",
        region: method.region,
      }).sign(),
    )
    return { url: signed.url.toString(), headers: Object.fromEntries(signed.headers) }
  }
  return { url: url.toString(), headers }
})
