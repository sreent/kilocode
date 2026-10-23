import { Effect } from "effect"
import { HttpServerResponse } from "effect/unstable/http"
import { HttpApiMiddleware } from "effect/unstable/httpapi"
import { InvalidRequestError, scimBody, scimMedia } from "@enterprise/protocol/errors"
import { SchemaErrorMiddleware } from "@enterprise/protocol/middleware"

// Same cap as core's schema-error middleware: Effect's issue formatter dumps the rejected value,
// which can mirror an entire (possibly secret-bearing) payload back to the caller.
const REASON_LIMIT = 1024

function truncate(reason: string) {
  if (reason.length <= REASON_LIMIT) return reason
  return reason.slice(0, REASON_LIMIT) + `... (${reason.length - REASON_LIMIT} more chars)`
}

export const schemaErrorLayer = HttpApiMiddleware.layerSchemaErrorTransform(SchemaErrorMiddleware, (error, context) => {
  const reason = truncate(error.cause.message)
  const response = context.endpoint.path.startsWith("/scim/")
    ? Effect.succeed(
        HttpServerResponse.jsonUnsafe(scimBody(400, reason, "invalidValue"), { status: 400, contentType: scimMedia }),
      )
    : Effect.fail(new InvalidRequestError({ message: reason, kind: error.kind }))
  return Effect.logWarning("schema rejection").pipe(
    Effect.annotateLogs({ kind: error.kind, reason }),
    Effect.andThen(response),
  )
})
