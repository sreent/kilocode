import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261024144213_tool_audit",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        ALTER TABLE "audit" ADD COLUMN "ref" text;
      `)
      yield* tx.run(`
        CREATE UNIQUE INDEX "audit_org_ref" ON "audit" ("org","ref");
      `)
    })
  },
} satisfies DatabaseMigration.Migration
