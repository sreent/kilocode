import { Account } from "@/account/account"
import { Auth } from "@/auth"
import { Config } from "@/config/config"
import { Enterprise } from "@/enterprise/enterprise" // kilocode_change - enterprise
import { makeRuntime } from "@/effect/run-service"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Effect, Layer, Option } from "effect"

const account = Layer.mock(Account.Service)({
  active: () => Effect.succeed(Option.none()),
})
const config = makeRuntime(Config.Service, AppNodeBuilder.build(Config.node, [[Account.node, account]]))
const auth = makeRuntime(Auth.Service, Auth.defaultLayer)
const enterpriseRuntime = makeRuntime(Enterprise.Service, AppNodeBuilder.build(Enterprise.node)) // kilocode_change - enterprise

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

  // kilocode_change start - enterprise
  export function enterprise() {
    return enterpriseRuntime.runPromise((service) => service.bootstrap())
  }
  // kilocode_change end

  export async function dispose() {
    await Promise.all([config.dispose(), auth.dispose(), enterpriseRuntime.dispose()]) // kilocode_change - enterprise
  }
}
