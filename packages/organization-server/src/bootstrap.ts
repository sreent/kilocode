import { sql } from "drizzle-orm"
import { Config, Effect, Option, Redacted, Schema } from "effect"
import { Database } from "./db/database"
import { Store } from "./store"

const day = 24 * 60 * 60 * 1000

// Creates the first organization and its owner, and issues the owner a token. Idempotent: rerunning
// it re-asserts ownership and issues a fresh token.
export const bootstrap = Effect.fn("bootstrap")(function* (input: {
  org: string
  slug: string
  email: string
  name?: string
  // The owner's token, when the operator chose it; otherwise a new one.
  token?: string
}) {
  const store = yield* Store.Service
  const org = (yield* store.org.get(input.slug)) ?? (yield* store.org.create({ name: input.org, slug: input.slug }))
  const user = yield* store.user.ensure({ email: input.email, name: input.name })
  if (!(yield* store.member.get(org.id, user.id))) yield* store.member.add(org.id, user.id, "owner")
  yield* store.member.set(org.id, user.id, "owner")
  const token = yield* store.token.issue({
    kind: "user",
    user: user.id,
    org: org.id,
    name: "Bootstrap owner token",
    ttl: 90 * day,
    value: input.token,
  })
  yield* store.audit.record({
    org: org.id,
    action: "organization.create",
    actor: { id: user.id, email: user.email },
    target: org.id,
    details: { bootstrap: true, slug: org.slug },
  })
  return { org, user, token: token.value }
})

export class BootstrapError extends Schema.TaggedErrorClass<BootstrapError>()("BootstrapError", {
  message: Schema.String,
}) {}

const names = ["ORG", "SLUG", "EMAIL", "TOKEN"].map((name) => `ORGANIZATION_BOOTSTRAP_${name}`)

// The first organization, from settings: for platforms where running `bootstrap` beside the server is
// awkward, such as those without a shell in the container, or the embedded database's lock. The
// operator chooses the owner's token, so it never appears in logs.
export const settings = Effect.gen(function* () {
  const env = yield* Config.all({
    org: Config.string(names[0]).pipe(Config.option),
    slug: Config.string(names[1]).pipe(Config.option),
    email: Config.string(names[2]).pipe(Config.option),
    token: Config.redacted(names[3]).pipe(Config.option),
  })
  const given = Object.values(env).filter((value: Option.Option<unknown>) => Option.isSome(value)).length
  if (given === 0) return undefined
  if (Option.isNone(env.org) || Option.isNone(env.slug) || Option.isNone(env.email) || Option.isNone(env.token))
    return yield* new BootstrapError({ message: `set ${names.join(", ")} together, or none of them` })
  const token = Redacted.value(env.token.value)
  if (!/^korg_[A-Za-z0-9_-]{32,}$/.test(token))
    return yield* new BootstrapError({
      message: `${names[3]} must be korg_ and at least 32 letters, digits, - or _, such as korg_$(openssl rand -hex 32)`,
    })
  return { org: env.org.value, slug: env.slug.value, email: env.email.value, token }
})

/** Creates the organization from settings when the database has none yet; whether it did. */
export const first = Effect.fn("bootstrap.first")(function* (input: {
  org: string
  slug: string
  email: string
  token: string
}) {
  const { db } = yield* Database.Service
  // Under a lock, so of replicas starting together only one creates it.
  return yield* db.transaction(() =>
    Effect.gen(function* () {
      yield* db.execute(sql`select pg_advisory_xact_lock(hashtext('kilo-organization:bootstrap'))`)
      if ((yield* db.execute(sql`select 1 from orgs limit 1`)).length > 0) return false
      yield* bootstrap(input)
      return true
    }),
  )
})
