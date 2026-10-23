import { existsSync, readFileSync } from "fs"
import { mkdir, rm, writeFile } from "fs/promises"
import path from "path"
import { Schema } from "effect"
import z from "zod"
import { Global } from "@opencode-ai/core/global"
import * as Log from "@opencode-ai/core/util/log"
import { ConfigAgentV1 } from "@opencode-ai/core/v1/config/agent"
import { ConfigMCPV1 } from "@opencode-ai/core/v1/config/mcp"
import { ConfigPermissionV1 } from "@opencode-ai/core/v1/config/permission"
import type { Config } from "@/config/config"
import { ConfigManaged } from "@/config/managed"
import { Wildcard } from "@/util/wildcard"

// This module is imported by config, provider, MCP, plugin and permission code, so it must only
// import leaf utilities. Importing any of those services here creates an initialization cycle.

// Client side of the self-hosted enterprise control plane (packages/enterprise-server).
//
// Activation, in precedence order:
//   1. <managed config dir>/enterprise.json, deployed by IT/MDM (e.g. /etc/kilo/enterprise.json).
//      Users cannot override it and, by default, cannot use the agent without signing in.
//   2. KILO_ENTERPRISE_URL + KILO_ENTERPRISE_ORG (+ KILO_ENTERPRISE_TOKEN for CI).
//   3. A stored `kilo enterprise login`.
// With none of these present every function here is a no-op.

const log = Log.create({ service: "enterprise" })
const week = 7 * 24 * 60 * 60 * 1000

const Managed = z.object({
  url: z.url(),
  org: z.string().min(1),
  // Refuse to run the agent until the user has signed in and a policy is loaded.
  required: z.boolean().default(true),
})

const Login = z.object({
  url: z.string(),
  org: z.string(),
  token: z.string(),
  user: z.object({ id: z.string(), email: z.string() }),
  saved: z.number(),
})
export type Login = z.infer<typeof Login>

const Action = z.enum(["allow", "ask", "deny"])
export const Effective = z.object({
  org: z.object({ id: z.string(), slug: z.string(), name: z.string() }),
  user: z.object({ id: z.string(), email: z.string(), role: z.string() }),
  ttl: z.number().default(300),
  version: z.number(),
  groups: z.array(z.string()).default([]),
  models: z.object({ allow: z.array(z.string()).nullable(), deny: z.array(z.string()) }),
  mcp: z.object({
    allow: z.array(z.string()).nullable(),
    deny: z.array(z.string()),
    servers: z.record(z.string(), z.unknown()).default({}),
  }),
  permission: z.record(z.string(), z.union([Action, z.record(z.string(), Action)])).default({}),
  instructions: z.string().nullable().default(null),
  agents: z.record(z.string(), z.unknown()).default({}),
  share: z.enum(["allowed", "disabled"]).default("disabled"),
  telemetry: z.object({ product: z.boolean() }).prefault({ product: false }),
  budget: z
    .object({
      exceeded: z.boolean(),
      limits: z.array(z.object({ scope: z.string(), period: z.string(), amount: z.number(), spent: z.number() })),
    })
    .prefault({ exceeded: false, limits: [] }),
})
export type Effective = z.infer<typeof Effective>

export type Settings = {
  url: string
  org: string
  token?: string
  required: boolean
  source: "managed" | "env" | "login"
  // Set when a managed enterprise.json exists but cannot be used; the agent stays blocked.
  error?: string
}

export class PolicyError extends Error {
  override name = "EnterprisePolicyError"
}

export const file = {
  managed: () => path.join(ConfigManaged.managedConfigDir(), "enterprise.json"),
  login: () => path.join(Global.Path.data, "enterprise-auth.json"),
  cache: () => path.join(Global.Path.cache, "enterprise-policy.json"),
}

function read(target: string) {
  if (!existsSync(target)) return undefined
  return readFileSync(target, "utf8")
}

let memo: Settings | null | undefined

export function settings(): Settings | null {
  if (memo !== undefined) return memo
  memo = resolve()
  return memo
}

function resolve(): Settings | null {
  const env = process.env
  const text = read(file.managed())
  const managed = text === undefined ? undefined : Managed.safeParse(parse(text))
  if (managed && !managed.success) {
    log.error("invalid managed enterprise.json", { file: file.managed(), error: z.prettifyError(managed.error) })
    return { url: "", org: "", required: true, source: "managed", error: `Invalid ${file.managed()}; contact IT.` }
  }
  const stored = Login.safeParse(parse(read(file.login()) ?? "null")).data
  const url = (managed?.data.url ?? env.KILO_ENTERPRISE_URL ?? stored?.url)?.replace(/\/$/, "")
  const org = managed?.data.org ?? env.KILO_ENTERPRISE_ORG ?? stored?.org
  if (!url || !org) return null
  const same = stored && stored.url.replace(/\/$/, "") === url && stored.org === org
  return {
    url,
    org,
    token: env.KILO_ENTERPRISE_TOKEN || (same ? stored.token : undefined),
    required: managed?.data.required ?? ["1", "true"].includes(env.KILO_ENTERPRISE_REQUIRED ?? ""),
    source: managed ? "managed" : env.KILO_ENTERPRISE_URL ? "env" : "login",
  }
}

// Malformed files read as absent (or, for the managed file, as invalid) instead of crashing every command.
function parse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch (err) {
    log.warn("ignoring malformed JSON", { error: err instanceof Error ? err.message : String(err) })
    return undefined
  }
}

export function stored() {
  return Login.safeParse(parse(read(file.login()) ?? "null")).data
}

export async function save(login: Login) {
  await mkdir(path.dirname(file.login()), { recursive: true })
  await writeFile(file.login(), JSON.stringify(login, null, 2), { mode: 0o600 })
  reset()
}

export async function forget() {
  await rm(file.login(), { force: true })
  await rm(file.cache(), { force: true })
  reset()
}

// ---- policy state -------------------------------------------------------------------------

const state: {
  policy?: Effective
  etag?: string
  fetched?: number
  error?: string
  denied?: boolean
  started?: Promise<void>
  timer?: ReturnType<typeof setInterval>
} = {}

export function reset() {
  memo = undefined
  if (state.timer) clearInterval(state.timer)
  state.policy = undefined
  state.etag = undefined
  state.fetched = undefined
  state.error = undefined
  state.denied = undefined
  state.started = undefined
  state.timer = undefined
}

const Cache = z.object({
  url: z.string(),
  org: z.string(),
  token: z.string(),
  etag: z.string().optional(),
  fetched: z.number(),
  policy: Effective,
})

function restore(cfg: Settings) {
  const cached = Cache.safeParse(parse(read(file.cache()) ?? "null")).data
  // The cache belongs to one sign-in; a different token (or org) must never inherit it.
  if (!cached || cached.url !== cfg.url || cached.org !== cfg.org || cached.token !== hash(cfg.token ?? "")) return
  state.policy = cached.policy
  state.etag = cached.etag
  state.fetched = cached.fetched
}

function hash(value: string) {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex")
}

// Best effort: a failed cache write only costs an extra fetch next start.
async function persist(cfg: Settings) {
  if (!state.policy || !state.fetched) return
  const body = JSON.stringify({
    url: cfg.url,
    org: cfg.org,
    token: hash(cfg.token ?? ""),
    etag: state.etag,
    fetched: state.fetched,
    policy: state.policy,
  })
  await mkdir(path.dirname(file.cache()), { recursive: true })
    .then(() => writeFile(file.cache(), body, { mode: 0o600 }))
    .catch((err: Error) => log.warn("could not cache policy", { error: err.message }))
}

export function endpoint(cfg: Pick<Settings, "url" | "org">, suffix: string) {
  return `${cfg.url}/api/v1/orgs/${encodeURIComponent(cfg.org)}${suffix}`
}

export async function refresh() {
  const cfg = settings()
  if (!cfg?.token || cfg.error) return
  const res = await fetch(endpoint(cfg, "/policy/effective"), {
    headers: { authorization: `Bearer ${cfg.token}`, ...(state.etag ? { "if-none-match": state.etag } : {}) },
    signal: AbortSignal.timeout(10_000),
  }).catch((err: Error) => err)
  if (res instanceof Error) {
    state.error = `cannot reach ${cfg.url}: ${res.message}`
    log.warn("policy refresh failed", { error: state.error })
    return
  }
  if (res.status === 304) {
    state.fetched = Date.now()
    state.error = undefined
    await persist(cfg)
    return
  }
  // Revoked token, removed or suspended membership: forget the policy instead of trusting a stale copy.
  if (res.status === 401 || res.status === 404) {
    state.policy = undefined
    state.etag = undefined
    state.denied = true
    state.error = `access to ${cfg.org} was refused (HTTP ${res.status})`
    await rm(file.cache(), { force: true }).catch(() => undefined)
    return
  }
  if (!res.ok) {
    state.error = `policy request failed: HTTP ${res.status}`
    return
  }
  const parsed = Effective.safeParse(await res.json())
  if (!parsed.success) {
    state.error = `invalid policy from server: ${z.prettifyError(parsed.error)}`
    return
  }
  state.policy = parsed.data
  state.etag = res.headers.get("etag") ?? undefined
  state.fetched = Date.now()
  state.error = undefined
  state.denied = false
  await persist(cfg)
}

// Never rejects: a refresh failure is recorded in state.error and the previous policy kept.
function update() {
  return refresh().catch((err: Error) => {
    state.error = err.message
    log.error("policy refresh failed", { error: err.message })
  })
}

// Loads the policy once per process, then keeps it fresh in the background. Startup waits at
// most a few seconds for the control plane; after that, the cached copy (if any) is used.
export function ready() {
  const cfg = settings()
  if (!cfg) return Promise.resolve()
  if (!state.started) {
    restore(cfg)
    state.started = update().finally(() => {
      if (state.timer) return
      state.timer = setInterval(() => void update(), Math.max(60, state.policy?.ttl ?? 300) * 1000)
      state.timer.unref?.()
    })
  }
  return Promise.race([state.started, Bun.sleep(5_000)])
}

// Sets the upstream env switches for sharing and vendor session sync, for code that reads them
// after startup (lazily loaded commands). Modules that read them at import time can load before
// this runs, which is why sync() is also checked where sessions leave the machine. Without a
// loaded policy the conservative choice applies: both stay off.
export async function bootstrap() {
  if (!settings()) return
  await ready()
  if (current()?.share === "allowed") return
  process.env.KILO_DISABLE_SHARE = "1"
  process.env.KILO_DISABLE_SESSION_INGEST = "1"
}

// A cached policy is trusted for a week without contact; otherwise blocking the control plane
// at the firewall would pin whatever lenient policy happened to be cached.
export function current() {
  if (!state.policy || !state.fetched) return undefined
  if (Date.now() - state.fetched > week) return undefined
  return state.policy
}

export function status() {
  return {
    settings: settings(),
    policy: current(),
    fetched: state.fetched,
    error: state.error,
    denied: state.denied === true,
  }
}

// ---- enforcement --------------------------------------------------------------------------

// Why the agent must not run right now, if it must not.
export function blocked(): string | undefined {
  const cfg = settings()
  if (!cfg) return undefined
  if (cfg.error) return cfg.error
  const policy = current()
  if (!policy) {
    if (!cfg.required) return undefined
    if (!cfg.token || state.denied)
      return `Your organization (${cfg.org}) requires you to sign in. Run \`kilo enterprise login\`.`
    return `Cannot load your organization's policy from ${cfg.url}${state.error ? ` (${state.error})` : ""}.`
  }
  const limit = policy.budget.limits.find((item) => item.spent >= item.amount)
  if (policy.budget.exceeded && limit) {
    const period = limit.period === "day" ? "daily" : "monthly"
    const scope = limit.scope === "org" ? "organization" : "personal"
    return `Your ${period} ${scope} AI budget of $${limit.amount.toFixed(2)} has been reached ($${limit.spent.toFixed(2)} spent). Contact your administrator.`
  }
  return undefined
}

export function model(provider: string, id: string) {
  const policy = current()
  if (!policy) return true
  const name = `${provider}/${id}`
  if (policy.models.deny.some((pattern) => Wildcard.match(name, pattern))) return false
  if (policy.models.allow === null) return true
  return policy.models.allow.some((pattern) => Wildcard.match(name, pattern))
}

// Returns the reason an MCP server may not start. Matching uses the server's target (URL or
// command line), never its name, which users choose freely.
export function mcp(entry: { type: "local"; command: string[] } | { type: "remote"; url: string }) {
  const cfg = settings()
  if (!cfg) return undefined
  const policy = current()
  if (!policy) return blocked()
  const target = entry.type === "remote" ? entry.url : entry.command.join(" ")
  if (policy.mcp.deny.some((pattern) => Wildcard.match(target, pattern)))
    return `Blocked by your organization's MCP policy: ${target}`
  if (policy.mcp.allow && !policy.mcp.allow.some((pattern) => Wildcard.match(target, pattern)))
    return `Not on your organization's MCP allowlist: ${target}`
  return undefined
}

// Server data is validated against the CLI's own config schemas; a bad entry is skipped and
// logged rather than allowed to break config loading or permission checks.
const decode = {
  permission: Schema.decodeUnknownResult(ConfigPermissionV1.Info),
  mcp: Schema.decodeUnknownResult(ConfigMCPV1.Info),
  agent: Schema.decodeUnknownResult(ConfigAgentV1.Info),
}

function decoded(policy: Effective) {
  if (Object.keys(policy.permission).length === 0) return undefined
  const parsed = decode.permission(policy.permission)
  if (parsed._tag === "Success") return parsed.success
  log.error("ignoring invalid org permission policy", { error: parsed.failure.message })
  return undefined
}

// The org permission config. Its deny rules are enforced as hard rules that no saved approval
// or session "allow all" can override (see KiloSessionPrompt.buildAskRuleset).
export function permission() {
  const policy = current()
  if (!policy) return undefined
  return decoded(policy)
}

export function instructions() {
  return current()?.instructions ?? undefined
}

// Whether sessions may be shared through, or synced to, the upstream vendor's cloud. Checked at
// use time because the session-sync module reads its env switches before the policy can load.
export function sync() {
  if (!settings()) return true
  return current()?.share === "allowed"
}

// Product analytics (PostHog) stays off under enterprise management unless the org opts in.
export function telemetry() {
  if (!settings()) return true
  return current()?.telemetry.product === true
}

// Applied last when config loads, so org settings win over every user and project layer.
export async function overlay(cfg: Config.Info) {
  if (!settings()) return
  await ready()
  const policy = current()
  if (!policy) return
  const org = decoded(policy)
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
      const base = typeof mine === "string" ? { "*": mine } : typeof mine === "object" && mine !== null ? mine : {}
      const kept = Object.entries(base).filter(([pattern]) => !(pattern in value))
      next[key] = { ...Object.fromEntries(kept), ...value }
    }
    const merged = decode.permission(next)
    if (merged._tag === "Success") cfg.permission = merged.success
    if (merged._tag === "Failure") log.error("could not merge org permissions", { error: merged.failure.message })
  }
  for (const [name, server] of Object.entries(policy.mcp.servers)) {
    const parsed = decode.mcp(server)
    if (parsed._tag === "Failure") {
      log.warn("skipping invalid org MCP server", { name })
      continue
    }
    cfg.mcp = { ...cfg.mcp, [name]: parsed.success }
  }
  for (const [name, agent] of Object.entries(policy.agents)) {
    const parsed = decode.agent(agent)
    if (parsed._tag === "Failure") {
      log.warn("skipping invalid org agent", { name })
      continue
    }
    cfg.agent = { ...cfg.agent, [name]: { ...parsed.success, source: "organization" } }
  }
  if (policy.share === "disabled") cfg.share = "disabled"
  if (!policy.telemetry.product) cfg.experimental = { ...cfg.experimental, openTelemetry: false }
}
