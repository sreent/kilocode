import { Context } from "effect"
import type { Role } from "./schema"

const all: Role[] = ["owner", "admin", "member", "billing_manager"]
const managers: Role[] = ["owner", "admin", "billing_manager"]

// Mirrors the Kilo Enterprise role model: owners hold governance (model access, groups,
// org settings), admins run the team, billing managers see spend and set budgets.
export const capabilities = {
  "org.read": all,
  "org.write": ["owner"],
  "member.read": managers,
  "member.write": ["owner", "admin"],
  "invite.write": ["owner", "admin"],
  "group.read": managers,
  "group.write": ["owner"],
  "policy.read": managers,
  "policy.write": ["owner"],
  "mode.read": all,
  "mode.write": ["owner", "admin"],
  "audit.read": ["owner", "admin"],
  "usage.read": managers,
  "budget.write": ["owner", "billing_manager"],
  "sso.write": ["owner", "admin"],
  "domain.write": ["owner", "admin"],
  "scim.write": ["owner", "admin"],
  "token.write": ["owner", "admin"],
  "suborg.read": managers,
  "suborg.write": ["owner", "admin"],
} satisfies Record<string, Role[]>

export type Capability = keyof typeof capabilities

export function can(role: Role | undefined, capability: Capability) {
  if (!role) return false
  return (capabilities[capability] as Role[]).includes(role)
}

// Parent-org managers get the same role in sub-orgs without becoming members.
export const inherited: Role[] = managers

// Endpoint annotation: the capability an org-scoped endpoint requires. OrgScope enforces it before
// the request body is read, so a caller without the role learns nothing from validation errors.
export class Requires extends Context.Service<Requires, Capability>()("@enterprise/Requires") {}
