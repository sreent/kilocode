import { Effect } from "effect"
import { filtering, normalize, shortfall, target } from "@organization/protocol/match"
import {
  gatewayApi,
  type BudgetStatus,
  type Effective,
  type Mode,
  type ModelAccess,
  type Policy,
  type Role,
} from "@organization/protocol/schema"
import type { Org, Store } from "./store"

// How long a client may use an effective policy before polling again (seconds).
export const ttl = 300

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
  gateway?: Effective["gateway"]["providers"]
}): Omit<Effective, "org" | "user" | "ttl"> {
  const grants = [input.policy.models.default, ...input.groups.map((group) => group.models)].filter(
    (grant): grant is ModelAccess => grant != null,
  )
  const open = grants.length === 0 || grants.some((grant) => grant.mode === "all")
  const allow = open
    ? null
    : unique(grants.flatMap((grant) => (grant.mode === "selected" ? grant.items.map(normalize) : [])))

  // With a filter on, only providers whose recorded terms meet every filter are admitted.
  const data = input.policy.data
  const filtered = filtering(data)
  const reasons = Object.fromEntries(
    Object.entries(data.providers).flatMap(([id, terms]) => {
      const reason = filtered ? shortfall(data, terms) : undefined
      return reason ? [[id, reason]] : []
    }),
  )
  const admitted = Object.keys(data.providers)
    .filter((id) => !(id in reasons))
    .toSorted()

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
    gateway: { exclusive: input.policy.gateway.exclusive, providers: input.gateway ?? [] },
    data: {
      training: data.training,
      retention: data.retention,
      regions: data.regions,
      providers: filtered ? admitted : null,
      reasons,
      routing: filtered ? admitted.filter((id) => data.providers[id]?.routing) : [],
    },
  }
}

// The policy one member's clients enforce: what the policy endpoint serves and what the gateway applies.
export const effective = Effect.fn("Policy.effective")(function* (
  store: Store.Interface,
  input: { readonly org: Org; readonly user: { readonly id: string; readonly email: string }; readonly role: Role },
) {
  const current = yield* store.policy.get(input.org.id)
  const groups = yield* store.group.of(input.org.id, input.user.id)
  return {
    org: { id: input.org.id, slug: input.org.slug, name: input.org.name },
    user: { id: input.user.id, email: input.user.email, role: input.role },
    ttl,
    ...resolve({
      policy: current.policy,
      version: current.version,
      groups: groups.map((row) => ({ name: row.name, models: store.group.access(row) })),
      modes: yield* store.mode.list(input.org.id),
      budgets: yield* store.budget.status(input.org.id, input.user.id),
      // Clients speak each provider's API to the gateway; Bedrock and Vertex serve Claude through
      // Anthropic's. A provider clients don't know comes with its name and models.
      gateway: (yield* store.gateway.list(input.org.id)).map((row) => ({
        id: row.id,
        kind: gatewayApi(row.kind),
        ...(row.models.length > 0 ? { name: row.name ?? row.id, models: row.models } : {}),
      })),
    }),
  } satisfies Effective
})
