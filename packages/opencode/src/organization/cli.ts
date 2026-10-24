// kilocode_change - new file (organization)
import type { Argv } from "yargs"
import { Effect } from "effect"
import { effectCmd, fail } from "@/cli/effect-cmd"
import { cmd } from "@/cli/cmd/cmd"
import { UI } from "@/cli/ui"
import { dollars } from "@organization/protocol/match"
import { Organization } from "./organization"

// Loaded lazily (see lazy-kilo-commands): only `kilo org ...` pays for this module.

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
  handler: Effect.fn("Cli.organization.login")(function* (args) {
    const organization = yield* Organization.Service
    const input = { url: args.url, org: args.org }
    const signed = yield* Effect.gen(function* () {
      if (args.token) return yield* organization.signin.token({ ...input, token: args.token })
      if (args.invite) return yield* organization.signin.invite({ ...input, invite: args.invite })
      // RFC 8628 device authorization: the browser does SSO, the terminal waits for the approval.
      const pending = yield* organization.signin.start(input)
      UI.println(`Open ${UI.Style.TEXT_HIGHLIGHT}${pending.verification}${UI.Style.TEXT_NORMAL} and confirm this code:`)
      UI.println(`\n    ${UI.Style.TEXT_HIGHLIGHT_BOLD}${pending.code}${UI.Style.TEXT_NORMAL}\n`)
      yield* Effect.tryPromise(async () => (await import("open")).default(pending.link)).pipe(
        Effect.catch(() => Effect.sync(() => UI.println("Could not open a browser; open the URL above manually."))),
      )
      return yield* organization.signin.finish()
    }).pipe(Effect.catchTag("OrganizationSigninError", (error) => fail(error.message)))
    UI.println(`Signed in to ${signed.org} as ${signed.email} (${signed.role}).`)
  }),
})

const LogoutCommand = effectCmd({
  command: "logout",
  describe: "sign out and forget the cached organization policy",
  instance: false,
  handler: Effect.fn("Cli.organization.logout")(function* () {
    const organization = yield* Organization.Service
    const cfg = yield* organization.settings()
    yield* organization.signout()
    UI.println("Signed out.")
    if (process.env.KILO_ORG_TOKEN) UI.println("Note: KILO_ORG_TOKEN is still set in this environment.")
    if (cfg?.required) UI.println(`${cfg.org} requires sign-in: the agent stays blocked until you sign in again.`)
  }),
})

const StatusCommand = effectCmd({
  command: "status",
  describe: "show organization, sign-in and policy status",
  instance: false,
  builder: (yargs: Argv) => yargs.option("json", { type: "boolean", default: false, describe: "output as JSON" }),
  handler: Effect.fn("Cli.organization.status")(function* (args) {
    const organization = yield* Organization.Service
    if (!(yield* organization.settings())) {
      UI.println("No organization is set up on this device: no organization.json, KILO_ORG_URL or stored sign-in.")
      return
    }
    yield* organization.ready()
    const info = yield* organization.status()
    const blocked = yield* organization.blocked()
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
        (item) => `Budget:        ${item.scope} ${item.period}: ${dollars(item.spent)} of ${dollars(item.amount)}`,
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
  handler: Effect.fn("Cli.organization.policy")(function* () {
    const organization = yield* Organization.Service
    if (!(yield* organization.settings())) return yield* fail("No organization is set up on this device.")
    yield* organization.ready()
    const policy = yield* organization.current()
    if (!policy) return yield* fail((yield* organization.blocked()) ?? "No policy loaded.")
    console.log(JSON.stringify(policy, null, 2))
  }),
})

export const OrganizationCommand = cmd({
  command: "org",
  describe: "sign in to your organization and inspect its policy",
  builder: (yargs: Argv) =>
    yargs.command(LoginCommand).command(LogoutCommand).command(StatusCommand).command(PolicyCommand).demandCommand(),
  async handler() {},
})
