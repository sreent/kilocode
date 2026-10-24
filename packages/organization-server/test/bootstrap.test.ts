import { expect, test } from "bun:test"
import { PGlite } from "@electric-sql/pglite"
import { PgClient } from "@effect/sql-pg"
import { ConfigProvider, Effect, Layer, ManagedRuntime } from "effect"
import { first, settings } from "../src/bootstrap"
import { Database } from "../src/db/database"
import { Embedded } from "../src/db/embedded"
import { Store } from "../src/store"

const token = `korg_${"a1".repeat(20)}`
const read = (env: Record<string, string>) =>
  Effect.runPromise(
    settings.pipe(Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv({ env }))),
  )

test("settings name the first organization all together, with a token the operator chose", async () => {
  expect(await read({})).toBeUndefined()
  const all = {
    ORGANIZATION_BOOTSTRAP_ORG: "Acme",
    ORGANIZATION_BOOTSTRAP_SLUG: "acme",
    ORGANIZATION_BOOTSTRAP_EMAIL: "owner@acme.com",
    ORGANIZATION_BOOTSTRAP_TOKEN: token,
  }
  expect(await read(all)).toEqual({ org: "Acme", slug: "acme", email: "owner@acme.com", token })
  const { ORGANIZATION_BOOTSTRAP_TOKEN: _, ...partial } = all
  await expect(read(partial)).rejects.toThrow("together, or none of them")
  await expect(read({ ...all, ORGANIZATION_BOOTSTRAP_TOKEN: "hunter2" })).rejects.toThrow("must be korg_")
})

test("an empty database gets the organization once, however many servers start together", async () => {
  const pg = await PGlite.create()
  const runtime = ManagedRuntime.make(
    Store.layer.pipe(Layer.provideMerge(Database.layerFrom(PgClient.layerFrom(Embedded.client(pg))))),
  )
  try {
    const input = { org: "Acme", slug: "acme", email: "owner@acme.com", token }
    const created = await runtime.runPromise(Effect.all([first(input), first(input)], { concurrency: 2 }))
    expect(created.filter(Boolean)).toEqual([true])
    expect(await runtime.runPromise(first(input))).toBe(false)

    const store = await runtime.runPromise(Store.Service.use((service) => Effect.succeed(service)))
    const verified = await runtime.runPromise(store.token.verify(token))
    const org = await runtime.runPromise(store.org.get("acme"))
    expect(verified?.org).toBe(org?.id)
    expect(await runtime.runPromise(store.member.role(org?.id ?? "", verified?.user ?? ""))).toMatchObject({
      role: "owner",
    })
  } finally {
    await runtime.dispose()
    await pg.close()
  }
})
