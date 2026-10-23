import { Permission } from "@/permission"
import * as Enterprise from "./enterprise"

// Kept apart from ./enterprise: @/permission imports config, which imports ./enterprise, so
// importing it there creates an initialization cycle. Only permission-ask code imports this.

// Appends the org's deny rules to an ask's hard ruleset. Hard rules are checked before saved
// approvals and session rules, and these go last, so nothing in a session can override them.
export function harden(rules: Permission.Ruleset | undefined) {
  const policy = Enterprise.permission()
  const org = policy ? Permission.fromConfig(policy).filter((rule) => rule.action === "deny") : []
  if (org.length === 0) return rules
  return [...(rules ?? []), ...org]
}
