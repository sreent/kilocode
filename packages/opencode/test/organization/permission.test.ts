// kilocode_change - new file (organization)
import { expect } from "bun:test"
import { Cause, Effect, Exit, Layer } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Config } from "../../src/config/config"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { Organization } from "../../src/organization"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Permission } from "../../src/permission"
import { InstanceBootstrap } from "../../src/project/bootstrap-service"
import { InstanceStore } from "../../src/project/instance-store"
import { SessionID } from "../../src/session/schema"
import { testEffect } from "../lib/effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"

// Org deny rules are applied inside Permission.ask itself, so every path that asks (prompt, drain,
// tools) gets them as hard rules that saved approvals and session rules cannot override.

const org = { bash: { "rm -rf *": "deny" }, webfetch: "deny" } as const

const enrolled = Layer.succeed(
  Organization.Service,
  Organization.Service.of({
    settings: () => Effect.succeed({ url: "https://cp.test", org: "acme", required: false, source: "env" }),
    ready: () => Effect.void,
    refresh: () => Effect.void,
    current: () => Effect.succeed(undefined),
    status: () => Effect.die("unused"),
    blocked: () => Effect.succeed(undefined),
    refusal: () => Effect.succeed(undefined),
    permission: () => Effect.succeed(org),
    instructions: () => Effect.succeed(undefined),
    overlay: () => Effect.void,
    sync: () => Effect.succeed(false),
    telemetry: () => Effect.succeed(false),
    bootstrap: () => Effect.succeed({ telemetry: false }),
    stored: () => Effect.succeed(undefined),
    save: () => Effect.void,
    forget: () => Effect.void,
    client: () => Effect.die("unused"),
    signin: {
      start: () => Effect.die("unused"),
      finish: () => Effect.die("unused"),
      pending: () => Effect.succeed(undefined),
      token: () => Effect.die("unused"),
      invite: () => Effect.die("unused"),
    },
    signout: () => Effect.void,
    usage: {
      push: () => Effect.void,
      pending: () => Effect.succeed(0),
      flush: () => Effect.succeed(true),
      start: () => Effect.void,
      stop: () => Effect.void,
    },
  }),
)

const replacements = [[Organization.node, enrolled]] as const
const noopBootstrap = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))
const env = Layer.mergeAll(
  AppNodeBuilder.build(Permission.node, replacements),
  AppNodeBuilder.build(EventV2Bridge.node),
  AppNodeBuilder.build(CrossSpawnSpawner.node),
  AppNodeBuilder.build(InstanceStore.node, [[InstanceStore.bootstrapNode, noopBootstrap]]),
).pipe(Layer.provide(RuntimeFlags.layer()), Layer.provide(AppNodeBuilder.build(Config.node, replacements)))
const it = testEffect(Layer.mergeAll(env, RuntimeFlags.layer()))

const ask = (patterns: string[], permission = "bash") =>
  Effect.gen(function* () {
    const service = yield* Permission.Service
    return yield* service
      .ask({
        sessionID: SessionID.make("session_organization"),
        permission,
        patterns,
        metadata: {},
        always: [],
        // Everything is allowed by the agent and session, which an org deny must still override.
        ruleset: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      .pipe(Effect.exit)
  })

it.instance(
  "org deny rules are hard rules that allow-all rulesets cannot override",
  () =>
    Effect.gen(function* () {
      const destructive = yield* ask(["rm -rf /"])
      expect(Exit.isFailure(destructive) && Cause.squash(destructive.cause)).toBeInstanceOf(PermissionV1.DeniedError)
      const fetch = yield* ask(["https://example.com"], "webfetch")
      expect(Exit.isFailure(fetch) && Cause.squash(fetch.cause)).toBeInstanceOf(PermissionV1.DeniedError)
      const harmless = yield* ask(["git status"])
      expect(Exit.isSuccess(harmless)).toBe(true)
    }),
  { git: true },
)
