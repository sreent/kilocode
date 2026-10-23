import type { DatabaseMigration } from "./migration"

export const migrations = (
  await Promise.all([
    import("./migration/20261023084731_init"),
    import("./migration/20261023135725_gateway"),
    import("./migration/20261023143915_audit_streams"),
    import("./migration/20261023160024_saml"),
  ])
).map((module) => module.default) satisfies DatabaseMigration.Migration[]
