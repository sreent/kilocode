// kilocode_change - new file (enterprise)
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "@/server/routes/instance/httpapi/middleware/authorization"
import { InstanceContextMiddleware } from "@/server/routes/instance/httpapi/middleware/instance-context"
import {
  WorkspaceRoutingMiddleware,
  WorkspaceRoutingQuery,
} from "@/server/routes/instance/httpapi/middleware/workspace-routing"
import { described } from "@/server/routes/instance/httpapi/groups/metadata"

// Organization sign-in and status for the IDEs, which drive `kilo serve` instead of the terminal
// commands. Enrollment is per device, so these routes act on the whole server, not one directory.

const root = "/kilo/enterprise"

export const EnterpriseSignin = Schema.Struct({
  url: Schema.String,
  org: Schema.String,
  code: Schema.String.annotate({ description: "Code the person confirms in the browser" }),
  verification: Schema.String.annotate({ description: "Page where the code is confirmed" }),
  link: Schema.String.annotate({ description: "The same page with the code filled in" }),
  expires: Schema.Finite,
})

// Fields that don't apply are left out (the SDK pipeline drops nulls): a device that isn't enrolled
// reports only `enabled`, `required` and an empty `gateway`.
export const EnterpriseStatus = Schema.Struct({
  enabled: Schema.Boolean.annotate({
    description: "False when no enterprise.json, environment variables or stored sign-in enroll this device",
  }),
  source: Schema.optional(Schema.Literals(["managed", "env", "login"])),
  url: Schema.optional(Schema.String),
  org: Schema.optional(Schema.Struct({ slug: Schema.String, name: Schema.optional(Schema.String) })),
  required: Schema.Boolean.annotate({ description: "The agent may not run until the person signs in" }),
  user: Schema.optional(Schema.Struct({ email: Schema.String, role: Schema.String })),
  policy: Schema.optional(Schema.Struct({ version: Schema.Finite, fetched: Schema.Finite })),
  blocked: Schema.optional(Schema.String).annotate({ description: "Why the agent cannot run right now" }),
  error: Schema.optional(Schema.String).annotate({ description: "The last policy refresh failure" }),
  gateway: Schema.Array(Schema.String).annotate({ description: "Providers routed through the org's LLM gateway" }),
  signin: Schema.optional(EnterpriseSignin).annotate({ description: "A device sign-in waiting for approval" }),
})

export const EnterpriseSigninInput = Schema.Struct({
  url: Schema.optional(Schema.String),
  org: Schema.optional(Schema.String),
  token: Schema.optional(Schema.String).annotate({
    description: "Sign in with an access token from an administrator instead of the browser",
  }),
})

export class EnterpriseSigninError extends Schema.ErrorClass<EnterpriseSigninError>("EnterpriseSigninError")(
  { name: Schema.Literal("EnterpriseSigninError"), message: Schema.String },
  { httpApiStatus: 400 },
) {}

export const EnterprisePaths = {
  status: `${root}/status`,
  signin: `${root}/signin`,
  wait: `${root}/signin/wait`,
  signout: `${root}/signout`,
} as const

export const EnterpriseApi = HttpApi.make("enterprise")
  .add(
    HttpApiGroup.make("enterprise")
      .add(
        HttpApiEndpoint.get("status", EnterprisePaths.status, {
          query: WorkspaceRoutingQuery,
          success: described(EnterpriseStatus, "Organization status"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "enterprise.status",
            summary: "Get organization status",
            description: "Sign-in, policy and blocking state of the self-hosted enterprise enrollment.",
          }),
        ),
        HttpApiEndpoint.post("signin", EnterprisePaths.signin, {
          query: WorkspaceRoutingQuery,
          payload: EnterpriseSigninInput,
          success: described(EnterpriseStatus, "Status, with the waiting sign-in, or signed in when a token was given"),
          error: [HttpApiError.BadRequest, EnterpriseSigninError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "enterprise.signin",
            summary: "Sign in to the organization",
            description:
              "Start a device sign-in and return its code and link, or sign in at once with an access token.",
          }),
        ),
        HttpApiEndpoint.post("wait", EnterprisePaths.wait, {
          query: WorkspaceRoutingQuery,
          success: described(EnterpriseStatus, "Status after the sign-in was approved"),
          error: [HttpApiError.BadRequest, EnterpriseSigninError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "enterprise.wait",
            summary: "Wait for the device sign-in",
            description: "Block until the waiting device sign-in is approved, denied or expires.",
          }),
        ),
        HttpApiEndpoint.post("signout", EnterprisePaths.signout, {
          query: WorkspaceRoutingQuery,
          success: described(EnterpriseStatus, "Status after signing out"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "enterprise.signout",
            summary: "Sign out of the organization",
            description: "Revoke and forget this device's organization sign-in and cached policy.",
          }),
        ),
      )
      .annotateMerge(OpenApi.annotations({ title: "enterprise", description: "Self-hosted enterprise routes." }))
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "enterprise HttpApi",
      version: "0.0.1",
      description: "Self-hosted enterprise HttpApi surface.",
    }),
  )
