import { Cause, Effect, Exit, ManagedRuntime, Predicate, Schema } from "effect"
import { FetchHttpClient, HttpClientError } from "effect/unstable/http"
import { EnterpriseClient } from "@enterprise/protocol/client"

// The console talks to the control plane through the same typed client as the CLI, derived from
// the shared contract. A signed-in browser rides on its session cookie; a pasted access token (for
// example the bootstrap owner token) is kept for this tab only and sent as a bearer token.

const key = "enterprise.token"

export const token = {
  get: () => sessionStorage.getItem(key) ?? undefined,
  set: (value: string) => sessionStorage.setItem(key, value),
  clear: () => sessionStorage.removeItem(key),
}

export type Client = EnterpriseClient.Client

const runtime = ManagedRuntime.make(FetchHttpClient.layer)
let client: Promise<Client> | undefined

export class ApiError extends Error {
  constructor(
    message: string,
    readonly tag?: string,
  ) {
    super(message)
  }
}

function explain(error: unknown) {
  if (HttpClientError.isHttpClientError(error)) return new ApiError("The control plane cannot be reached.")
  if (Schema.isSchemaError(error)) return new ApiError(`Unexpected response from the control plane: ${error.message}`)
  if (Predicate.hasProperty(error, "message") && typeof error.message === "string")
    return new ApiError(error.message, Predicate.hasProperty(error, "_tag") ? String(error._tag) : undefined)
  return new ApiError(String(error))
}

export async function call<A, E>(request: (api: Client) => Effect.Effect<A, E>): Promise<A> {
  const api = await (client ??= runtime.runPromise(EnterpriseClient.make({ url: location.origin, token: token.get() })))
  const exit = await Effect.runPromiseExit(request(api))
  if (Exit.isSuccess(exit)) return exit.value
  throw explain(Cause.squash(exit.cause))
}

export function download(name: string, text: string, type = "text/csv") {
  const url = URL.createObjectURL(new Blob([text], { type }))
  const link = document.createElement("a")
  link.href = url
  link.download = name
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
