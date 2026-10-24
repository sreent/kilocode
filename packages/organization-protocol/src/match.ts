import { Wildcard } from "@opencode-ai/core/util/wildcard"
import type { Effective } from "./schema"

// How a client interprets an effective policy. Shared so every client applies the same rules,
// with the same wildcard semantics as the CLI's own permission patterns.

type Entry =
  | { readonly type: "local"; readonly command: ReadonlyArray<string> }
  | { readonly type: "remote"; readonly url: string }

// MCP servers are matched on their target, never their name, which users choose freely.
export function target(entry: Entry) {
  if (entry.type === "remote") return entry.url
  return entry.command.join(" ")
}

// Bare provider ids ("openai") mean every model of that provider.
export function normalize(item: string) {
  if (item.includes("/")) return item
  return `${item}/*`
}

export function allows(
  policy: { readonly models: Effective["models"]; readonly gateway?: Effective["gateway"] },
  provider: string,
  model: string,
) {
  // An exclusive gateway admits only the providers it routes; any other would bypass its metering.
  if (policy.gateway?.exclusive && !policy.gateway.providers.some((item) => item.id === provider)) return false
  const name = `${provider}/${model}`
  if (policy.models.deny.some((pattern) => Wildcard.match(name, pattern))) return false
  if (policy.models.allow === null) return true
  return policy.models.allow.some((pattern) => Wildcard.match(name, pattern))
}

// Why an MCP server may not start under this policy, if it may not.
export function refusal(policy: { readonly mcp: Pick<Effective["mcp"], "allow" | "deny"> }, entry: Entry) {
  const name = target(entry)
  if (policy.mcp.deny.some((pattern) => Wildcard.match(name, pattern)))
    return `Blocked by your organization's MCP policy: ${name}`
  if (policy.mcp.allow && !policy.mcp.allow.some((pattern) => Wildcard.match(name, pattern)))
    return `Not on your organization's MCP allowlist: ${name}`
  return undefined
}

// Cents for everyday amounts, and two significant digits below ten cents, so a single call's cost
// or a small budget isn't rounded into looking free.
export function dollars(value: number) {
  if (value === 0 || value >= 0.1) return `$${value.toFixed(2)}`
  if (value < 0.0001) return "<$0.0001"
  return `$${value.toPrecision(2)}`
}

// Why requests are refused once a budget is spent, if one is. The CLI and the gateway say the same.
export function overBudget(policy: { readonly budget: Pick<Effective["budget"], "limits"> }) {
  const limit = policy.budget.limits.find((item) => item.spent >= item.amount)
  if (!limit) return undefined
  const period = limit.period === "day" ? "daily" : "monthly"
  const scope = limit.scope === "org" ? "organization" : "personal"
  return `Your ${period} ${scope} AI budget of ${dollars(limit.amount)} has been reached (${dollars(limit.spent)} spent). Contact your administrator.`
}
