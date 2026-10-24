import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261024142807_reports",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE "reports" (
          "id" text PRIMARY KEY,
          "org" text NOT NULL,
          "name" text NOT NULL,
          "cadence" text NOT NULL,
          "format" text NOT NULL,
          "url" text NOT NULL,
          "secret" text NOT NULL,
          "enabled" boolean DEFAULT true NOT NULL,
          "next" bigint NOT NULL,
          "lease" bigint,
          "sent" bigint,
          "error" text,
          "created" bigint NOT NULL,
          CONSTRAINT "reports_cadence" CHECK ("cadence" in ('weekly', 'monthly')),
          CONSTRAINT "reports_format" CHECK ("format" in ('text', 'json'))
        );
      `)
      yield* tx.run(`
        CREATE INDEX "reports_org" ON "reports" ("org");
      `)
      yield* tx.run(`
        CREATE INDEX "reports_next" ON "reports" ("next");
      `)
      yield* tx.run(`
        ALTER TABLE "reports" ADD CONSTRAINT "reports_org_orgs_id_fkey" FOREIGN KEY ("org") REFERENCES "orgs"("id") ON DELETE CASCADE;
      `)
    })
  },
} satisfies DatabaseMigration.Migration
