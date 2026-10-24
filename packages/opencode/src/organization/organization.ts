// kilocode_change - new file (organization)
export * as Organization from "./organization"

import path from "path"
import {
  Cause,
  Clock,
  Config as EffectConfig,
  Context,
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Predicate,
  Schema,
  Scope,
} from "effect"
import { FetchHttpClient, HttpClient, HttpClientError } from "effect/unstable/http"
import { OrganizationClient } from "@organization/protocol/client"
import { DeviceError } from "@organization/protocol/errors"
import { overBudget, refusal as mcpRefusal } from "@organization/protocol/match"
import { Effective, UsageRecord } from "@organization/protocol/schema"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Global } from "@opencode-ai/core/global"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { httpClient } from "@opencode-ai/core/effect/app-node-platform"
import { ConfigAgentV1 } from "@opencode-ai/core/v1/config/agent"
import { ConfigMCPV1 } from "@opencode-ai/core/v1/config/mcp"
import { ConfigPermissionV1 } from "@opencode-ai/core/v1/config/permission"
import type { Config } from "@/config/config"
import { ConfigManaged } from "@/config/managed"

// Client side of the self-hosted organization server (packages/organization-server).
//
// Config, Provider, MCP, Permission and Plugin depend on this service, so it must not depend on
// any of them; it imports only leaf modules (types aside).
//
// Activation, in precedence order:
//   1. <managed config dir>/organization.json, deployed by IT/MDM (e.g. /etc/kilo/organization.json).
//      Users cannot override it and, by default, cannot use the agent without signing in.
//   2. KILO_ORG_URL + KILO_ORG (+ KILO_ORG_TOKEN for CI).
//   3. A stored `kilo org login`.
// With none of these present every operation is a no-op.

const week = 7 * 24 * 60 * 60 * 1000

const Managed = Schema.Struct({
  url: Schema.String.check(Schema.isPattern(/^https?:\/\/\S+$/)),
  org: Schema.String.check(Schema.isMinLength(1)),
  // Refuse to run the agent until the user has signed in and a policy is loaded.
  required: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
})

export const Login = Schema.Struct({
  url: Schema.String,
  org: Schema.String,
  token: Schema.String,
  user: Schema.Struct({ id: Schema.String, email: Schema.String }),
  saved: Schema.Finite,
})
export type Login = typeof Login.Type

// The policy as cached on disk: bound to one sign-in by a hash of its token.
const Cache = Schema.Struct({
  url: Schema.String,
  org: Schema.String,
  token: Schema.String,
  etag: Schema.optional(Schema.String),
  fetched: Schema.Finite,
  policy: Effective,
})

const decode = {
  managed: Schema.decodeUnknownOption(Schema.fromJsonString(Managed)),
  login: Schema.decodeUnknownOption(Schema.fromJsonString(Login)),
  cache: Schema.decodeUnknownOption(Schema.fromJsonString(Cache)),
  usage: Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Array(UsageRecord))),
  // Server data is validated against the CLI's own config schemas; a bad entry is skipped and
  // logged rather than allowed to break config loading or permission checks.
  permission: Schema.decodeUnknownResult(ConfigPermissionV1.Info),
  mcp: Schema.decodeUnknownResult(ConfigMCPV1.Info),
  agent: Schema.decodeUnknownResult(ConfigAgentV1.Info),
}

// Each variable also answers to its name before the rename, so CI set up earlier stays enrolled
// rather than running without its policy.
const renamed = <A>(config: (name: string) => EffectConfig.Config<A>, name: string, before: string) =>
  config(name).pipe(EffectConfig.orElse(() => config(before)))

const environment = EffectConfig.all({
  url: renamed(EffectConfig.string, "KILO_ORG_URL", "KILO_ENTERPRISE_URL").pipe(EffectConfig.option),
  org: renamed(EffectConfig.string, "KILO_ORG", "KILO_ENTERPRISE_ORG").pipe(EffectConfig.option),
  token: renamed(EffectConfig.string, "KILO_ORG_TOKEN", "KILO_ENTERPRISE_TOKEN").pipe(EffectConfig.option),
  required: renamed(EffectConfig.boolean, "KILO_ORG_REQUIRED", "KILO_ENTERPRISE_REQUIRED").pipe(
    EffectConfig.orElse(() => EffectConfig.succeed(false)),
  ),
})

export type Settings = {
  readonly url: string
  readonly org: string
  readonly token?: string
  readonly required: boolean
  readonly source: "managed" | "env" | "login"
  // Set when a managed organization.json exists but cannot be used; the agent stays blocked.
  readonly error?: string
}

export type Status = {
  readonly settings: Settings | undefined
  readonly policy: Effective | undefined
  readonly fetched: number | undefined
  readonly error: string | undefined
  readonly denied: boolean
}

// What an MCP server would run: a remote URL or a local command line.
export type Target =
  | { readonly type: "local"; readonly command: ReadonlyArray<string> }
  | { readonly type: "remote"; readonly url: string }

export type UsageEntry = typeof UsageRecord.Type

// Why a sign-in could not finish; the message is shown to the user as is.
export class SigninError extends Schema.TaggedErrorClass<SigninError>()("OrganizationSigninError", {
  message: Schema.String,
}) {}

// A device sign-in waiting for the person to approve it in their browser.
export type Pending = {
  readonly url: string
  readonly org: string
  readonly code: string
  // The page to open, and the same page with the code filled in.
  readonly verification: string
  readonly link: string
  readonly expires: number
}

export type SignedIn = { readonly org: string; readonly email: string; readonly role: string }

// Thrown from plugin hooks to refuse a request; the message is shown to the user.
export class PolicyError extends Error {
  override name = "OrganizationPolicyError"
}

export const file = {
  managed: () => path.join(ConfigManaged.managedConfigDir(), "organization.json"),
  // Its name before the rename, which devices set up earlier still have.
  legacy: () => path.join(ConfigManaged.managedConfigDir(), "enterprise.json"),
  login: () => path.join(Global.Path.data, "organization-auth.json"),
  cache: () => path.join(Global.Path.cache, "organization-policy.json"),
  usage: () => path.join(Global.Path.data, "organization-usage"),
}

export interface Interface {
  /** How this device is enrolled, if at all. Resolved once per process (and after sign-in changes). */
  readonly settings: () => Effect.Effect<Settings | undefined>
  /** Loads the policy once per process, waiting at most a few seconds, then keeps it fresh. */
  readonly ready: () => Effect.Effect<void>
  /** Fetches the effective policy now. Failures are recorded in the status, never raised. */
  readonly refresh: () => Effect.Effect<void>
  /** The policy to enforce, if one is loaded and recent enough to trust. */
  readonly current: () => Effect.Effect<Effective | undefined>
  readonly status: () => Effect.Effect<Status>
  /** Why the agent must not run right now, if it must not. */
  readonly blocked: () => Effect.Effect<string | undefined>
  /** Why an MCP server may not start, if it may not. */
  readonly refusal: (target: Target) => Effect.Effect<string | undefined>
  /** The org permission config; its deny rules are hard rules no approval can override. */
  readonly permission: () => Effect.Effect<ConfigPermissionV1.Info | undefined>
  readonly instructions: () => Effect.Effect<string | undefined>
  /** Applies the org policy as the last config layer, above managed and environment config. */
  readonly overlay: (cfg: Config.Info) => Effect.Effect<void>
  /** Whether sessions may be shared through, or synced to, the upstream vendor's cloud. */
  readonly sync: () => Effect.Effect<boolean>
  /** Whether product analytics may be sent to the upstream vendor. */
  readonly telemetry: () => Effect.Effect<boolean>
  /** Startup: loads the policy and turns off sharing switches that lazily loaded code reads. */
  readonly bootstrap: () => Effect.Effect<{ readonly telemetry: boolean }>
  readonly stored: () => Effect.Effect<Login | undefined>
  readonly save: (login: Login) => Effect.Effect<void>
  readonly forget: () => Effect.Effect<void>
  readonly client: (input: {
    readonly url: string
    readonly token?: string
  }) => Effect.Effect<OrganizationClient.Client>
  /**
   * Sign-in for the terminal and the IDEs alike. A device sign-in (RFC 8628) is started, shown to
   * the person, then finished once they approve it in the browser; a token from an admin or an
   * invite signs in at once. Each verifies org access, saves the login and loads the policy.
   */
  readonly signin: {
    /** Starts a device sign-in to the given, or configured, org. It replaces one already waiting. */
    readonly start: (input?: { readonly url?: string; readonly org?: string }) => Effect.Effect<Pending, SigninError>
    /** Waits for the waiting device sign-in to be approved, denied or to expire. */
    readonly finish: () => Effect.Effect<SignedIn, SigninError>
    readonly pending: () => Effect.Effect<Pending | undefined>
    readonly token: (input: {
      readonly url?: string
      readonly org?: string
      readonly token: string
    }) => Effect.Effect<SignedIn, SigninError>
    readonly invite: (input: {
      readonly url?: string
      readonly org?: string
      readonly invite: string
    }) => Effect.Effect<SignedIn, SigninError>
  }
  /** Revokes the stored login on the control plane, best effort, and forgets it and the cached policy. */
  readonly signout: () => Effect.Effect<void>
  /** Per-LLM-call usage reporting. */
  readonly usage: {
    readonly push: (entry: UsageEntry) => Effect.Effect<void>
    readonly pending: () => Effect.Effect<number>
    readonly flush: () => Effect.Effect<boolean>
    readonly start: () => Effect.Effect<void>
    readonly stop: () => Effect.Effect<void>
  }
}

export class Service extends Context.Service<Service, Interface>()("@organization/Organization") {}

const hash = (value: string) => new Bun.CryptoHasher("sha256").update(value).digest("hex")

function describe(url: string, cause: Cause.Cause<unknown>) {
  const error = Cause.squash(cause)
  if (Cause.isTimeoutError(error)) return `cannot reach ${url}: timed out`
  if (HttpClientError.isHttpClientError(error)) return `cannot reach ${url}: ${error.message}`
  if (Schema.isSchemaError(error)) return `invalid response from ${url}: ${error.message}`
  return error instanceof Error ? error.message : String(error)
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const http = yield* HttpClient.HttpClient
    const scope = yield* Scope.Scope
    // Environment enrollment is fixed for the life of the process, like the rest of the CLI's config.
    // Unreadable values count as not enrolled through the environment.
    const env = yield* environment.pipe(
      Effect.orElseSucceed(() => ({ url: Option.none(), org: Option.none(), token: Option.none(), required: false })),
    )

    const read = (target: string) => fs.readFileStringSafe(target).pipe(Effect.orElseSucceed(() => undefined))
    const write = (target: string, body: string) =>
      fs
        .writeWithDirs(target, body, 0o600)
        .pipe(
          Effect.catch((error) => Effect.logWarning("could not write file", { file: target, error: error.message })),
        )
    const remove = (target: string) => fs.remove(target, { recursive: true, force: true }).pipe(Effect.ignore)
    const client: Interface["client"] = (input) =>
      OrganizationClient.make(input).pipe(Effect.provideService(HttpClient.HttpClient, http))

    // ---- enrollment ------------------------------------------------------------------------

    let memo: Option.Option<Settings | undefined> = Option.none()

    const stored = Effect.fn("Organization.stored")(function* () {
      return Option.getOrUndefined(decode.login((yield* read(file.login())) ?? ""))
    })

    const resolve = Effect.fn("Organization.resolve")(function* () {
      // A device IT set up before the rename keeps its enterprise.json until IT replaces it, and
      // stays managed in between rather than running without its policy.
      const current = yield* read(file.managed())
      const found = current === undefined ? file.legacy() : file.managed()
      const text = current ?? (yield* read(found))
      const managed = text === undefined ? undefined : decode.managed(text)
      if (managed && Option.isNone(managed)) {
        yield* Effect.logError("invalid managed organization file", { file: found })
        return {
          url: "",
          org: "",
          required: true,
          source: "managed",
          error: `Invalid ${found}; contact IT.`,
        } satisfies Settings
      }
      const policy = managed ? managed.value : undefined
      const login = yield* stored()
      const url = (policy?.url ?? Option.getOrUndefined(env.url) ?? login?.url)?.replace(/\/$/, "")
      const org = policy?.org ?? Option.getOrUndefined(env.org) ?? login?.org
      if (!url || !org) return undefined
      const same = login && login.url.replace(/\/$/, "") === url && login.org === org
      return {
        url,
        org,
        token: Option.getOrUndefined(env.token) || (same ? login.token : undefined),
        required: policy?.required ?? env.required,
        source: policy ? "managed" : Option.isSome(env.url) ? "env" : "login",
      } satisfies Settings
    })

    const settings = Effect.fn("Organization.settings")(function* () {
      if (Option.isSome(memo)) return memo.value
      const value = yield* resolve()
      memo = Option.some(value)
      return value
    })

    // ---- policy ------------------------------------------------------------------------------

    const state: {
      policy?: Effective
      etag?: string
      fetched?: number
      error?: string
      denied?: boolean
      started?: Fiber.Fiber<void>
      loop?: Fiber.Fiber<void>
    } = {}

    const reset = Effect.fn("Organization.reset")(function* () {
      memo = Option.none()
      const { started, loop } = state
      for (const key of Object.keys(state)) delete state[key as keyof typeof state]
      if (started) yield* Fiber.interrupt(started)
      if (loop) yield* Fiber.interrupt(loop)
    })

    // The cache belongs to one sign-in; a different token (or org) must never inherit it.
    const restore = Effect.fn("Organization.restore")(function* (cfg: Settings) {
      const cached = decode.cache((yield* read(file.cache())) ?? "")
      if (Option.isNone(cached)) return
      const value = cached.value
      if (value.url !== cfg.url || value.org !== cfg.org || value.token !== hash(cfg.token ?? "")) return
      state.policy = value.policy
      state.etag = value.etag
      state.fetched = value.fetched
    })

    // Best effort: a failed cache write only costs an extra fetch next start.
    const persist = Effect.fn("Organization.persist")(function* (cfg: Settings) {
      if (!state.policy || !state.fetched) return
      yield* write(
        file.cache(),
        JSON.stringify({
          url: cfg.url,
          org: cfg.org,
          token: hash(cfg.token ?? ""),
          etag: state.etag,
          fetched: state.fetched,
          policy: Schema.encodeSync(Effective)(state.policy),
        }),
      )
    })

    const refresh = Effect.fn("Organization.refresh")(function* () {
      const cfg = yield* settings()
      if (!cfg?.token || cfg.error) return
      const governance = (yield* client({ url: cfg.url, token: cfg.token }))["organization.governance"]
      const exit = yield* governance["policy.effective"]({
        params: { org: cfg.org },
        headers: state.etag ? { "if-none-match": state.etag } : {},
      }).pipe(Effect.timeout("10 seconds"), Effect.exit)
      const now = yield* Clock.currentTimeMillis
      if (Exit.isSuccess(exit)) {
        // An empty 304: the policy is unchanged and confirmed current.
        if (exit.value) {
          const { etag, ...policy } = exit.value
          state.policy = policy
          state.etag = etag
        }
        state.fetched = now
        state.error = undefined
        state.denied = false
        return yield* persist(cfg)
      }
      const failure = Cause.squash(exit.cause)
      // Revoked token, removed or suspended membership: forget the policy instead of trusting a stale copy.
      if (Predicate.isTagged(failure, "UnauthorizedError") || Predicate.isTagged(failure, "NotFoundError")) {
        state.policy = undefined
        state.etag = undefined
        state.denied = true
        state.error = `access to ${cfg.org} was refused`
        return yield* remove(file.cache())
      }
      state.error = describe(cfg.url, exit.cause)
      yield* Effect.logWarning("policy refresh failed", { error: state.error })
    })

    const ready = Effect.fn("Organization.ready")(function* () {
      const cfg = yield* settings()
      if (!cfg) return
      if (!state.started) {
        yield* restore(cfg)
        // Re-polled at the policy's ttl, at most once a minute.
        const loop = Effect.suspend(() =>
          refresh().pipe(Effect.delay(Duration.seconds(Math.max(60, state.policy?.ttl ?? 300)))),
        ).pipe(Effect.forever)
        state.started = yield* refresh().pipe(
          Effect.andThen(
            Effect.gen(function* () {
              state.loop = yield* loop.pipe(Effect.forkIn(scope))
            }),
          ),
          Effect.forkIn(scope),
        )
      }
      // Startup waits at most a few seconds for the control plane; then the cached copy (if any) applies.
      yield* Fiber.join(state.started).pipe(Effect.timeoutOption("5 seconds"))
    })

    // A cached policy is trusted for a week without contact; otherwise blocking the control plane
    // at the firewall would pin whatever lenient policy happened to be cached.
    const current = Effect.fn("Organization.current")(function* () {
      if (!state.policy || !state.fetched) return undefined
      if ((yield* Clock.currentTimeMillis) - state.fetched > week) return undefined
      return state.policy
    })

    const status = Effect.fn("Organization.status")(function* () {
      return {
        settings: yield* settings(),
        policy: yield* current(),
        fetched: state.fetched,
        error: state.error,
        denied: state.denied === true,
      }
    })

    // ---- enforcement -------------------------------------------------------------------------

    const blocked = Effect.fn("Organization.blocked")(function* () {
      const cfg = yield* settings()
      if (!cfg) return undefined
      if (cfg.error) return cfg.error
      const policy = yield* current()
      if (!policy) {
        if (!cfg.required) return undefined
        if (!cfg.token || state.denied)
          return `Your organization (${cfg.org}) requires you to sign in. ${
            // The IDEs sign in from their profile page; the terminal has a command for it.
            Flag.KILO_CLIENT === "cli" ? "Run `kilo org login`." : "Sign in from your Kilo profile."
          }`
        return `Cannot load your organization's policy from ${cfg.url}${state.error ? ` (${state.error})` : ""}.`
      }
      return policy.budget.exceeded ? overBudget(policy) : undefined
    })

    // Matching uses the server's target (URL or command line), never its name, which users choose freely.
    const refusal = Effect.fn("Organization.refusal")(function* (target: Target) {
      if (!(yield* settings())) return undefined
      const policy = yield* current()
      if (!policy) return yield* blocked()
      return mcpRefusal(policy, target)
    })

    const decodedPermission = Effect.fn("Organization.decodedPermission")(function* (policy: Effective) {
      if (Object.keys(policy.permission).length === 0) return undefined
      const parsed = decode.permission(policy.permission)
      if (parsed._tag === "Success") return parsed.success
      yield* Effect.logError("ignoring invalid org permission policy", { error: parsed.failure.message })
      return undefined
    })

    const permission = Effect.fn("Organization.permission")(function* () {
      const policy = yield* current()
      return policy ? yield* decodedPermission(policy) : undefined
    })

    const instructions = Effect.fn("Organization.instructions")(function* () {
      return (yield* current())?.instructions ?? undefined
    })

    const overlay = Effect.fn("Organization.overlay")(function* (cfg: Config.Info) {
      if (!(yield* settings())) return
      yield* ready()
      const policy = yield* current()
      if (!policy) return
      const org = yield* decodedPermission(policy)
      if (org) {
        const base = typeof cfg.permission === "string" ? { "*": cfg.permission } : (cfg.permission ?? {})
        const next: Record<string, ConfigPermissionV1.Rule> = { ...base }
        // Evaluation is last-match-wins, so org keys and patterns are re-inserted after the user's.
        for (const [key, value] of Object.entries(org)) {
          const mine = next[key]
          delete next[key]
          // An org catch-all action replaces whatever the user set for this permission.
          if (typeof value !== "object" || value === null) {
            next[key] = value
            continue
          }
          const own = typeof mine === "string" ? { "*": mine } : typeof mine === "object" && mine !== null ? mine : {}
          const kept = Object.entries(own).filter(([pattern]) => !(pattern in value))
          next[key] = { ...Object.fromEntries(kept), ...value }
        }
        const merged = decode.permission(next)
        if (merged._tag === "Success") cfg.permission = merged.success
        else yield* Effect.logError("could not merge org permissions", { error: merged.failure.message })
      }
      for (const [name, server] of Object.entries(policy.mcp.servers)) {
        const parsed = decode.mcp(server)
        if (parsed._tag === "Failure") {
          yield* Effect.logWarning("skipping invalid org MCP server", { name })
          continue
        }
        cfg.mcp = { ...cfg.mcp, [name]: parsed.success }
      }
      for (const [name, agent] of Object.entries(policy.agents)) {
        const parsed = decode.agent(agent)
        if (parsed._tag === "Failure") {
          yield* Effect.logWarning("skipping invalid org agent", { name })
          continue
        }
        cfg.agent = { ...cfg.agent, [name]: { ...parsed.success, source: "organization" } }
      }
      if (policy.share === "disabled") cfg.share = "disabled"
      if (!policy.telemetry.product) cfg.experimental = { ...cfg.experimental, openTelemetry: false }
      // Gateway providers talk to the control plane, which holds the org's key and meters each
      // call; the organization token stands in for the provider's API key.
      const enrolled = yield* settings()
      if (!enrolled?.token) return
      for (const route of policy.gateway.providers) {
        const current = cfg.provider?.[route.id]
        cfg.provider = {
          ...cfg.provider,
          [route.id]: {
            ...current,
            options: { ...current?.options, baseURL: `${enrolled.url}/gateway/${route.id}`, apiKey: enrolled.token },
          },
        }
      }
    })

    // Checked where sessions leave the machine, because the session-sync module reads its env
    // switches before the policy can load. Without a loaded policy, sync stays off.
    const sync = Effect.fn("Organization.sync")(function* () {
      if (!(yield* settings())) return true
      yield* ready()
      return (yield* current())?.share === "allowed"
    })

    // Product analytics stays off under organization management unless the org opts in.
    const telemetry = Effect.fn("Organization.telemetry")(function* () {
      if (!(yield* settings())) return true
      yield* ready()
      return (yield* current())?.telemetry.product === true
    })

    // Sets the upstream env switches for sharing and vendor session sync, for code that reads them
    // after startup (lazily loaded commands). Without a loaded policy both stay off.
    const bootstrap = Effect.fn("Organization.bootstrap")(function* () {
      if (!(yield* settings())) return { telemetry: true }
      if (!(yield* sync())) {
        process.env.KILO_DISABLE_SHARE = "1"
        process.env.KILO_DISABLE_SESSION_INGEST = "1"
      }
      return { telemetry: yield* telemetry() }
    })

    const save = Effect.fn("Organization.save")(function* (login: Login) {
      yield* write(file.login(), JSON.stringify(login, null, 2))
      yield* reset()
    })

    const forget = Effect.fn("Organization.forget")(function* () {
      yield* remove(file.login())
      yield* remove(file.cache())
      yield* reset()
    })

    // ---- sign-in -----------------------------------------------------------------------------

    const unreachable = (url: string) => (error: unknown) =>
      Effect.fail(
        new SigninError({ message: `Cannot reach ${url}: ${error instanceof Error ? error.message : String(error)}` }),
      )

    // A managed device signs in to its managed org only; otherwise the caller or the stored setup decides.
    const target = Effect.fn("Organization.signin.target")(function* (input?: { url?: string; org?: string }) {
      const cfg = yield* settings()
      if (
        cfg?.source === "managed" &&
        ((input?.url && input.url.replace(/\/$/, "") !== cfg.url) || (input?.org && input.org !== cfg.org))
      )
        return yield* new SigninError({
          message: `This device is managed by your organization and signs in to ${cfg.org} at ${cfg.url} only.`,
        })
      const url = (input?.url ?? cfg?.url)?.trim().replace(/\/$/, "")
      const org = (input?.org ?? cfg?.org)?.trim()
      if (!url || !org)
        return yield* new SigninError({ message: "Give the control plane URL and your organization to sign in." })
      return { url, org }
    })

    // Checks the token reaches the org, then keeps it as this device's login.
    const keep = Effect.fn("Organization.signin.keep")(function* (url: string, org: string, token: string) {
      const account = (yield* client({ url, token }))["organization.account"]
      const me = yield* account["me.get"]().pipe(
        Effect.catch((error) =>
          Predicate.isTagged(error, "UnauthorizedError") || Predicate.isTagged(error, "ForbiddenError")
            ? Effect.fail(new SigninError({ message: "The control plane rejected this token." }))
            : unreachable(url)(error),
        ),
      )
      const access = me.orgs.find((item) => item.slug === org || item.id === org)
      if (!access) return yield* new SigninError({ message: `${me.user.email} does not have access to ${org}.` })
      yield* save({
        url,
        org,
        token,
        user: { id: me.user.id, email: me.user.email },
        saved: yield* Clock.currentTimeMillis,
      })
      yield* refresh()
      return { org: access.name, email: me.user.email, role: access.role } satisfies SignedIn
    })

    const device: { pending?: Pending & { secret: string; interval: number } } = {}

    const start = Effect.fn("Organization.signin.start")(function* (input?: { url?: string; org?: string }) {
      const { url, org } = yield* target(input)
      const signin = (yield* client({ url }))["organization.signin"]
      const started = yield* signin["device.start"]({ payload: { org } }).pipe(
        Effect.catch((error) =>
          Predicate.isTagged(error, "NotFoundError") || Predicate.isTagged(error, "InvalidRequestError")
            ? Effect.fail(new SigninError({ message: error.message }))
            : unreachable(url)(error),
        ),
      )
      const pending = {
        url,
        org,
        code: started.user_code,
        verification: started.verification_uri,
        link: started.verification_uri_complete,
        expires: (yield* Clock.currentTimeMillis) + started.expires_in * 1000,
      }
      device.pending = { ...pending, secret: started.device_code, interval: started.interval }
      return pending satisfies Pending
    })

    const finish = Effect.fn("Organization.signin.finish")(function* () {
      const pending = device.pending
      if (!pending) return yield* new SigninError({ message: "No sign-in is waiting. Start one first." })
      const signin = (yield* client({ url: pending.url }))["organization.signin"]
      let interval = pending.interval
      // A newer start replaces this sign-in; the one it replaced stops polling.
      const current = () => device.pending?.secret === pending.secret
      while (current() && (yield* Clock.currentTimeMillis) < pending.expires) {
        yield* Effect.sleep(`${interval} seconds`)
        const exit = yield* signin["device.token"]({ payload: { device_code: pending.secret } }).pipe(Effect.exit)
        if (Exit.isSuccess(exit)) {
          if (current()) device.pending = undefined
          return yield* keep(pending.url, pending.org, exit.value.access_token)
        }
        const error = exit.cause.reasons.find((reason) => reason._tag === "Fail")?.error
        // Transient network errors are retried until the code expires.
        if (!(error instanceof DeviceError) || error.error === "authorization_pending") continue
        if (error.error === "slow_down") {
          interval += 5
          continue
        }
        if (current()) device.pending = undefined
        if (error.error === "access_denied") return yield* new SigninError({ message: "Sign-in was denied." })
        return yield* new SigninError({ message: `Sign-in failed: ${error.error}` })
      }
      if (!current()) return yield* new SigninError({ message: "A newer sign-in replaced this one." })
      device.pending = undefined
      return yield* new SigninError({ message: "The code expired before sign-in completed. Start again." })
    })

    const pending = Effect.fn("Organization.signin.pending")(function* () {
      const value = device.pending
      if (!value || value.expires < (yield* Clock.currentTimeMillis)) return undefined
      const { secret: _, interval: __, ...shown } = value
      return shown satisfies Pending
    })

    const token = Effect.fn("Organization.signin.token")(function* (input: {
      url?: string
      org?: string
      token: string
    }) {
      const { url, org } = yield* target(input)
      return yield* keep(url, org, input.token)
    })

    const invite = Effect.fn("Organization.signin.invite")(function* (input: {
      url?: string
      org?: string
      invite: string
    }) {
      const { url, org } = yield* target(input)
      const signin = (yield* client({ url }))["organization.signin"]
      const accepted = yield* signin["invite.accept"]({ params: { token: input.invite }, payload: {} }).pipe(
        Effect.catch((error) =>
          Predicate.isTagged(error, "NotFoundError") || Predicate.isTagged(error, "ForbiddenError")
            ? Effect.fail(new SigninError({ message: error.message }))
            : unreachable(url)(error),
        ),
      )
      return yield* keep(url, org, accepted.token)
    })

    const signout = Effect.fn("Organization.signout")(function* () {
      const login = yield* stored()
      if (login) {
        const account = (yield* client({ url: login.url, token: login.token }))["organization.account"]
        yield* account.logout().pipe(Effect.timeout("10 seconds"), Effect.ignore)
      }
      device.pending = undefined
      yield* forget()
    })

    // ---- usage -------------------------------------------------------------------------------

    // Records are keyed by the step-finish part id, which the server de-duplicates, so resending
    // after a crash or a lost response is safe.
    const max = 5_000
    const batch = 500
    const queue: UsageEntry[] = []
    const reporting: { flushing?: Fiber.Fiber<boolean>; loop?: Fiber.Fiber<void> } = {}

    const send = Effect.fn("Organization.usage.send")(function* () {
      const cfg = yield* settings()
      if (!cfg?.token || cfg.error) return queue.length === 0
      const insight = (yield* client({ url: cfg.url, token: cfg.token }))["organization.insight"]
      while (queue.length) {
        const chunk = queue.slice(0, batch)
        const exit = yield* insight["usage.ingest"]({ params: { org: cfg.org }, payload: { records: chunk } }).pipe(
          Effect.timeout("10 seconds"),
          Effect.exit,
        )
        if (Exit.isFailure(exit)) {
          yield* Effect.logWarning("usage upload failed", { error: describe(cfg.url, exit.cause) })
          return false
        }
        queue.splice(0, chunk.length)
      }
      // Budgets are enforced from the effective policy, so pull fresh spend after reporting.
      if ((yield* current())?.budget.limits.length) yield* refresh()
      return true
    })

    const flush = Effect.fn("Organization.usage.flush")(function* () {
      const running = reporting.flushing ?? (yield* send().pipe(Effect.forkIn(scope)))
      reporting.flushing = running
      return yield* Fiber.join(running).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (reporting.flushing === running) reporting.flushing = undefined
          }),
        ),
      )
    })

    const push = Effect.fn("Organization.usage.push")(function* (entry: UsageEntry) {
      queue.push(entry)
      if (queue.length > max) {
        const dropped = queue.splice(0, queue.length - max)
        yield* Effect.logWarning("usage queue full, dropping oldest records", { dropped: dropped.length })
      }
      if (queue.length >= 50) yield* flush().pipe(Effect.forkIn(scope))
    })

    // Picks up records spooled by earlier processes that could not reach the control plane.
    const recover = Effect.fn("Organization.usage.recover")(function* () {
      const entries = yield* fs.readDirectoryEntries(file.usage()).pipe(Effect.orElseSucceed(() => []))
      for (const entry of entries) {
        const target = path.join(file.usage(), entry.name)
        const records = decode.usage((yield* read(target)) ?? "")
        yield* remove(target)
        if (Option.isSome(records)) queue.push(...records.value)
      }
    })

    const begin = Effect.fn("Organization.usage.start")(function* () {
      if (reporting.loop) return
      yield* recover()
      reporting.loop = yield* flush().pipe(Effect.delay("15 seconds"), Effect.forever, Effect.forkIn(scope))
    })

    const stop = Effect.fn("Organization.usage.stop")(function* () {
      if (reporting.loop) yield* Fiber.interrupt(reporting.loop)
      reporting.loop = undefined
      const sent = Option.getOrElse(yield* flush().pipe(Effect.timeoutOption("3 seconds")), () => false)
      if (sent || queue.length === 0) return
      const records = queue.splice(0)
      yield* write(
        path.join(file.usage(), `${process.pid}-${yield* Clock.currentTimeMillis}.json`),
        JSON.stringify(Schema.encodeSync(Schema.Array(UsageRecord))(records)),
      )
    })

    return Service.of({
      settings,
      ready,
      refresh,
      current,
      status,
      blocked,
      refusal,
      permission,
      instructions,
      overlay,
      sync,
      telemetry,
      bootstrap,
      stored,
      save,
      forget,
      client,
      signin: { start, finish, pending, token, invite },
      signout,
      usage: { push, pending: () => Effect.sync(() => queue.length), flush, start: begin, stop },
    })
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [FSUtil.node, httpClient] })

// For Promise-based modules outside the app graph; the shared memo map makes it the same instance.
export const defaultLayer = layer.pipe(Layer.provide([FSUtil.defaultLayer, FetchHttpClient.layer]))
