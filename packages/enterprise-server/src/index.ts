#!/usr/bin/env bun
import { resolveTxt } from "node:dns/promises"
import { parseArgs } from "node:util"
import { app, bootstrap } from "./app"
import { open } from "./db"
import { create } from "./store"

const env = process.env
const day = 24 * 60 * 60 * 1000
const port = Number(env.ENTERPRISE_PORT ?? 8787)
const config = {
  base: (env.ENTERPRISE_BASE_URL ?? `http://localhost:${port}`).replace(/\/$/, ""),
  secret: env.ENTERPRISE_SECRET || undefined,
  proxy: env.ENTERPRISE_TRUST_PROXY === "1" || env.ENTERPRISE_TRUST_PROXY === "true",
  txt: resolveTxt,
}
const store = create(open(env.ENTERPRISE_DB ?? "./data/enterprise.db"))

const args = parseArgs({
  allowPositionals: true,
  options: {
    org: { type: "string" },
    slug: { type: "string" },
    email: { type: "string" },
    name: { type: "string" },
  },
})
const command = args.positionals.at(0) ?? "serve"

if (command === "bootstrap") {
  const opts = args.values
  if (!opts.org || !opts.slug || !opts.email) {
    console.error(
      "usage: enterprise-server bootstrap --org <name> --slug <slug> --email <owner email> [--name <owner name>]",
    )
    process.exit(1)
  }
  const result = bootstrap(store, { org: opts.org, slug: opts.slug, email: opts.email, name: opts.name })
  console.log(`organization: ${result.org.name} (${result.org.slug})`)
  console.log(`owner:        ${result.user.email}`)
  console.log(`token:        ${result.token}`)
  console.log("\nStore this token securely; it is shown once. Use it as `Authorization: Bearer <token>`.")
  process.exit(0)
}

if (command !== "serve") {
  console.error(`unknown command: ${command} (expected "serve" or "bootstrap")`)
  process.exit(1)
}

if (!config.secret) console.warn("ENTERPRISE_SECRET is not set: single sign-on cannot be configured until it is.")
if (!config.base.startsWith("https://") && !/^http:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(config.base))
  console.warn(
    `ENTERPRISE_BASE_URL (${config.base}) is not https: tokens and session cookies would travel in clear text.`,
  )

// 0 (or anything non-positive) keeps audit history forever.
const days = Number(env.ENTERPRISE_AUDIT_RETENTION_DAYS ?? 365)
const sweep = () => {
  const pruned = store.sweep(days > 0 ? days * day : undefined)
  if (pruned) console.log(`pruned ${pruned} audit events older than retention`)
}
sweep()
setInterval(sweep, 60 * 60 * 1000)

const server = app(store, config)
Bun.serve({
  port,
  hostname: env.ENTERPRISE_HOST ?? "0.0.0.0",
  fetch: (req, srv) => server.fetch(req, { ip: srv.requestIP(req)?.address }),
})
console.log(`enterprise control plane listening on ${config.base} (port ${port})`)
