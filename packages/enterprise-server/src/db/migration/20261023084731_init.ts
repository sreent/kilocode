import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261023084731_init",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`audit\` (
          \`id\` integer PRIMARY KEY AUTOINCREMENT,
          \`org\` text NOT NULL,
          \`at\` integer NOT NULL,
          \`action\` text NOT NULL,
          \`actor\` text,
          \`email\` text,
          \`target\` text,
          \`details\` text DEFAULT '{}' NOT NULL,
          \`ip\` text
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`budgets\` (
          \`org\` text NOT NULL,
          \`scope\` text NOT NULL,
          \`target\` text DEFAULT '' NOT NULL,
          \`period\` text NOT NULL,
          \`amount\` real NOT NULL,
          CONSTRAINT \`budgets_pk\` PRIMARY KEY(\`org\`, \`scope\`, \`target\`, \`period\`),
          CONSTRAINT \`fk_budgets_org_orgs_id_fk\` FOREIGN KEY (\`org\`) REFERENCES \`orgs\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT "budgets_scope" CHECK("scope" in ('org', 'member', 'user')),
          CONSTRAINT "budgets_period" CHECK("period" in ('day', 'month'))
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`devices\` (
          \`hash\` text PRIMARY KEY,
          \`code\` text NOT NULL UNIQUE,
          \`org\` text NOT NULL,
          \`user\` text,
          \`status\` text NOT NULL,
          \`created\` integer NOT NULL,
          \`expires\` integer NOT NULL,
          \`polled\` integer,
          CONSTRAINT \`fk_devices_org_orgs_id_fk\` FOREIGN KEY (\`org\`) REFERENCES \`orgs\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_devices_user_users_id_fk\` FOREIGN KEY (\`user\`) REFERENCES \`users\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT "devices_status" CHECK("status" in ('pending', 'approved', 'denied', 'consumed'))
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`domains\` (
          \`name\` text PRIMARY KEY,
          \`org\` text NOT NULL,
          \`token\` text NOT NULL,
          \`verified\` integer,
          \`created\` integer NOT NULL,
          CONSTRAINT \`fk_domains_org_orgs_id_fk\` FOREIGN KEY (\`org\`) REFERENCES \`orgs\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`group_members\` (
          \`grp\` text NOT NULL,
          \`user\` text NOT NULL,
          CONSTRAINT \`group_members_pk\` PRIMARY KEY(\`grp\`, \`user\`),
          CONSTRAINT \`fk_group_members_grp_org_groups_id_fk\` FOREIGN KEY (\`grp\`) REFERENCES \`org_groups\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_group_members_user_users_id_fk\` FOREIGN KEY (\`user\`) REFERENCES \`users\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`org_groups\` (
          \`id\` text PRIMARY KEY,
          \`org\` text NOT NULL,
          \`name\` text NOT NULL,
          \`external\` text,
          \`models\` text,
          \`created\` integer NOT NULL,
          CONSTRAINT \`fk_org_groups_org_orgs_id_fk\` FOREIGN KEY (\`org\`) REFERENCES \`orgs\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`invites\` (
          \`id\` text PRIMARY KEY,
          \`org\` text NOT NULL,
          \`email\` text NOT NULL,
          \`role\` text NOT NULL,
          \`hash\` text NOT NULL UNIQUE,
          \`actor\` text,
          \`created\` integer NOT NULL,
          \`expires\` integer NOT NULL,
          \`accepted\` integer,
          \`revoked\` integer,
          CONSTRAINT \`fk_invites_org_orgs_id_fk\` FOREIGN KEY (\`org\`) REFERENCES \`orgs\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_invites_actor_users_id_fk\` FOREIGN KEY (\`actor\`) REFERENCES \`users\`(\`id\`) ON DELETE SET NULL,
          CONSTRAINT "invites_role" CHECK("role" in ('owner', 'admin', 'member', 'billing_manager'))
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`logins\` (
          \`state\` text PRIMARY KEY,
          \`org\` text NOT NULL,
          \`verifier\` text NOT NULL,
          \`nonce\` text NOT NULL,
          \`device\` text,
          \`created\` integer NOT NULL,
          CONSTRAINT \`fk_logins_org_orgs_id_fk\` FOREIGN KEY (\`org\`) REFERENCES \`orgs\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`members\` (
          \`org\` text NOT NULL,
          \`user\` text NOT NULL,
          \`role\` text NOT NULL,
          \`created\` integer NOT NULL,
          \`suspended\` integer,
          CONSTRAINT \`members_pk\` PRIMARY KEY(\`org\`, \`user\`),
          CONSTRAINT \`fk_members_org_orgs_id_fk\` FOREIGN KEY (\`org\`) REFERENCES \`orgs\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_members_user_users_id_fk\` FOREIGN KEY (\`user\`) REFERENCES \`users\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT "members_role" CHECK("role" in ('owner', 'admin', 'member', 'billing_manager'))
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`modes\` (
          \`id\` text PRIMARY KEY,
          \`org\` text NOT NULL,
          \`slug\` text NOT NULL,
          \`name\` text NOT NULL,
          \`config\` text NOT NULL,
          \`created\` integer NOT NULL,
          \`updated\` integer NOT NULL,
          CONSTRAINT \`fk_modes_org_orgs_id_fk\` FOREIGN KEY (\`org\`) REFERENCES \`orgs\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`orgs\` (
          \`id\` text PRIMARY KEY,
          \`name\` text NOT NULL,
          \`slug\` text NOT NULL UNIQUE,
          \`parent\` text,
          \`settings\` text DEFAULT '{}' NOT NULL,
          \`created\` integer NOT NULL,
          CONSTRAINT \`fk_orgs_parent_orgs_id_fk\` FOREIGN KEY (\`parent\`) REFERENCES \`orgs\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`policies\` (
          \`org\` text PRIMARY KEY,
          \`data\` text NOT NULL,
          \`version\` integer NOT NULL,
          \`updated\` integer NOT NULL,
          \`actor\` text,
          CONSTRAINT \`fk_policies_org_orgs_id_fk\` FOREIGN KEY (\`org\`) REFERENCES \`orgs\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`sso\` (
          \`org\` text PRIMARY KEY,
          \`issuer\` text NOT NULL,
          \`client\` text NOT NULL,
          \`secret\` text NOT NULL,
          \`scopes\` text NOT NULL,
          \`enforce\` integer DEFAULT false NOT NULL,
          \`provision\` integer DEFAULT true NOT NULL,
          \`updated\` integer NOT NULL,
          CONSTRAINT \`fk_sso_org_orgs_id_fk\` FOREIGN KEY (\`org\`) REFERENCES \`orgs\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`tokens\` (
          \`id\` text PRIMARY KEY,
          \`hash\` text NOT NULL UNIQUE,
          \`kind\` text NOT NULL,
          \`user\` text,
          \`org\` text NOT NULL,
          \`name\` text NOT NULL,
          \`created\` integer NOT NULL,
          \`expires\` integer,
          \`used\` integer,
          \`revoked\` integer,
          CONSTRAINT \`fk_tokens_user_users_id_fk\` FOREIGN KEY (\`user\`) REFERENCES \`users\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_tokens_org_orgs_id_fk\` FOREIGN KEY (\`org\`) REFERENCES \`orgs\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT "tokens_kind" CHECK("kind" in ('user', 'scim'))
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`usage\` (
          \`org\` text NOT NULL,
          \`id\` text NOT NULL,
          \`user\` text NOT NULL,
          \`at\` integer NOT NULL,
          \`session\` text,
          \`project\` text,
          \`provider\` text NOT NULL,
          \`model\` text NOT NULL,
          \`input\` integer DEFAULT 0 NOT NULL,
          \`output\` integer DEFAULT 0 NOT NULL,
          \`reasoning\` integer DEFAULT 0 NOT NULL,
          \`cache_read\` integer DEFAULT 0 NOT NULL,
          \`cache_write\` integer DEFAULT 0 NOT NULL,
          \`cost\` real DEFAULT 0 NOT NULL,
          CONSTRAINT \`usage_pk\` PRIMARY KEY(\`org\`, \`id\`),
          CONSTRAINT \`fk_usage_org_orgs_id_fk\` FOREIGN KEY (\`org\`) REFERENCES \`orgs\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_usage_user_users_id_fk\` FOREIGN KEY (\`user\`) REFERENCES \`users\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`users\` (
          \`id\` text PRIMARY KEY,
          \`email\` text NOT NULL UNIQUE,
          \`name\` text,
          \`external\` text,
          \`active\` integer DEFAULT true NOT NULL,
          \`created\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE INDEX \`audit_org_at\` ON \`audit\` (\`org\`,\`at\`);
      `)
      yield* tx.run(`
        CREATE UNIQUE INDEX \`org_groups_org_name\` ON \`org_groups\` (\`org\`,\`name\`);
      `)
      yield* tx.run(`
        CREATE INDEX \`invites_org_email\` ON \`invites\` (\`org\`,\`email\`);
      `)
      yield* tx.run(`
        CREATE INDEX \`members_user\` ON \`members\` (\`user\`);
      `)
      yield* tx.run(`
        CREATE UNIQUE INDEX \`modes_org_slug\` ON \`modes\` (\`org\`,\`slug\`);
      `)
      yield* tx.run(`
        CREATE INDEX \`tokens_user\` ON \`tokens\` (\`user\`);
      `)
      yield* tx.run(`
        CREATE INDEX \`usage_org_at\` ON \`usage\` (\`org\`,\`at\`);
      `)
      yield* tx.run(`
        CREATE INDEX \`usage_user_at\` ON \`usage\` (\`user\`,\`at\`);
      `)
    })
  },
} satisfies DatabaseMigration.Migration
