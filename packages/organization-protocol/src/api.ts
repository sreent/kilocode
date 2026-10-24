import { HttpApi, OpenApi } from "effect/unstable/httpapi"
import { AccountGroup } from "./groups/account"
import { GatewayGroup, GovernanceGroup, IdentityGroup, InsightGroup, OrgGroup, PeopleGroup } from "./groups/org"
import { HealthGroup, SigninGroup } from "./groups/public"
import { ScimGroup } from "./groups/scim"
import { RateLimit, SchemaErrorMiddleware } from "./middleware"

// The single source of truth for the control plane's HTTP surface. The server implements it,
// and the CLI and admin console derive typed clients from it with HttpApiClient.
export const Api = HttpApi.make("organization")
  .add(HealthGroup)
  .add(SigninGroup)
  .add(AccountGroup)
  .add(OrgGroup)
  .add(PeopleGroup)
  .add(GovernanceGroup)
  .add(InsightGroup)
  .add(IdentityGroup)
  .add(GatewayGroup)
  .add(ScimGroup)
  .annotateMerge(
    OpenApi.annotations({
      title: "Organization server",
      version: "0.2.0",
      description:
        "Organizations, single sign-on, SCIM provisioning, policy, audit, usage and the LLM gateway for TU Code clients.",
    }),
  )
  .middleware(SchemaErrorMiddleware)
  .middleware(RateLimit)
