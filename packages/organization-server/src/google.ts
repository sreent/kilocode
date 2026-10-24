export * as Google from "./google"

import { Clock, Effect, Schema, Semaphore } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"

// Google Cloud service accounts: a JSON key signs a short-lived JWT, which Google's token endpoint
// exchanges for an hour-long access token (the OAuth 2.0 JWT bearer grant, RFC 7523).
// https://developers.google.com/identity/protocols/oauth2/service-account#httprest

export const Account = Schema.Struct({
  type: Schema.Literal("service_account"),
  client_email: Schema.String.check(Schema.isMinLength(3)),
  private_key: Schema.String.check(Schema.isPattern(/-----BEGIN PRIVATE KEY-----/)),
  token_uri: Schema.optional(Schema.String.check(Schema.isPattern(/^https?:\/\/\S+$/))),
  project_id: Schema.optional(Schema.String),
})
export type Account = typeof Account.Type

// The key as an admin pasted it, or why it can't be used.
export function parse(json: string): Account | string {
  try {
    return Schema.decodeUnknownSync(Account)(JSON.parse(json))
  } catch {
    return "must be a service account's JSON key, with client_email and private_key"
  }
}

const scope = "https://www.googleapis.com/auth/cloud-platform"
const encoder = new TextEncoder()
const base64url = (bytes: Uint8Array | ArrayBuffer | string) =>
  Buffer.from(typeof bytes === "string" ? bytes : new Uint8Array(bytes)).toString("base64url")

// The signed assertion the token endpoint accepts in place of a client secret.
export async function assertion(account: Account, now: number) {
  const pem = account.private_key.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, "").replace(/\s+/g, "")
  const key = await crypto.subtle.importKey(
    "pkcs8",
    Buffer.from(pem, "base64"),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  )
  const seconds = Math.floor(now / 1000)
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))
  const claims = base64url(
    JSON.stringify({
      iss: account.client_email,
      scope,
      aud: account.token_uri ?? "https://oauth2.googleapis.com/token",
      iat: seconds,
      exp: seconds + 3600,
    }),
  )
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, encoder.encode(`${header}.${claims}`))
  return `${header}.${claims}.${base64url(signature)}`
}

const Grant = Schema.Struct({ access_token: Schema.String, expires_in: Schema.optional(Schema.Finite) })

// Access tokens, cached per key until a minute before they expire; one exchange at a time per key.
export function tokens(http: HttpClient.HttpClient) {
  const cache = new Map<string, { token: string; expires: number }>()
  const lock = Semaphore.makeUnsafe(1)
  return Effect.fn("Google.token")(function* (account: Account) {
    const key = `${account.client_email}\n${account.private_key}`
    return yield* lock.withPermits(1)(
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        const cached = cache.get(key)
        if (cached && cached.expires > now + 60_000) return cached.token
        const jwt = yield* Effect.tryPromise({
          try: () => assertion(account, now),
          catch: () => new Error("the service account's private key can't be read"),
        })
        const response = yield* http.execute(
          HttpClientRequest.post(account.token_uri ?? "https://oauth2.googleapis.com/token").pipe(
            HttpClientRequest.bodyUrlParams({
              grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
              assertion: jwt,
            }),
            HttpClientRequest.acceptJson,
          ),
        )
        if (response.status !== 200) {
          const body = yield* response.text.pipe(Effect.orElseSucceed(() => ""))
          return yield* Effect.fail(
            new Error(`Google token exchange failed (${response.status}): ${body.slice(0, 300)}`),
          )
        }
        const grant = yield* response.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Grant)))
        cache.set(key, { token: grant.access_token, expires: now + (grant.expires_in ?? 3600) * 1000 })
        return grant.access_token
      }),
    )
  })
}
