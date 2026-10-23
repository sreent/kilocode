import { Hono } from "hono"
import { bodyLimit } from "hono/body-limit"
import { HTTPException } from "hono/http-exception"
import { secureHeaders } from "hono/secure-headers"
import { admin } from "./admin"
import { api } from "./api"
import { auth } from "./auth"
import type { Config, Env } from "./context"
import { oidc } from "./oidc"
import { scim } from "./scim"
import type { Store } from "./store"

export type { Config } from "./context"
export { open } from "./db"
export { create as store } from "./store"

export function app(store: Store, config: Config) {
  const server = new Hono<Env>()

  server.use("*", async (c, next) => {
    c.set("store", store)
    c.set("config", config)
    await next()
  })
  server.use("*", secureHeaders({ crossOriginResourcePolicy: false }))
  server.use(
    "*",
    bodyLimit({ maxSize: 2 * 1024 * 1024, onError: (c) => c.json({ error: "request body too large" }, 413) }),
  )

  server.onError((err, c) => {
    if (err instanceof HTTPException) {
      if (err.res) return err.getResponse()
      return c.json({ error: err.message }, err.status)
    }
    console.error("unhandled error", err)
    return c.json({ error: "internal error" }, 500)
  })
  server.notFound((c) => c.json({ error: "not found" }, 404))

  server.get("/healthz", (c) => c.json({ ok: true }))
  server.route("/", auth)
  server.route("/", oidc)
  server.route("/", admin)
  server.route("/scim/v2", scim)
  server.route("/api/v1/orgs/:org", api)
  return server
}

export function bootstrap(store: Store, input: { org: string; slug: string; email: string; name?: string }) {
  const org = store.org.get(input.slug) ?? store.org.create({ name: input.org, slug: input.slug })
  const user = store.user.ensure({ email: input.email, name: input.name })
  if (!store.member.get(org.id, user.id)) store.member.add(org.id, user.id, "owner")
  store.member.set(org.id, user.id, "owner")
  const token = store.token.issue({
    kind: "user",
    user: user.id,
    org: org.id,
    name: "Bootstrap owner token",
    ttl: 90 * 24 * 60 * 60 * 1000,
  })
  store.audit.record({
    org: org.id,
    action: "organization.create",
    actor: { id: user.id, email: user.email },
    target: org.id,
    details: { bootstrap: true, slug: org.slug },
  })
  return { org, user, token: token.value }
}
