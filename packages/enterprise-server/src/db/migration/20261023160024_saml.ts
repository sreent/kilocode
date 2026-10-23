import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261023160024_saml",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`saml_assertions\` (
          \`org\` text NOT NULL,
          \`id\` text NOT NULL,
          \`expires\` integer NOT NULL,
          CONSTRAINT \`saml_assertions_pk\` PRIMARY KEY(\`org\`, \`id\`),
          CONSTRAINT \`fk_saml_assertions_org_orgs_id_fk\` FOREIGN KEY (\`org\`) REFERENCES \`orgs\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        ALTER TABLE \`sso\` ADD \`protocol\` text DEFAULT 'oidc' NOT NULL;
      `)
      yield* tx.run(`
        ALTER TABLE \`sso\` ADD \`entry\` text;
      `)
      yield* tx.run(`
        ALTER TABLE \`sso\` ADD \`certificates\` text;
      `)
      yield* tx.run(`
        ALTER TABLE \`sso\` ADD \`unsolicited\` integer DEFAULT false NOT NULL;
      `)
      yield* tx.run(`
        PRAGMA foreign_keys=OFF;
      `)
      yield* tx.run(`
        CREATE TABLE \`__new_sso\` (
          \`org\` text PRIMARY KEY,
          \`protocol\` text DEFAULT 'oidc' NOT NULL,
          \`issuer\` text NOT NULL,
          \`client\` text,
          \`secret\` text,
          \`scopes\` text,
          \`entry\` text,
          \`certificates\` text,
          \`unsolicited\` integer DEFAULT false NOT NULL,
          \`enforce\` integer DEFAULT false NOT NULL,
          \`provision\` integer DEFAULT true NOT NULL,
          \`updated\` integer NOT NULL,
          CONSTRAINT \`fk_sso_org_orgs_id_fk\` FOREIGN KEY (\`org\`) REFERENCES \`orgs\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT "sso_protocol" CHECK("protocol" in ('oidc', 'saml'))
        );
      `)
      yield* tx.run(`
        INSERT INTO \`__new_sso\`(\`org\`, \`issuer\`, \`client\`, \`secret\`, \`scopes\`, \`enforce\`, \`provision\`, \`updated\`) SELECT \`org\`, \`issuer\`, \`client\`, \`secret\`, \`scopes\`, \`enforce\`, \`provision\`, \`updated\` FROM \`sso\`;
      `)
      yield* tx.run(`
        DROP TABLE \`sso\`;
      `)
      yield* tx.run(`
        ALTER TABLE \`__new_sso\` RENAME TO \`sso\`;
      `)
      yield* tx.run(`
        PRAGMA foreign_keys=ON;
      `)
      yield* tx.run(`
        CREATE INDEX \`saml_assertions_expires\` ON \`saml_assertions\` (\`expires\`);
      `)
    })
  },
} satisfies DatabaseMigration.Migration
