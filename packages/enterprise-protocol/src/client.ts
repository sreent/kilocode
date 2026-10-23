export * as EnterpriseClient from "./client"

import type { Effect } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import { HttpApiClient } from "effect/unstable/httpapi"
import { Api } from "./api"

// A typed client for the control plane, derived from the shared contract. The CLI and IDEs send a
// bearer token; the admin console omits it and rides on its session cookie.
export const make = (options: { readonly url: string; readonly token?: string }) =>
  HttpApiClient.make(Api, {
    baseUrl: options.url,
    transformClient: options.token ? HttpClient.mapRequest(HttpClientRequest.bearerToken(options.token)) : undefined,
  })

export type Client = Effect.Success<ReturnType<typeof make>>
