import { Database } from "bun:sqlite"
import { mkdirSync } from "node:fs"
import path from "node:path"

// Append-only: never edit a shipped migration, add a new entry instead.
const migrations = [
  `
  create table orgs (
    id text primary key,
    name text not null,
    slug text not null unique,
    parent text references orgs(id) on delete cascade,
    settings text not null default '{}',
    created integer not null
  );

  create table users (
    id text primary key,
    email text not null unique collate nocase,
    name text,
    external text,
    active integer not null default 1,
    created integer not null
  );

  create table members (
    org text not null references orgs(id) on delete cascade,
    user text not null references users(id) on delete cascade,
    role text not null check (role in ('owner', 'admin', 'member', 'billing_manager')),
    created integer not null,
    suspended integer,
    primary key (org, user)
  );

  create table invites (
    id text primary key,
    org text not null references orgs(id) on delete cascade,
    email text not null collate nocase,
    role text not null check (role in ('owner', 'admin', 'member', 'billing_manager')),
    hash text not null unique,
    actor text references users(id) on delete set null,
    created integer not null,
    expires integer not null,
    accepted integer,
    revoked integer
  );

  create table org_groups (
    id text primary key,
    org text not null references orgs(id) on delete cascade,
    name text not null,
    external text,
    models text,
    created integer not null,
    unique (org, name)
  );

  create table group_members (
    grp text not null references org_groups(id) on delete cascade,
    user text not null references users(id) on delete cascade,
    primary key (grp, user)
  );

  create table domains (
    name text primary key collate nocase,
    org text not null references orgs(id) on delete cascade,
    token text not null,
    verified integer,
    created integer not null
  );

  create table tokens (
    id text primary key,
    hash text not null unique,
    kind text not null check (kind in ('user', 'scim')),
    user text references users(id) on delete cascade,
    org text not null references orgs(id) on delete cascade,
    name text not null,
    created integer not null,
    expires integer,
    used integer,
    revoked integer
  );

  create table devices (
    hash text primary key,
    code text not null unique,
    org text not null references orgs(id) on delete cascade,
    user text references users(id) on delete cascade,
    status text not null check (status in ('pending', 'approved', 'denied', 'consumed')),
    created integer not null,
    expires integer not null,
    polled integer
  );

  create table sso (
    org text primary key references orgs(id) on delete cascade,
    issuer text not null,
    client text not null,
    secret text not null,
    scopes text not null,
    enforce integer not null default 0,
    provision integer not null default 1,
    updated integer not null
  );

  create table logins (
    state text primary key,
    org text not null references orgs(id) on delete cascade,
    verifier text not null,
    nonce text not null,
    device text,
    created integer not null
  );

  create table policies (
    org text primary key references orgs(id) on delete cascade,
    data text not null,
    version integer not null,
    updated integer not null,
    actor text
  );

  create table modes (
    id text primary key,
    org text not null references orgs(id) on delete cascade,
    slug text not null,
    name text not null,
    config text not null,
    created integer not null,
    updated integer not null,
    unique (org, slug)
  );

  create table audit (
    id integer primary key autoincrement,
    org text not null,
    at integer not null,
    action text not null,
    actor text,
    email text,
    target text,
    details text not null default '{}',
    ip text
  );
  create index audit_org_at on audit (org, at);

  create table usage (
    org text not null references orgs(id) on delete cascade,
    id text not null,
    user text not null references users(id) on delete cascade,
    at integer not null,
    session text,
    project text,
    provider text not null,
    model text not null,
    input integer not null default 0,
    output integer not null default 0,
    reasoning integer not null default 0,
    cache_read integer not null default 0,
    cache_write integer not null default 0,
    cost real not null default 0,
    primary key (org, id)
  );
  create index usage_org_at on usage (org, at);
  create index usage_user_at on usage (user, at);

  create table budgets (
    org text not null references orgs(id) on delete cascade,
    scope text not null check (scope in ('org', 'member', 'user')),
    target text not null default '',
    period text not null check (period in ('day', 'month')),
    amount real not null,
    primary key (org, scope, target, period)
  );
  `,
]

export type Db = Database

export function open(file: string) {
  if (file !== ":memory:") mkdirSync(path.dirname(path.resolve(file)), { recursive: true })
  const db = new Database(file, { create: true, strict: true })
  db.exec("pragma journal_mode = wal")
  db.exec("pragma foreign_keys = on")
  db.exec("pragma busy_timeout = 5000")
  migrate(db)
  return db
}

function migrate(db: Database) {
  const row = db.query<{ user_version: number }, []>("pragma user_version").get()
  const current = row?.user_version ?? 0
  for (const [index, sql] of migrations.entries()) {
    if (index < current) continue
    db.transaction(() => {
      db.exec(sql)
      db.exec(`pragma user_version = ${index + 1}`)
    })()
  }
}

// Stored JSON comes back as unknown; callers that need a shape must parse it with a schema.
export function json(text: string | null | undefined, fallback: unknown): unknown {
  if (text == null) return fallback
  return JSON.parse(text)
}
