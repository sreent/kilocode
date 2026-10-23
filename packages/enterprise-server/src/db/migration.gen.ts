import type { DatabaseMigration } from "./migration"

export const migrations = (await Promise.all([import("./migration/20261023084731_init")])).map(
  (module) => module.default,
) satisfies DatabaseMigration.Migration[]
