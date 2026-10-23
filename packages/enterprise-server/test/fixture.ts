import { app, bootstrap, type Config } from "../src/app"
import { open } from "../src/db"
import { create } from "../src/store"

export function setup(overrides: Partial<Config> = {}) {
  const store = create(open(":memory:"))
  const config: Config = {
    base: "http://localhost:8787",
    secret: "test-secret",
    proxy: false,
    txt: async () => [],
    ...overrides,
  }
  const server = app(store, config)
  const call = async (
    method: string,
    path: string,
    opts: { token?: string; body?: unknown; headers?: Record<string, string> } = {},
  ) => {
    const res = await server.request(
      path,
      {
        method,
        headers: {
          ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
          ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
          ...opts.headers,
        },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      },
      { ip: "203.0.113.7" },
    )
    const text = await res.text()
    const data = text && res.headers.get("content-type")?.includes("json") ? JSON.parse(text) : text
    return { status: res.status, data, headers: res.headers }
  }
  const owner = bootstrap(store, { org: "Acme", slug: "acme", email: "owner@acme.com", name: "Olive Owner" })
  // Adds a member with a role and returns a CLI token for them.
  const join = (email: string, role: "owner" | "admin" | "member" | "billing_manager", org = owner.org.id) => {
    const user = store.user.ensure({ email })
    store.member.add(org, user.id, role)
    return { user, token: store.token.issue({ kind: "user", user: user.id, org, name: "test" }).value }
  }
  return { store, config, server, call, owner, join }
}
