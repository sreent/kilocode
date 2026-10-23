import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261023135725_gateway",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`gateway_providers\` (
          \`org\` text NOT NULL,
          \`id\` text NOT NULL,
          \`kind\` text NOT NULL,
          \`base\` text NOT NULL,
          \`secret\` text NOT NULL,
          \`hint\` text NOT NULL,
          \`created\` integer NOT NULL,
          \`updated\` integer NOT NULL,
          CONSTRAINT \`gateway_providers_pk\` PRIMARY KEY(\`org\`, \`id\`),
          CONSTRAINT \`fk_gateway_providers_org_orgs_id_fk\` FOREIGN KEY (\`org\`) REFERENCES \`orgs\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT "gateway_providers_kind" CHECK("kind" in ('anthropic', 'openai', 'openai-compatible'))
        );
      `)
      yield* tx.run(`
        ALTER TABLE \`usage\` ADD \`source\` text DEFAULT 'client' NOT NULL;
      `)
    })
  },
} satisfies DatabaseMigration.Migration
