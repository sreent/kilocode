import type { Argv } from "yargs"
import { cmd } from "@/cli/cmd/cmd"
import { UI } from "@/cli/ui"

// Registered eagerly at CLI startup: keep this module light and import the implementation
// inside handlers.
const load = () => import("./enterprise")

function fail(message: string) {
  UI.error(message)
  process.exitCode = 1
}

async function json(res: Response) {
  return res.json().catch(() => ({}) as Record<string, unknown>)
}

// RFC 8628 device authorization: the browser does SSO, the terminal polls for the token.
async function device(url: string, org: string) {
  const res = await fetch(`${url}/api/v1/auth/device`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ org }),
  }).catch((err: Error) => err)
  if (res instanceof Error) return fail(`Cannot reach ${url}: ${res.message}`)
  const start = await json(res)
  if (!res.ok) return fail(String(start.error ?? `HTTP ${res.status}`))
  UI.println(`Open ${UI.Style.TEXT_HIGHLIGHT}${start.verification_uri}${UI.Style.TEXT_NORMAL} and confirm this code:`)
  UI.println(`\n    ${UI.Style.TEXT_HIGHLIGHT_BOLD}${start.user_code}${UI.Style.TEXT_NORMAL}\n`)
  const { default: open } = await import("open")
  await open(String(start.verification_uri_complete)).catch(() =>
    UI.println("Could not open a browser; open the URL above manually."),
  )
  const poll = { interval: Number(start.interval ?? 5), deadline: Date.now() + Number(start.expires_in ?? 600) * 1000 }
  while (Date.now() < poll.deadline) {
    await Bun.sleep(poll.interval * 1000)
    const next = await fetch(`${url}/api/v1/auth/device/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ device_code: start.device_code }),
    }).catch((err: Error) => err)
    if (next instanceof Error) continue
    const result = await json(next)
    if (next.ok) return String(result.access_token)
    if (result.error === "authorization_pending") continue
    if (result.error === "slow_down") {
      poll.interval += 5
      continue
    }
    if (result.error === "access_denied") return fail("Sign-in was denied.")
    return fail(`Sign-in failed: ${String(result.error ?? `HTTP ${next.status}`)}`)
  }
  return fail("The code expired before sign-in completed. Run the command again.")
}

async function accept(url: string, invite: string) {
  const res = await fetch(`${url}/api/v1/invites/${encodeURIComponent(invite)}/accept`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  }).catch((err: Error) => err)
  if (res instanceof Error) return fail(`Cannot reach ${url}: ${res.message}`)
  const data = await json(res)
  if (!res.ok) return fail(String(data.error ?? `HTTP ${res.status}`))
  return String(data.token)
}

const LoginCommand = cmd({
  command: "login",
  describe: "sign in to your organization (single sign-on by default)",
  builder: (yargs: Argv) =>
    yargs
      .option("url", { type: "string", describe: "control plane URL, e.g. https://ai.example.com" })
      .option("org", { type: "string", describe: "organization slug" })
      .option("token", { type: "string", describe: "use an access token issued by an administrator" })
      .option("invite", { type: "string", describe: "accept an invite and sign in" }),
  handler: async (args) => {
    const Enterprise = await load()
    const cfg = Enterprise.settings()
    if (cfg?.source === "managed" && ((args.url && args.url !== cfg.url) || (args.org && args.org !== cfg.org)))
      return fail(`This device is managed by your organization and signs in to ${cfg.org} at ${cfg.url} only.`)
    const url = (args.url ?? cfg?.url)?.replace(/\/$/, "")
    const org = args.org ?? cfg?.org
    if (!url || !org) return fail("Pass --url and --org, or ask IT to deploy enterprise.json to this device.")
    const token = args.token ?? (args.invite ? await accept(url, args.invite) : await device(url, org))
    if (!token) return
    const res = await fetch(`${url}/api/v1/me`, { headers: { authorization: `Bearer ${token}` } }).catch(
      (err: Error) => err,
    )
    if (res instanceof Error) return fail(`Cannot reach ${url}: ${res.message}`)
    if (!res.ok) return fail("The control plane rejected this token.")
    const { z } = await import("zod")
    const parsed = z
      .object({
        user: z.object({ id: z.string(), email: z.string() }),
        orgs: z.array(z.object({ id: z.string(), slug: z.string(), name: z.string(), role: z.string() })),
      })
      .safeParse(await json(res))
    if (!parsed.success) return fail("Unexpected response from the control plane.")
    const me = parsed.data
    const target = me.orgs.find((item) => item.slug === org || item.id === org)
    if (!target) return fail(`${me.user.email} does not have access to ${org}.`)
    await Enterprise.save({ url, org, token, user: me.user, saved: Date.now() })
    await Enterprise.refresh()
    UI.println(`Signed in to ${target.name} as ${me.user.email} (${target.role}).`)
  },
})

const LogoutCommand = cmd({
  command: "logout",
  describe: "sign out and forget the cached organization policy",
  handler: async () => {
    const Enterprise = await load()
    const cfg = Enterprise.settings()
    const login = Enterprise.stored()
    if (login)
      await fetch(`${login.url}/api/v1/auth/logout`, {
        method: "POST",
        headers: { authorization: `Bearer ${login.token}` },
      }).catch(() => undefined)
    await Enterprise.forget()
    UI.println("Signed out.")
    if (process.env.KILO_ENTERPRISE_TOKEN) UI.println("Note: KILO_ENTERPRISE_TOKEN is still set in this environment.")
    if (cfg?.required) UI.println(`${cfg.org} requires sign-in: the agent stays blocked until you sign in again.`)
  },
})

const StatusCommand = cmd({
  command: "status",
  describe: "show organization, sign-in and policy status",
  builder: (yargs: Argv) => yargs.option("json", { type: "boolean", default: false, describe: "output as JSON" }),
  handler: async (args) => {
    const Enterprise = await load()
    if (!Enterprise.settings()) {
      UI.println("Enterprise mode is off: no enterprise.json, KILO_ENTERPRISE_URL, or stored login.")
      return
    }
    await Enterprise.ready()
    const info = Enterprise.status()
    const blocked = Enterprise.blocked()
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
  },
})

const PolicyCommand = cmd({
  command: "policy",
  describe: "print the effective organization policy for this user",
  handler: async () => {
    const Enterprise = await load()
    if (!Enterprise.settings()) return fail("Enterprise mode is off.")
    await Enterprise.ready()
    const policy = Enterprise.current()
    if (!policy) return fail(Enterprise.blocked() ?? "No policy loaded.")
    console.log(JSON.stringify(policy, null, 2))
  },
})

export const EnterpriseCommand = cmd({
  command: "enterprise",
  describe: "sign in to your organization and inspect its policy",
  builder: (yargs: Argv) =>
    yargs.command(LoginCommand).command(LogoutCommand).command(StatusCommand).command(PolicyCommand).demandCommand(),
  async handler() {},
})
