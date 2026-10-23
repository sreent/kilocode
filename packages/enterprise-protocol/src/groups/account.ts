import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/unstable/httpapi"
import { NotFoundError } from "../errors"
import { Authorization } from "../middleware"
import { Issued, Me, Token } from "../schema"

// The caller's own account: identity, personal tokens, sign-out.
export const AccountGroup = HttpApiGroup.make("enterprise.account")
  .add(HttpApiEndpoint.get("me.get", "/api/v1/me", { success: Me }))
  .add(
    HttpApiEndpoint.get("tokens.list", "/api/v1/me/tokens", {
      success: Schema.Struct({ tokens: Schema.Array(Token) }),
    }),
  )
  .add(
    HttpApiEndpoint.post("tokens.create", "/api/v1/me/tokens", {
      payload: Schema.Struct({
        name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
        days: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 365 }))),
      }),
      success: Issued.pipe(HttpApiSchema.status(201)),
    }),
  )
  .add(
    HttpApiEndpoint.delete("tokens.revoke", "/api/v1/me/tokens/:id", {
      params: { id: Schema.String },
      success: HttpApiSchema.NoContent,
      error: NotFoundError,
    }),
  )
  .add(HttpApiEndpoint.post("logout", "/api/v1/auth/logout", { success: HttpApiSchema.NoContent }))
  .middleware(Authorization)
