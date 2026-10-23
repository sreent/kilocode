import { Effect } from "effect"
import { Store } from "./store"

const day = 24 * 60 * 60 * 1000

// Creates the first organization and its owner, and issues the owner a token. Idempotent: rerunning
// it re-asserts ownership and issues a fresh token.
export const bootstrap = Effect.fn("bootstrap")(function* (input: {
  org: string
  slug: string
  email: string
  name?: string
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
