export * as Backups from "./backups"

import { Clock, Context, Effect, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Backup } from "./db/backup"
import { Database } from "./db/database"

// The running server backs up its embedded database every few hours, keeping the newest few, and
// whenever it receives SIGUSR2. A Postgres server is backed up with its own tools instead.

const hour = 60 * 60 * 1000

export interface Interface {
  // Backs up now and prunes old backups; returns where it went, or undefined when it can't.
  readonly run: () => Effect.Effect<string | undefined>
  // Backs up when the newest backup is as old as the interval. The server asks every few minutes, so
  // restarts don't put the next backup off.
  readonly due: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@organization/Backups") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { snapshot } = yield* Database.Service
    const settings = yield* Backup.settings

    const run = Effect.fn("Backups.run")(
      function* () {
        if (!snapshot) return undefined
        const target = yield* Backup.write(settings.dir, yield* snapshot)
        const pruned = yield* Backup.prune(settings.dir, settings.keep)
        yield* Effect.logInfo("backed up the database").pipe(Effect.annotateLogs({ backup: target, pruned }))
        return target
      },
      Effect.catch((error) =>
        Effect.logError("backup failed").pipe(Effect.annotateLogs({ error: error.message }), Effect.as(undefined)),
      ),
    )

    const due = Effect.fn("Backups.due")(function* () {
      if (!snapshot || settings.hours <= 0) return
      const newest = (yield* Backup.list(settings.dir)).at(0)
      if (newest && (yield* Clock.currentTimeMillis) - newest.time < settings.hours * hour) return
      yield* run()
    })

    return Service.of({ run, due })
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [Database.node] })
