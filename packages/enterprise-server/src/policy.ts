import { z } from "zod"

// Model access policy for a member set: everything, an explicit selection, or nothing.
export const Access = z.object({
  mode: z.enum(["all", "selected", "none"]),
  items: z.array(z.string().min(1)).default([]),
})
export type Access = z.infer<typeof Access>

const Action = z.enum(["allow", "ask", "deny"])

// Same shape as the CLI `permission` config: either one action, or patterns mapped to actions.
export const Permission = z.record(z.string(), z.union([Action, z.record(z.string(), Action)]))
export type Permission = z.infer<typeof Permission>

// Same shape as the CLI `mcp` config entries, so org servers can be pushed to clients verbatim.
const Local = z.looseObject({
  type: z.literal("local"),
  command: z.array(z.string()).min(1),
  environment: z.record(z.string(), z.string()).optional(),
})
const Remote = z.looseObject({
  type: z.literal("remote"),
  url: z.url(),
  headers: z.record(z.string(), z.string()).optional(),
})
export const Server = z.discriminatedUnion("type", [Local, Remote])
export type Server = z.infer<typeof Server>

export const Policy = z.object({
  models: z
    .object({
      // Org-wide ceiling. A bare provider id ("openai") blocks all of its models; anything with a
      // slash is a glob over "provider/model" ("openrouter/*:free", "kilo/anthropic/claude-opus-*").
      blocked: z.array(z.string().min(1)).default([]),
      // Applies to every member before group grants are unioned in. Unset means no restriction.
      default: Access.optional(),
    })
    .prefault({}),
  mcp: z
    .object({
      // "open": any server not blocked may run. "allowlist": only servers matching `allow` may run.
      mode: z.enum(["open", "allowlist"]).default("open"),
      // Globs matched against the server target: the URL for remote servers, the command line for local ones.
      // Server names are chosen by users and are never trusted for matching.
      allow: z.array(z.string().min(1)).default([]),
      block: z.array(z.string().min(1)).default([]),
      // Org-provided servers pushed into every client's config.
      servers: z.record(z.string(), Server).default({}),
    })
    .prefault({}),
  // Deny rules are enforced as hard rules on clients; allow/ask rules become defaults users can tighten.
  permission: Permission.default({}),
  // Org-wide rules appended to the agent system prompt.
  instructions: z.string().max(50_000).optional(),
  // Session sharing and syncing sessions to the upstream vendor's cloud. Off unless an org opts in.
  share: z.enum(["allowed", "disabled"]).default("disabled"),
  telemetry: z
    .object({
      // Product analytics sent to the upstream vendor. Enterprises usually turn this off.
      product: z.boolean().default(false),
    })
    .prefault({}),
})
export type Policy = z.infer<typeof Policy>

export const Mode = z.object({
  slug: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]*$/)
    .max(64),
  name: z.string().min(1).max(128),
  description: z.string().max(2000).default(""),
  prompt: z.string().max(50_000),
  model: z.string().optional(),
  mode: z.enum(["primary", "subagent", "all"]).default("primary"),
  permission: Permission.optional(),
})
export type Mode = z.infer<typeof Mode>

export function target(server: Server) {
  if (server.type === "remote") return server.url
  return server.command.join(" ")
}

function normalize(item: string) {
  if (item.includes("/")) return item
  return `${item}/*`
}

function unique(items: string[]) {
  return [...new Set(items)]
}

export type Budget = {
  scope: "org" | "member" | "user"
  period: "day" | "month"
  amount: number
  spent: number
}

export type Effective = ReturnType<typeof resolve>

// Effective model access = org ceiling ∩ (default policy ∪ union of the member's group grants).
// Absence of configuration never restricts; only an explicit "none", or "selected" with nothing
// selected, takes access away.
export function resolve(input: {
  policy: Policy
  version: number
  groups: { name: string; models: Access | null }[]
  modes: Mode[]
  budgets: Budget[]
}) {
  const grants = [input.policy.models.default, ...input.groups.map((group) => group.models)].filter(
    (grant): grant is Access => grant != null,
  )
  const open = grants.length === 0 || grants.some((grant) => grant.mode === "all")
  const allow = open
    ? null
    : unique(grants.flatMap((grant) => (grant.mode === "selected" ? grant.items.map(normalize) : [])))

  const servers = input.policy.mcp.servers
  const mcp =
    input.policy.mcp.mode === "open" ? null : unique([...input.policy.mcp.allow, ...Object.values(servers).map(target)])

  const exceeded = input.budgets.find((budget) => budget.spent >= budget.amount)

  return {
    version: input.version,
    groups: input.groups.map((group) => group.name),
    models: {
      allow,
      deny: unique(input.policy.models.blocked.map(normalize)),
    },
    mcp: {
      allow: mcp,
      deny: input.policy.mcp.block,
      servers,
    },
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
    budget: {
      exceeded: exceeded != null,
      limits: input.budgets,
    },
  }
}
