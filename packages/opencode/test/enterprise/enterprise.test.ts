// kilocode_change - new file (enterprise)
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { mkdir, rm, writeFile } from "fs/promises"
import path from "path"
import { ConfigProvider, Effect, Layer, ManagedRuntime } from "effect"
import type { Config } from "../../src/config/config"
import { Enterprise, EnterprisePlugin } from "../../src/enterprise"
import { Permission } from "../../src/permission"
import { setup } from "../../../enterprise-server/test/fixture"

// Contract tests: the client talks to the real control plane over HTTP, so the two packages
// cannot drift apart on the wire format without these failing.

async function plane() {
  const env = await setup()
  const http = env.listen()
  const admin = (method: string, route: string, body?: unknown) =>
    fetch(`${http.url}/api/v1/orgs/acme${route}`, {
      method,
      headers: { authorization: `Bearer ${env.owner.token}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  return { ...env, url: http.url, stop: http.stop, admin }
}

const cp = await plane()
const managed = () => path.join(process.env.KILO_TEST_MANAGED_CONFIG_DIR!, "enterprise.json")
const runtimes: ManagedRuntime.ManagedRuntime<Enterprise.Service, never>[] = []
const run = <A>(effect: Effect.Effect<A>) => Effect.runPromise(effect)

// A fresh client service, as a new CLI process would have: it reads the environment as it is now.
async function client() {
  const env = Layer.succeed(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv())
  const runtime = ManagedRuntime.make(Enterprise.defaultLayer.pipe(Layer.provide(env)))
  runtimes.push(runtime)
  return runtime.runPromise(
    Effect.gen(function* () {
      return yield* Enterprise.Service
    }),
  )
}

function signin(token: string, url = cp.url) {
  process.env.KILO_ENTERPRISE_URL = url
  process.env.KILO_ENTERPRISE_ORG = "acme"
  process.env.KILO_ENTERPRISE_TOKEN = token
}

afterEach(async () => {
  // Stop usage first, while credentials still exist, so nothing is spooled into the next test.
  for (const runtime of runtimes.splice(0)) {
    await runtime.runPromise(
      Enterprise.Service.use((service) => service.usage.stop().pipe(Effect.andThen(service.forget()))),
    )
    await runtime.dispose()
  }
  delete process.env.KILO_ENTERPRISE_URL
  delete process.env.KILO_ENTERPRISE_ORG
  delete process.env.KILO_ENTERPRISE_TOKEN
  delete process.env.KILO_ENTERPRISE_REQUIRED
  await rm(managed(), { force: true })
})
afterAll(async () => {
  await cp.stop()
})

const strict = {
  models: { blocked: ["openai"], default: { mode: "selected", items: ["anthropic", "kilo/anthropic/*"] } },
  permission: { bash: { "rm -rf *": "deny" }, webfetch: "deny" },
  mcp: {
    mode: "allowlist",
    allow: ["https://mcp.acme.dev/*"],
    servers: { docs: { type: "remote", url: "https://docs.acme.dev/mcp" } },
  },
  instructions: "Never paste customer data into prompts.",
}

describe("without enterprise configuration", () => {
  test("every hook is a no-op", async () => {
    const enterprise = await client()
    expect(await run(enterprise.settings())).toBeUndefined()
    expect(await run(enterprise.refusal({ type: "remote", url: "https://anything" }))).toBeUndefined()
    expect(await run(enterprise.blocked())).toBeUndefined()
    expect(await run(enterprise.permission())).toBeUndefined()
    expect(await run(enterprise.telemetry())).toBe(true)
    expect(await run(enterprise.sync())).toBe(true)
    const cfg: Config.Info = { permission: { bash: "allow" } }
    await run(enterprise.overlay(cfg))
    expect(cfg).toEqual({ permission: { bash: "allow" } })
    expect(await EnterprisePlugin(enterprise)({} as never)).toEqual({})
  })
})

describe("managed deployments", () => {
  test("a managed enterprise.json requires sign-in before the agent runs", async () => {
    await mkdir(path.dirname(managed()), { recursive: true })
    await writeFile(managed(), JSON.stringify({ url: cp.url, org: "acme" }))
    const enterprise = await client()
    expect(await run(enterprise.settings())).toMatchObject({ source: "managed", required: true })
    await run(enterprise.ready())
    expect(await run(enterprise.blocked())).toContain("kilo enterprise login")
    expect(await run(enterprise.refusal({ type: "local", command: ["npx", "server"] }))).toContain(
      "kilo enterprise login",
    )
    expect(await run(enterprise.telemetry())).toBe(false)
    expect(await run(enterprise.sync())).toBe(false)
  })

  test("a malformed managed file blocks with a clear message instead of crashing", async () => {
    await mkdir(path.dirname(managed()), { recursive: true })
    await writeFile(managed(), "{ not json")
    const enterprise = await client()
    expect(await run(enterprise.blocked())).toContain("Invalid")
  })

  test("the managed server cannot be overridden from the environment", async () => {
    await mkdir(path.dirname(managed()), { recursive: true })
    await writeFile(managed(), JSON.stringify({ url: cp.url, org: "acme", required: false }))
    process.env.KILO_ENTERPRISE_URL = "https://evil.example.com"
    const enterprise = await client()
    expect(await run(enterprise.settings())).toMatchObject({ url: cp.url, source: "managed", required: false })
  })
})

describe("policy enforcement", () => {
  test("MCP allowlist, permissions and org config are applied", async () => {
    expect((await cp.admin("PUT", "/policy", strict)).status).toBe(200)
    expect(
      (await cp.admin("POST", "/modes", { slug: "reviewer", name: "Reviewer", prompt: "Review.", mode: "subagent" }))
        .status,
    ).toBe(201)
    signin((await cp.join("dev@acme.com", "member")).token)
    const enterprise = await client()
    await run(enterprise.ready())

    expect(await run(enterprise.refusal({ type: "remote", url: "https://mcp.acme.dev/github" }))).toBeUndefined()
    expect(await run(enterprise.refusal({ type: "remote", url: "https://docs.acme.dev/mcp" }))).toBeUndefined()
    expect(await run(enterprise.refusal({ type: "local", command: ["npx", "-y", "random-server"] }))).toContain(
      "allowlist",
    )

    const cfg: Config.Info = {
      permission: { bash: { "rm -rf *": "allow", "*": "allow" }, edit: "allow" },
      agent: { reviewer: { prompt: "user override" } },
    }
    await run(enterprise.overlay(cfg))
    const bash = (cfg.permission as Record<string, Record<string, string>>).bash
    expect(Object.entries(bash).at(-1)).toEqual(["rm -rf *", "deny"])
    expect((cfg.permission as Record<string, unknown>).webfetch).toBe("deny")
    expect(cfg.agent?.reviewer).toMatchObject({ prompt: "Review.", mode: "subagent", source: "organization" })
    expect(cfg.mcp?.docs).toMatchObject({ type: "remote", url: "https://docs.acme.dev/mcp" })
    expect(cfg.share).toBe("disabled")
    expect(cfg.experimental?.openTelemetry).toBe(false)
    expect(await run(enterprise.instructions())).toBe("Never paste customer data into prompts.")
  })

  test("org patterns are appended after a user's catch-all so they win last-match evaluation", async () => {
    expect((await cp.admin("PUT", "/policy", strict)).status).toBe(200)
    signin((await cp.join("merge@acme.com", "member")).token)
    const enterprise = await client()
    const cfg: Config.Info = { permission: { bash: "allow", read: "allow" } }
    await run(enterprise.overlay(cfg))
    expect(cfg.permission).toEqual({ read: "allow", bash: { "*": "allow", "rm -rf *": "deny" }, webfetch: "deny" })
    const rules = Permission.fromConfig(cfg.permission as never)
    expect(Permission.evaluate("bash", "rm -rf /", rules).action).toBe("deny")
    expect(Permission.evaluate("bash", "git status", rules).action).toBe("allow")
  })

  test("the plugin refuses disallowed models and appends org rules to the system prompt", async () => {
    expect((await cp.admin("PUT", "/policy", strict)).status).toBe(200)
    signin((await cp.join("plugin@acme.com", "member")).token)
    const hooks = await EnterprisePlugin(await client())({} as never)
    const params = hooks["chat.params"]!
    const request = (providerID: string, id: string) => params({ model: { providerID, id } } as never, {} as never)
    await expect(request("openai", "gpt-5")).rejects.toThrow("not allowed by your organization's policy")
    await expect(request("google", "gemini-2.5-pro")).rejects.toThrow("not allowed by your organization's policy")
    await expect(request("anthropic", "claude-sonnet-4")).resolves.toBeUndefined()
    await expect(request("kilo", "anthropic/claude-opus-4")).resolves.toBeUndefined()
    const output = { system: [] as string[] }
    await hooks["experimental.chat.system.transform"]!({ model: {} } as never, output)
    expect(output.system.join("\n")).toContain("Never paste customer data into prompts.")
  })
})

describe("vendor cloud sync", () => {
  test("stays off unless the org explicitly allows sharing", async () => {
    expect((await cp.admin("PUT", "/policy", {})).status).toBe(200)
    signin((await cp.join("sync@acme.com", "member")).token)
    const enterprise = await client()
    expect(await run(enterprise.sync())).toBe(false)
    expect((await cp.admin("PUT", "/policy", { share: "allowed" })).status).toBe(200)
    await run(enterprise.refresh())
    expect(await run(enterprise.sync())).toBe(true)
  })
})

describe("usage and budgets", () => {
  test("step-finish events are reported per LLM call and exhausting a budget blocks requests", async () => {
    expect((await cp.admin("PUT", "/policy", {})).status).toBe(200)
    const dev = await cp.join("spender@acme.com", "member")
    expect(
      (await cp.admin("PUT", "/budgets", { budgets: [{ scope: "member", period: "day", amount: 1 }] })).status,
    ).toBe(200)
    signin(dev.token)
    const enterprise = await client()
    const hooks = await EnterprisePlugin(enterprise)({} as never)
    await hooks.event!({
      event: {
        type: "message.updated",
        properties: {
          info: {
            id: "msg_1",
            sessionID: "ses_1",
            role: "assistant",
            providerID: "anthropic",
            modelID: "claude-sonnet-4",
            path: { cwd: "/work/web", root: "/work/web" },
          },
        },
      },
    } as never)
    for (const [id, cost] of [
      ["prt_1", 0.75],
      ["prt_2", 0.5],
    ] as const)
      await hooks.event!({
        event: {
          type: "message.part.updated",
          properties: {
            part: {
              id,
              sessionID: "ses_1",
              messageID: "msg_1",
              type: "step-finish",
              reason: "stop",
              cost,
              tokens: { input: 100, output: 20, reasoning: 0, cache: { read: 0, write: 0 } },
            },
          },
        },
      } as never)
    expect(await run(enterprise.usage.pending())).toBe(2)
    expect(await run(enterprise.usage.flush())).toBe(true)
    expect(await run(enterprise.usage.pending())).toBe(0)

    const summary = await cp.store.usage.summary({
      org: cp.owner.org.id,
      by: "project",
      from: 0,
      to: Date.now() + 1,
      user: dev.user.id,
    })
    expect(summary).toMatchObject([{ key: "web", requests: 2, cost: 1.25 }])
    // The flush refreshed the policy, so the exhausted daily budget now blocks the next request.
    expect(await run(enterprise.blocked())).toContain("daily personal AI budget")
    await expect(
      hooks["chat.params"]!({ model: { providerID: "anthropic", id: "claude-sonnet-4" } } as never, {} as never),
    ).rejects.toThrow("budget")
  })

  test("records that cannot be delivered are spooled and sent by the next process", async () => {
    expect((await cp.admin("PUT", "/policy", {})).status).toBe(200)
    const remote = await plane()
    const dev = await remote.join("spool@acme.com", "member")
    signin(dev.token, remote.url)
    const first = await client()
    await run(first.usage.start())
    await run(
      first.usage.push({
        id: "prt_spooled",
        at: Date.now(),
        provider: "anthropic",
        model: "claude-sonnet-4",
        tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
        cost: 0.01,
      }),
    )
    await remote.stop()
    await run(first.usage.stop())
    expect(await run(first.usage.pending())).toBe(0)

    const back = remote.listen()
    signin(dev.token, back.url)
    const second = await client()
    await run(second.usage.start())
    expect(await run(second.usage.pending())).toBe(1)
    expect(await run(second.usage.flush())).toBe(true)
    await back.stop()
  })
})

describe("resilience", () => {
  test("a cached policy keeps applying while the control plane is unreachable", async () => {
    const remote = await plane()
    expect((await remote.admin("PUT", "/policy", strict)).status).toBe(200)
    signin((await remote.join("offline@acme.com", "member")).token, remote.url)
    const online = await client()
    await run(online.ready())
    expect((await run(online.current()))?.models.deny).toEqual(["openai/*"])
    await remote.stop()
    const offline = await client()
    await run(offline.ready())
    expect((await run(offline.current()))?.models.deny).toEqual(["openai/*"])
    expect((await run(offline.status())).error).toContain("cannot reach")
  })

  test("a revoked token drops the policy instead of trusting a stale copy", async () => {
    expect((await cp.admin("PUT", "/policy", strict)).status).toBe(200)
    const dev = await cp.join("revoked@acme.com", "member")
    signin(dev.token)
    process.env.KILO_ENTERPRISE_REQUIRED = "1"
    const enterprise = await client()
    await run(enterprise.ready())
    expect(await run(enterprise.current())).toBeDefined()
    await cp.store.user.update(dev.user.id, { active: false })
    await run(enterprise.refresh())
    expect(await run(enterprise.current())).toBeUndefined()
    expect(await run(enterprise.blocked())).toContain("kilo enterprise login")
  })

  test("an unchanged policy is confirmed with a 304 and keeps the cached copy", async () => {
    expect((await cp.admin("PUT", "/policy", strict)).status).toBe(200)
    signin((await cp.join("etag@acme.com", "member")).token)
    const enterprise = await client()
    await run(enterprise.ready())
    const before = await run(enterprise.status())
    await Bun.sleep(5)
    await run(enterprise.refresh())
    const after = await run(enterprise.status())
    expect(after.policy).toEqual(before.policy)
    expect(after.fetched!).toBeGreaterThan(before.fetched!)
  })
})
