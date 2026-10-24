import type { DatabaseMigration } from "./migration"

export const migrations = (
  await Promise.all([
    import("./migration/20261023172159_init"),
    import("./migration/20261024125439_gateway"),
    import("./migration/20261024141728_spend"),
  ])
).map((module) => module.default) satisfies DatabaseMigration.Migration[]
