import { Account } from "@/account/account"
import { Auth } from "@/auth"
import { Config } from "@/config/config"
import { Organization } from "@/organization/organization" // kilocode_change - organization
import { makeRuntime } from "@/effect/run-service"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Effect, Layer, Option } from "effect"

const account = Layer.mock(Account.Service)({
  active: () => Effect.succeed(Option.none()),
})
const config = makeRuntime(Config.Service, AppNodeBuilder.build(Config.node, [[Account.node, account]]))
const auth = makeRuntime(Auth.Service, Auth.defaultLayer)
const organizationRuntime = makeRuntime(Organization.Service, AppNodeBuilder.build(Organization.node)) // kilocode_change - organization

export namespace KiloCliBootstrapRuntime {
  export function getGlobal() {
    return config.runPromise((service) => service.getGlobal())
  }

  export function getAuth() {
    return auth.runPromise((service) => service.get("kilo"))
  }

  export function setAuth(info: Auth.Info) {
    return auth.runPromise((service) => service.set("kilo", info))
  }

  // kilocode_change start - organization
  export function organization() {
    return organizationRuntime.runPromise((service) => service.bootstrap())
  }
  // kilocode_change end

  export async function dispose() {
    await Promise.all([config.dispose(), auth.dispose(), organizationRuntime.dispose()]) // kilocode_change - organization
  }
}
