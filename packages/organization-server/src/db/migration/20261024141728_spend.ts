import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261024141728_spend",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        ALTER TABLE "orgs" ADD COLUMN "seats" integer;
      `)
      yield* tx.run(`
        ALTER TABLE "budgets" DROP CONSTRAINT "budgets_scope", ADD CONSTRAINT "budgets_scope" CHECK ("scope" in ('org', 'member', 'user', 'group', 'suborg'));
      `)
    })
  },
} satisfies DatabaseMigration.Migration
