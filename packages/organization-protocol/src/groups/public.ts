import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { DeviceError, ForbiddenError, InvalidRequestError, NotFoundError } from "../errors"
import { DeviceGrant, DeviceStart, Signin } from "../schema"

export const HealthGroup = HttpApiGroup.make("organization.health").add(
  HttpApiEndpoint.get("health.get", "/healthz", { success: Schema.Struct({ ok: Schema.Literal(true) }) }),
)

// Unauthenticated sign-in flows: RFC 8628 device authorization and invite acceptance.
export const SigninGroup = HttpApiGroup.make("organization.signin")
  .add(
    HttpApiEndpoint.post("device.start", "/api/v1/auth/device", {
      payload: Schema.Struct({ org: Schema.String.check(Schema.isMinLength(1)) }),
      success: DeviceStart,
      error: [NotFoundError, InvalidRequestError],
    }).annotateMerge(OpenApi.annotations({ summary: "Start a device login for the CLI or an IDE" })),
  )
  .add(
    HttpApiEndpoint.post("device.token", "/api/v1/auth/device/token", {
      payload: Schema.Struct({ device_code: Schema.String.check(Schema.isMinLength(1)) }),
      success: DeviceGrant,
      error: DeviceError,
    }).annotateMerge(OpenApi.annotations({ summary: "Poll for the token of an approved device login" })),
  )
  .add(
    HttpApiEndpoint.post("invite.accept", "/api/v1/invites/:token/accept", {
      params: { token: Schema.String },
      payload: Schema.Struct({ name: Schema.optional(Schema.String.check(Schema.isMaxLength(200))) }),
      success: Signin,
      error: [NotFoundError, ForbiddenError],
    }).annotateMerge(OpenApi.annotations({ summary: "Accept an invite and receive an access token" })),
  )
