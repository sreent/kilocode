import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261023143915_audit_streams",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`audit_streams\` (
          \`id\` text PRIMARY KEY,
          \`org\` text NOT NULL,
          \`name\` text NOT NULL,
          \`target\` text NOT NULL,
          \`secret\` text,
          \`headers\` text,
          \`names\` text DEFAULT '[]' NOT NULL,
          \`enabled\` integer DEFAULT true NOT NULL,
          \`cursor\` integer DEFAULT 0 NOT NULL,
          \`delivered\` integer,
          \`error\` text,
          \`failing\` integer,
          \`failures\` integer DEFAULT 0 NOT NULL,
          \`retry\` integer,
          \`lease\` integer,
          \`created\` integer NOT NULL,
          \`updated\` integer NOT NULL,
          CONSTRAINT \`fk_audit_streams_org_orgs_id_fk\` FOREIGN KEY (\`org\`) REFERENCES \`orgs\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE INDEX \`audit_streams_org\` ON \`audit_streams\` (\`org\`);
      `)
    })
  },
} satisfies DatabaseMigration.Migration
