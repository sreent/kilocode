import { normalize, target } from "@enterprise/protocol/match"
import type { BudgetStatus, Effective, Mode, ModelAccess, Policy } from "@enterprise/protocol/schema"

function unique(items: ReadonlyArray<string>) {
  return [...new Set(items)]
}

// Effective model access = org ceiling ∩ (default policy ∪ union of the member's group grants).
// Absence of configuration never restricts; only an explicit "none", or "selected" with nothing
// selected, takes access away.
export function resolve(input: {
  policy: Policy
  version: number
  groups: ReadonlyArray<{ name: string; models: ModelAccess | null }>
  modes: ReadonlyArray<Mode>
  budgets: ReadonlyArray<BudgetStatus>
}): Omit<Effective, "org" | "user" | "ttl"> {
  const grants = [input.policy.models.default, ...input.groups.map((group) => group.models)].filter(
    (grant): grant is ModelAccess => grant != null,
  )
  const open = grants.length === 0 || grants.some((grant) => grant.mode === "all")
  const allow = open
    ? null
    : unique(grants.flatMap((grant) => (grant.mode === "selected" ? grant.items.map(normalize) : [])))

  const servers = input.policy.mcp.servers
  const mcp =
    input.policy.mcp.mode === "open" ? null : unique([...input.policy.mcp.allow, ...Object.values(servers).map(target)])

  return {
    version: input.version,
    groups: input.groups.map((group) => group.name),
    models: { allow, deny: unique(input.policy.models.blocked.map(normalize)) },
    mcp: { allow: mcp, deny: input.policy.mcp.block, servers },
    permission: input.policy.permission,
    instructions: input.policy.instructions ?? null,
    agents: Object.fromEntries(
      input.modes.map((mode) => [
        mode.slug,
        {
          description: mode.description || mode.name,
          prompt: mode.prompt,
          mode: mode.mode,
          ...(mode.model ? { model: mode.model } : {}),
          ...(mode.permission ? { permission: mode.permission } : {}),
        },
      ]),
    ),
    share: input.policy.share,
    telemetry: input.policy.telemetry,
    budget: { exceeded: input.budgets.some((budget) => budget.spent >= budget.amount), limits: input.budgets },
  }
}
