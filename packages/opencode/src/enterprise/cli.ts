// kilocode_change - new file (enterprise)
import type { Argv } from "yargs"
import { Clock, Effect, Exit, Predicate } from "effect"
import { effectCmd, fail } from "@/cli/effect-cmd"
import { cmd } from "@/cli/cmd/cmd"
import { UI } from "@/cli/ui"
import { DeviceError } from "@enterprise/protocol/errors"
import { Enterprise } from "./enterprise"

// Loaded lazily (see lazy-kilo-commands): only `kilo enterprise ...` pays for this module.

const unreachable = (url: string) => (error: unknown) =>
  fail(`Cannot reach ${url}: ${error instanceof Error ? error.message : String(error)}`)

// RFC 8628 device authorization: the browser does SSO, the terminal polls for the token.
const device = Effect.fn("Cli.enterprise.device")(function* (url: string, org: string) {
  const enterprise = yield* Enterprise.Service
  const signin = (yield* enterprise.client({ url }))["enterprise.signin"]
  const start = yield* signin["device.start"]({ payload: { org } }).pipe(
    Effect.catch((error) =>
      Predicate.isTagged(error, "NotFoundError") || Predicate.isTagged(error, "InvalidRequestError")
        ? fail(error.message)
        : unreachable(url)(error),
    ),
  )
  UI.println(`Open ${UI.Style.TEXT_HIGHLIGHT}${start.verification_uri}${UI.Style.TEXT_NORMAL} and confirm this code:`)
  UI.println(`\n    ${UI.Style.TEXT_HIGHLIGHT_BOLD}${start.user_code}${UI.Style.TEXT_NORMAL}\n`)
  yield* Effect.tryPromise(async () => (await import("open")).default(start.verification_uri_complete)).pipe(
    Effect.catch(() => Effect.sync(() => UI.println("Could not open a browser; open the URL above manually."))),
  )
  let interval = start.interval
  const deadline = (yield* Clock.currentTimeMillis) + start.expires_in * 1000
  while ((yield* Clock.currentTimeMillis) < deadline) {
    yield* Effect.sleep(`${interval} seconds`)
    const exit = yield* signin["device.token"]({ payload: { device_code: start.device_code } }).pipe(Effect.exit)
    if (Exit.isSuccess(exit)) return exit.value.access_token
    const error = exit.cause.reasons.find((reason) => reason._tag === "Fail")?.error
    // Transient network errors are retried until the code expires.
    if (!(error instanceof DeviceError)) continue
    if (error.error === "authorization_pending") continue
    if (error.error === "slow_down") {
      interval += 5
      continue
    }
    if (error.error === "access_denied") return yield* fail("Sign-in was denied.")
    return yield* fail(`Sign-in failed: ${error.error}`)
  }
  return yield* fail("The code expired before sign-in completed. Run the command again.")
})

const accept = Effect.fn("Cli.enterprise.accept")(function* (url: string, invite: string) {
  const enterprise = yield* Enterprise.Service
  const signin = (yield* enterprise.client({ url }))["enterprise.signin"]
  const accepted = yield* signin["invite.accept"]({ params: { token: invite }, payload: {} }).pipe(
    Effect.catch((error) =>
      Predicate.isTagged(error, "NotFoundError") || Predicate.isTagged(error, "ForbiddenError")
        ? fail(error.message)
        : unreachable(url)(error),
    ),
  )
  return accepted.token
})

const LoginCommand = effectCmd({
  command: "login",
  describe: "sign in to your organization (single sign-on by default)",
  instance: false,
  builder: (yargs: Argv) =>
    yargs
      .option("url", { type: "string", describe: "control plane URL, e.g. https://ai.example.com" })
      .option("org", { type: "string", describe: "organization slug" })
      .option("token", { type: "string", describe: "use an access token issued by an administrator" })
      .option("invite", { type: "string", describe: "accept an invite and sign in" }),
  handler: Effect.fn("Cli.enterprise.login")(function* (args) {
    const enterprise = yield* Enterprise.Service
    const cfg = yield* enterprise.settings()
    if (cfg?.source === "managed" && ((args.url && args.url !== cfg.url) || (args.org && args.org !== cfg.org)))
      return yield* fail(`This device is managed by your organization and signs in to ${cfg.org} at ${cfg.url} only.`)
    const url = (args.url ?? cfg?.url)?.replace(/\/$/, "")
    const org = args.org ?? cfg?.org
    if (!url || !org) return yield* fail("Pass --url and --org, or ask IT to deploy enterprise.json to this device.")
    const token = args.token ?? (args.invite ? yield* accept(url, args.invite) : yield* device(url, org))
    const account = (yield* enterprise.client({ url, token }))["enterprise.account"]
    const me = yield* account["me.get"]().pipe(
      Effect.catch((error) =>
        Predicate.isTagged(error, "UnauthorizedError") || Predicate.isTagged(error, "ForbiddenError")
          ? fail("The control plane rejected this token.")
          : unreachable(url)(error),
      ),
    )
    const target = me.orgs.find((item) => item.slug === org || item.id === org)
    if (!target) return yield* fail(`${me.user.email} does not have access to ${org}.`)
    yield* enterprise.save({
      url,
      org,
      token,
      user: { id: me.user.id, email: me.user.email },
      saved: yield* Clock.currentTimeMillis,
    })
    yield* enterprise.refresh()
    UI.println(`Signed in to ${target.name} as ${me.user.email} (${target.role}).`)
  }),
})

const LogoutCommand = effectCmd({
  command: "logout",
  describe: "sign out and forget the cached organization policy",
  instance: false,
  handler: Effect.fn("Cli.enterprise.logout")(function* () {
    const enterprise = yield* Enterprise.Service
    const cfg = yield* enterprise.settings()
    const login = yield* enterprise.stored()
    if (login) {
      const account = (yield* enterprise.client({ url: login.url, token: login.token }))["enterprise.account"]
      yield* account.logout().pipe(Effect.timeout("10 seconds"), Effect.ignore)
    }
    yield* enterprise.forget()
    UI.println("Signed out.")
    if (process.env.KILO_ENTERPRISE_TOKEN) UI.println("Note: KILO_ENTERPRISE_TOKEN is still set in this environment.")
    if (cfg?.required) UI.println(`${cfg.org} requires sign-in: the agent stays blocked until you sign in again.`)
  }),
})

const StatusCommand = effectCmd({
  command: "status",
  describe: "show organization, sign-in and policy status",
  instance: false,
  builder: (yargs: Argv) => yargs.option("json", { type: "boolean", default: false, describe: "output as JSON" }),
  handler: Effect.fn("Cli.enterprise.status")(function* (args) {
    const enterprise = yield* Enterprise.Service
    if (!(yield* enterprise.settings())) {
      UI.println("Enterprise mode is off: no enterprise.json, KILO_ENTERPRISE_URL, or stored login.")
      return
    }
    yield* enterprise.ready()
    const info = yield* enterprise.status()
    const blocked = yield* enterprise.blocked()
    if (args.json) {
      console.log(JSON.stringify({ ...info, settings: { ...info.settings, token: undefined }, blocked }, null, 2))
      return
    }
    const cfg = info.settings!
    const policy = info.policy
    const lines = [
      `Server:        ${cfg.url}`,
      `Organization:  ${policy?.org.name ?? cfg.org}`,
      `Configured by: ${cfg.source}${cfg.required ? " (sign-in required)" : ""}`,
      `Signed in:     ${policy ? `${policy.user.email} (${policy.user.role})` : cfg.token ? "yes" : "no"}`,
      ...(policy?.groups.length ? [`Groups:        ${policy.groups.join(", ")}`] : []),
      ...(policy
        ? [`Policy:        version ${policy.version}, fetched ${new Date(info.fetched ?? 0).toLocaleString()}`]
        : []),
      ...(policy?.budget.limits ?? []).map(
        (item) =>
          `Budget:        ${item.scope} ${item.period}: $${item.spent.toFixed(2)} of $${item.amount.toFixed(2)}`,
      ),
      ...(info.error ? [`Last error:    ${info.error}`] : []),
      ...(blocked ? [`Blocked:       ${blocked}`] : []),
    ]
    UI.println(lines.join("\n"))
  }),
})

const PolicyCommand = effectCmd({
  command: "policy",
  describe: "print the effective organization policy for this user",
  instance: false,
  handler: Effect.fn("Cli.enterprise.policy")(function* () {
    const enterprise = yield* Enterprise.Service
    if (!(yield* enterprise.settings())) return yield* fail("Enterprise mode is off.")
    yield* enterprise.ready()
    const policy = yield* enterprise.current()
    if (!policy) return yield* fail((yield* enterprise.blocked()) ?? "No policy loaded.")
    console.log(JSON.stringify(policy, null, 2))
  }),
})

export const EnterpriseCommand = cmd({
  command: "enterprise",
  describe: "sign in to your organization and inspect its policy",
  builder: (yargs: Argv) =>
    yargs.command(LoginCommand).command(LogoutCommand).command(StatusCommand).command(PolicyCommand).demandCommand(),
  async handler() {},
})
