import { Cause, Effect } from "effect"
import {
  HttpRouter,
  HttpServerError,
  HttpServerRequest,
  HttpServerRespondable,
  HttpServerResponse,
} from "effect/unstable/http"
import { scimBody, scimMedia } from "@enterprise/protocol/errors"

// Typed HttpApi failures keep their declared error path; this boundary only replaces defects, which
// would otherwise be empty 500s. Same shape as core's error middleware.
export const errorLayer = HttpRouter.middleware<{ handles: unknown }>()((effect) =>
  effect.pipe(
    Effect.catchCause((cause) =>
      Effect.gen(function* () {
        const defect = cause.reasons.filter(Cause.isDieReason).find((reason) => {
          if (HttpServerResponse.isHttpServerResponse(reason.defect)) return false
          if (HttpServerError.isHttpServerError(reason.defect)) return false
          if (HttpServerRespondable.isRespondable(reason.defect)) return false
          return true
        })
        if (!defect) return yield* Effect.failCause(cause)
        const request = yield* HttpServerRequest.HttpServerRequest
        const scim = new URL(request.url, "http://localhost").pathname.startsWith("/scim/")
        // A body that isn't JSON at all fails while the payload is parsed, before any schema runs.
        if (defect.defect instanceof SyntaxError) {
          const message = "request body must be valid JSON"
          return scim
            ? HttpServerResponse.jsonUnsafe(scimBody(400, message, "invalidSyntax"), {
                status: 400,
                contentType: scimMedia,
              })
            : HttpServerResponse.jsonUnsafe({ _tag: "InvalidRequestError", message }, { status: 400 })
        }
        const ref = `err_${crypto.randomUUID().slice(0, 8)}`
        yield* Effect.logError("unhandled error").pipe(Effect.annotateLogs({ ref, cause: Cause.pretty(cause) }))
        return scim
          ? HttpServerResponse.jsonUnsafe(scimBody(500, `internal error (${ref})`), {
              status: 500,
              contentType: scimMedia,
            })
          : HttpServerResponse.jsonUnsafe(
              { _tag: "UnknownError", message: "Unexpected server error. Check server logs for details.", ref },
              { status: 500 },
            )
      }),
    ),
  ),
).layer

// Baseline security headers on every response (the defaults the server has always sent).
const security = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "SAMEORIGIN",
  "referrer-policy": "no-referrer",
  "strict-transport-security": "max-age=15552000; includeSubDomains",
  "cross-origin-opener-policy": "same-origin",
  "origin-agent-cluster": "?1",
  "x-dns-prefetch-control": "off",
  "x-download-options": "noopen",
  "x-permitted-cross-domain-policies": "none",
  "x-xss-protection": "0",
}

export const headersLayer = HttpRouter.middleware(
  (effect) => Effect.map(effect, (response) => HttpServerResponse.setHeaders(response, security)),
  { global: true },
)
