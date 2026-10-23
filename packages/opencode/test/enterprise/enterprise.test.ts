import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { mkdir, rm, writeFile } from "fs/promises"
import path from "path"
import type { Config } from "../../src/config/config"
import { Enterprise, EnterprisePlugin } from "../../src/enterprise"
import * as Usage from "../../src/enterprise/usage"
import { KiloSessionPrompt } from "../../src/kilocode/session/prompt"
import { Permission } from "../../src/permission"
import { app, bootstrap, type Config as ServerConfig } from "../../../enterprise-server/src/app"
import { open } from "../../../enterprise-server/src/db"
import { create } from "../../../enterprise-server/src/store"

// Contract tests: the client talks to the real control plane over HTTP, so the two packages
// cannot drift apart on the wire format without these failing.

function plane() {
  const store = create(open(":memory:"))
  const config: ServerConfig = { base: "", secret: "test", proxy: false, txt: async () => [] }
  const handler = app(store, config)
  const server = Bun.serve({ port: 0, fetch: (req) => handler.fetch(req) })
  config.base = `http://localhost:${server.port}`
  const owner = bootstrap(store, { org: "Acme", slug: "acme", email: "owner@acme.com" })
  const admin = (method: string, route: string, body?: unknown) =>
    fetch(`${config.base}/api/v1/orgs/acme${route}`, {
      method,
      headers: { authorization: `Bearer ${owner.token}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  const member = (email: string) => {
    const user = store.user.ensure({ email })
    store.member.add(owner.org.id, user.id, "member")
    return { user, token: store.token.issue({ kind: "user", user: user.id, org: owner.org.id, name: "cli" }).value }
  }
  return { store, server, url: config.base, owner, admin, member }
}

const cp = plane()
const managed = () => path.join(process.env.KILO_TEST_MANAGED_CONFIG_DIR!, "enterprise.json")

function signin(token: string, url = cp.url) {
  process.env.KILO_ENTERPRISE_URL = url
  process.env.KILO_ENTERPRISE_ORG = "acme"
  process.env.KILO_ENTERPRISE_TOKEN = token
  Enterprise.reset()
}

afterEach(async () => {
  // Stop usage first, while credentials still exist, so nothing is spooled into the next test.
  await Usage.stop()
  delete process.env.KILO_ENTERPRISE_URL
  delete process.env.KILO_ENTERPRISE_ORG
  delete process.env.KILO_ENTERPRISE_TOKEN
  delete process.env.KILO_ENTERPRISE_REQUIRED
  await rm(managed(), { force: true })
  await Enterprise.forget()
})
afterAll(() => cp.server.stop(true))

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
    Enterprise.reset()
    expect(Enterprise.settings()).toBeNull()
    expect(Enterprise.model("openai", "gpt-5")).toBe(true)
    expect(Enterprise.mcp({ type: "remote", url: "https://anything" })).toBeUndefined()
    expect(Enterprise.blocked()).toBeUndefined()
    expect(Enterprise.permission()).toBeUndefined()
    expect(Enterprise.telemetry()).toBe(true)
    expect(Enterprise.sync()).toBe(true)
    const cfg: Config.Info = { permission: { bash: "allow" } }
    await Enterprise.overlay(cfg)
    expect(cfg).toEqual({ permission: { bash: "allow" } })
    expect(await EnterprisePlugin({} as never)).toEqual({})
  })
})

describe("managed deployments", () => {
  test("a managed enterprise.json requires sign-in before the agent runs", async () => {
    await mkdir(path.dirname(managed()), { recursive: true })
    await writeFile(managed(), JSON.stringify({ url: cp.url, org: "acme" }))
    Enterprise.reset()
    expect(Enterprise.settings()).toMatchObject({ source: "managed", required: true })
    await Enterprise.ready()
    expect(Enterprise.blocked()).toContain("kilo enterprise login")
    expect(Enterprise.mcp({ type: "local", command: ["npx", "server"] })).toContain("kilo enterprise login")
    expect(Enterprise.telemetry()).toBe(false)
    expect(Enterprise.sync()).toBe(false)
  })

  test("a malformed managed file blocks with a clear message instead of crashing", async () => {
    await mkdir(path.dirname(managed()), { recursive: true })
    await writeFile(managed(), "{ not json")
    Enterprise.reset()
    expect(Enterprise.blocked()).toContain("Invalid")
  })

  test("the managed server cannot be overridden from the environment", async () => {
    await mkdir(path.dirname(managed()), { recursive: true })
    await writeFile(managed(), JSON.stringify({ url: cp.url, org: "acme", required: false }))
    process.env.KILO_ENTERPRISE_URL = "https://evil.example.com"
    Enterprise.reset()
    expect(Enterprise.settings()).toMatchObject({ url: cp.url, source: "managed", required: false })
  })
})

describe("policy enforcement", () => {
  test("model access, MCP allowlist, permissions and org config are applied", async () => {
    expect((await cp.admin("PUT", "/policy", strict)).status).toBe(200)
    expect(
      (await cp.admin("POST", "/modes", { slug: "reviewer", name: "Reviewer", prompt: "Review.", mode: "subagent" }))
        .status,
    ).toBe(201)
    signin(cp.member("dev@acme.com").token)
    await Enterprise.ready()

    expect(Enterprise.model("anthropic", "claude-sonnet-4")).toBe(true)
    expect(Enterprise.model("kilo", "anthropic/claude-opus-4")).toBe(true)
    expect(Enterprise.model("openai", "gpt-5")).toBe(false)
    expect(Enterprise.model("google", "gemini-2.5-pro")).toBe(false)

    expect(Enterprise.mcp({ type: "remote", url: "https://mcp.acme.dev/github" })).toBeUndefined()
    expect(Enterprise.mcp({ type: "remote", url: "https://docs.acme.dev/mcp" })).toBeUndefined()
    expect(Enterprise.mcp({ type: "local", command: ["npx", "-y", "random-server"] })).toContain("allowlist")

    const cfg: Config.Info = {
      permission: { bash: { "rm -rf *": "allow", "*": "allow" }, edit: "allow" },
      agent: { reviewer: { prompt: "user override" } },
    }
    await Enterprise.overlay(cfg)
    const bash = (cfg.permission as Record<string, Record<string, string>>).bash
    expect(Object.entries(bash).at(-1)).toEqual(["rm -rf *", "deny"])
    expect((cfg.permission as Record<string, unknown>).webfetch).toBe("deny")
    expect(cfg.agent?.reviewer).toMatchObject({ prompt: "Review.", mode: "subagent", source: "organization" })
    expect(cfg.mcp?.docs).toMatchObject({ type: "remote", url: "https://docs.acme.dev/mcp" })
    expect(cfg.share).toBe("disabled")
    expect(cfg.experimental?.openTelemetry).toBe(false)
    expect(Enterprise.instructions()).toBe("Never paste customer data into prompts.")
  })

  test("org patterns are appended after a user's catch-all so they win last-match evaluation", async () => {
    expect((await cp.admin("PUT", "/policy", strict)).status).toBe(200)
    signin(cp.member("merge@acme.com").token)
    const cfg: Config.Info = { permission: { bash: "allow", read: "allow" } }
    await Enterprise.overlay(cfg)
    expect(cfg.permission).toEqual({ read: "allow", bash: { "*": "allow", "rm -rf *": "deny" }, webfetch: "deny" })
    const rules = Permission.fromConfig(cfg.permission as never)
    expect(Permission.evaluate("bash", "rm -rf /", rules).action).toBe("deny")
    expect(Permission.evaluate("bash", "git status", rules).action).toBe("allow")
  })

  test("org denies become hard rules that session approvals cannot override", async () => {
    expect((await cp.admin("PUT", "/policy", strict)).status).toBe(200)
    signin(cp.member("hard@acme.com").token)
    await Enterprise.ready()
    const built = KiloSessionPrompt.buildAskRuleset({
      agent: { name: "code", permission: [{ permission: "bash", pattern: "*", action: "allow" }] },
      session: { permission: [{ permission: "bash", pattern: "*", action: "allow" }] },
    })
    expect(built.hardRuleset).toBeDefined()
    expect(Permission.evaluate("bash", "rm -rf /", built.hardRuleset!).action).toBe("deny")
    expect(Permission.evaluate("webfetch", "https://example.com", built.hardRuleset!).action).toBe("deny")
    expect(Permission.evaluate("bash", "ls", built.hardRuleset!).action).not.toBe("deny")
  })

  test("the plugin refuses disallowed models and appends org rules to the system prompt", async () => {
    expect((await cp.admin("PUT", "/policy", strict)).status).toBe(200)
    signin(cp.member("plugin@acme.com").token)
    const hooks = await EnterprisePlugin({} as never)
    const params = hooks["chat.params"]!
    const request = (providerID: string, id: string) =>
      params({ model: { providerID, id } } as never, {} as never) as Promise<void>
    await expect(request("openai", "gpt-5")).rejects.toThrow("not allowed by your organization's policy")
    await expect(request("anthropic", "claude-sonnet-4")).resolves.toBeUndefined()
    const output = { system: [] as string[] }
    await hooks["experimental.chat.system.transform"]!({ model: {} } as never, output)
    expect(output.system.join("\n")).toContain("Never paste customer data into prompts.")
  })
})

describe("vendor cloud sync", () => {
  test("stays off unless the org explicitly allows sharing", async () => {
    expect((await cp.admin("PUT", "/policy", {})).status).toBe(200)
    signin(cp.member("sync@acme.com").token)
    await Enterprise.ready()
    expect(Enterprise.sync()).toBe(false)
    expect((await cp.admin("PUT", "/policy", { share: "allowed" })).status).toBe(200)
    await Enterprise.refresh()
    expect(Enterprise.sync()).toBe(true)
  })
})

describe("usage and budgets", () => {
  test("step-finish events are reported per LLM call and exhausting a budget blocks requests", async () => {
    expect((await cp.admin("PUT", "/policy", {})).status).toBe(200)
    const dev = cp.member("spender@acme.com")
    expect(
      (await cp.admin("PUT", "/budgets", { budgets: [{ scope: "member", period: "day", amount: 1 }] })).status,
    ).toBe(200)
    signin(dev.token)
    const hooks = await EnterprisePlugin({} as never)
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
    expect(Usage.pending()).toBe(2)
    expect(await Usage.flush()).toBe(true)
    expect(Usage.pending()).toBe(0)

    const summary = cp.store.usage.summary({
      org: cp.owner.org.id,
      by: "project",
      from: 0,
      to: Date.now() + 1,
      user: dev.user.id,
    })
    expect(summary).toMatchObject([{ key: "web", requests: 2, cost: 1.25 }])
    // The flush refreshed the policy, so the exhausted daily budget now blocks the next request.
    expect(Enterprise.blocked()).toContain("daily personal AI budget")
    await expect(
      hooks["chat.params"]!({ model: { providerID: "anthropic", id: "claude-sonnet-4" } } as never, {} as never),
    ).rejects.toThrow("budget")
  })
})

describe("resilience", () => {
  test("a cached policy keeps applying while the control plane is unreachable", async () => {
    const remote = plane()
    expect((await remote.admin("PUT", "/policy", strict)).status).toBe(200)
    signin(remote.member("offline@acme.com").token, remote.url)
    await Enterprise.ready()
    expect(Enterprise.model("openai", "gpt-5")).toBe(false)
    remote.server.stop(true)
    Enterprise.reset()
    await Enterprise.ready()
    expect(Enterprise.model("openai", "gpt-5")).toBe(false)
    expect(Enterprise.status().error).toContain("cannot reach")
  })

  test("a revoked token drops the policy instead of trusting a stale copy", async () => {
    expect((await cp.admin("PUT", "/policy", strict)).status).toBe(200)
    const dev = cp.member("revoked@acme.com")
    signin(dev.token)
    process.env.KILO_ENTERPRISE_REQUIRED = "1"
    Enterprise.reset()
    await Enterprise.ready()
    expect(Enterprise.current()).toBeDefined()
    cp.store.user.update(dev.user.id, { active: false })
    await Enterprise.refresh()
    expect(Enterprise.current()).toBeUndefined()
    expect(Enterprise.blocked()).toContain("kilo enterprise login")
  })
})
