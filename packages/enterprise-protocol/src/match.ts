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

export function allows(policy: { readonly models: Effective["models"] }, provider: string, model: string) {
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
