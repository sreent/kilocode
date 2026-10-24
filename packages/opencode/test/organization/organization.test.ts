// kilocode_change - new file (organization)
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { mkdir, rm, writeFile } from "fs/promises"
import path from "path"
import { ConfigProvider, Effect, Layer, ManagedRuntime } from "effect"
import type { Config } from "../../src/config/config"
import { Organization, OrganizationPlugin } from "../../src/organization"
import { Permission } from "../../src/permission"
import { setup } from "../../../organization-server/test/fixture"

// Contract tests: the client talks to the real control plane over HTTP, so the two packages
// cannot drift apart on the wire format without these failing.

// A second control plane, beside `cp`, needs a database of its own.
async function plane(options: { isolated?: boolean } = {}) {
  const env = await setup({}, options)
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
const managed = () => path.join(process.env.KILO_TEST_MANAGED_CONFIG_DIR!, "organization.json")
// The managed file's name before the rename.
const legacy = () => path.join(process.env.KILO_TEST_MANAGED_CONFIG_DIR!, "enterprise.json")
const runtimes: ManagedRuntime.ManagedRuntime<Organization.Service, never>[] = []
const run = <A>(effect: Effect.Effect<A>) => Effect.runPromise(effect)

// A fresh client service, as a new CLI process would have: it reads the environment as it is now.
async function client() {
  const env = Layer.succeed(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv())
  const runtime = ManagedRuntime.make(Organization.defaultLayer.pipe(Layer.provide(env)))
  runtimes.push(runtime)
  return runtime.runPromise(
    Effect.gen(function* () {
      return yield* Organization.Service
    }),
  )
}

function signin(token: string, url = cp.url) {
  process.env.KILO_ORG_URL = url
  process.env.KILO_ORG = "acme"
  process.env.KILO_ORG_TOKEN = token
}

afterEach(async () => {
  // Stop usage first, while credentials still exist, so nothing is spooled into the next test.
  for (const runtime of runtimes.splice(0)) {
    await runtime.runPromise(
      Organization.Service.use((service) => service.usage.stop().pipe(Effect.andThen(service.forget()))),
    )
    await runtime.dispose()
  }
  delete process.env.KILO_ORG_URL
  delete process.env.KILO_ORG
  delete process.env.KILO_ORG_TOKEN
  delete process.env.KILO_ORG_REQUIRED
  for (const name of ["URL", "ORG", "TOKEN", "REQUIRED"]) delete process.env[`KILO_ENTERPRISE_${name}`]
  await rm(managed(), { force: true })
  await rm(legacy(), { force: true })
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

describe("without organization configuration", () => {
  test("every hook is a no-op", async () => {
    const organization = await client()
    expect(await run(organization.settings())).toBeUndefined()
    expect(await run(organization.refusal({ type: "remote", url: "https://anything" }))).toBeUndefined()
    expect(await run(organization.blocked())).toBeUndefined()
    expect(await run(organization.permission())).toBeUndefined()
    expect(await run(organization.telemetry())).toBe(true)
    expect(await run(organization.sync())).toBe(true)
    const cfg: Config.Info = { permission: { bash: "allow" } }
    await run(organization.overlay(cfg))
    expect(cfg).toEqual({ permission: { bash: "allow" } })
    expect(await OrganizationPlugin(organization)({} as never)).toEqual({})
  })
})

describe("managed deployments", () => {
  test("a managed organization.json requires sign-in before the agent runs", async () => {
    await mkdir(path.dirname(managed()), { recursive: true })
    await writeFile(managed(), JSON.stringify({ url: cp.url, org: "acme" }))
    const organization = await client()
    expect(await run(organization.settings())).toMatchObject({ source: "managed", required: true })
    await run(organization.ready())
    expect(await run(organization.blocked())).toContain("kilo org login")
    expect(await run(organization.refusal({ type: "local", command: ["npx", "server"] }))).toContain("kilo org login")
    expect(await run(organization.telemetry())).toBe(false)
    expect(await run(organization.sync())).toBe(false)
  })

  test("a managed enterprise.json from before the rename keeps the device managed", async () => {
    await mkdir(path.dirname(legacy()), { recursive: true })
    await writeFile(legacy(), JSON.stringify({ url: cp.url, org: "acme" }))
    const organization = await client()
    expect(await run(organization.settings())).toMatchObject({ source: "managed", required: true })
    await run(organization.ready())
    expect(await run(organization.blocked())).toContain("kilo org login")
  })

  test("CI variables named before the rename keep the device enrolled", async () => {
    process.env.KILO_ENTERPRISE_URL = cp.url
    process.env.KILO_ENTERPRISE_ORG = "acme"
    process.env.KILO_ENTERPRISE_REQUIRED = "1"
    const organization = await client()
    expect(await run(organization.settings())).toMatchObject({
      url: cp.url,
      org: "acme",
      source: "env",
      required: true,
    })
    await run(organization.ready())
    expect(await run(organization.blocked())).toContain("kilo org login")
  })

  test("a malformed managed file blocks with a clear message instead of crashing", async () => {
    await mkdir(path.dirname(managed()), { recursive: true })
    await writeFile(managed(), "{ not json")
    const organization = await client()
    expect(await run(organization.blocked())).toContain("Invalid")
  })

  test("the managed server cannot be overridden from the environment", async () => {
    await mkdir(path.dirname(managed()), { recursive: true })
    await writeFile(managed(), JSON.stringify({ url: cp.url, org: "acme", required: false }))
    process.env.KILO_ORG_URL = "https://evil.example.com"
    const organization = await client()
    expect(await run(organization.settings())).toMatchObject({ url: cp.url, source: "managed", required: false })
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
    const organization = await client()
    await run(organization.ready())

    expect(await run(organization.refusal({ type: "remote", url: "https://mcp.acme.dev/github" }))).toBeUndefined()
    expect(await run(organization.refusal({ type: "remote", url: "https://docs.acme.dev/mcp" }))).toBeUndefined()
    expect(await run(organization.refusal({ type: "local", command: ["npx", "-y", "random-server"] }))).toContain(
      "allowlist",
    )

    const cfg: Config.Info = {
      permission: { bash: { "rm -rf *": "allow", "*": "allow" }, edit: "allow" },
      agent: { reviewer: { prompt: "user override" } },
    }
    await run(organization.overlay(cfg))
    const bash = (cfg.permission as Record<string, Record<string, string>>).bash
    expect(Object.entries(bash).at(-1)).toEqual(["rm -rf *", "deny"])
    expect((cfg.permission as Record<string, unknown>).webfetch).toBe("deny")
    expect(cfg.agent?.reviewer).toMatchObject({ prompt: "Review.", mode: "subagent", source: "organization" })
    expect(cfg.mcp?.docs).toMatchObject({ type: "remote", url: "https://docs.acme.dev/mcp" })
    expect(cfg.share).toBe("disabled")
    expect(cfg.experimental?.openTelemetry).toBe(false)
    expect(await run(organization.instructions())).toBe("Never paste customer data into prompts.")
  })

  test("org patterns are appended after a user's catch-all so they win last-match evaluation", async () => {
    expect((await cp.admin("PUT", "/policy", strict)).status).toBe(200)
    signin((await cp.join("merge@acme.com", "member")).token)
    const organization = await client()
    const cfg: Config.Info = { permission: { bash: "allow", read: "allow" } }
    await run(organization.overlay(cfg))
    expect(cfg.permission).toEqual({ read: "allow", bash: { "*": "allow", "rm -rf *": "deny" }, webfetch: "deny" })
    const rules = Permission.fromConfig(cfg.permission as never)
    expect(Permission.evaluate("bash", "rm -rf /", rules).action).toBe("deny")
    expect(Permission.evaluate("bash", "git status", rules).action).toBe("allow")
  })

  test("the plugin refuses disallowed models and appends org rules to the system prompt", async () => {
    expect((await cp.admin("PUT", "/policy", strict)).status).toBe(200)
    signin((await cp.join("plugin@acme.com", "member")).token)
    const hooks = await OrganizationPlugin(await client())({} as never)
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

describe("data policy", () => {
  test("the plugin refuses providers it doesn't admit and routes OpenRouter-compatible ones by it", async () => {
    expect(
      (
        await cp.admin("PUT", "/policy", {
          data: {
            training: "denied",
            retention: "zero",
            providers: {
              anthropic: { training: false, retention: 0, regions: ["us"] },
              openai: { training: false, retention: 30, regions: ["us"] },
              openrouter: { training: false, retention: 0, regions: ["us"], routing: true },
            },
          },
        })
      ).status,
    ).toBe(200)
    signin((await cp.join("data@acme.com", "member")).token)
    const hooks = await OrganizationPlugin(await client())({} as never)
    const params = hooks["chat.params"]!
    const request = (providerID: string, id: string, options: Record<string, unknown> = {}) => {
      const output = { options }
      return params({ model: { providerID, id } } as never, output as never).then(() => output.options)
    }
    await expect(request("openai", "gpt-5")).rejects.toThrow(
      "Your organization's data policy doesn't allow openai: it keeps data for 30 days.",
    )
    await expect(request("mistral", "codestral")).rejects.toThrow("its data terms aren't on record")
    expect(await request("anthropic", "claude-sonnet-4")).toEqual({})
    expect(await request("openrouter", "anthropic/claude-sonnet-4", { provider: { order: ["anthropic"] } })).toEqual({
      provider: { order: ["anthropic"], data_collection: "deny", zdr: true },
    })
  })
})

describe("vendor cloud sync", () => {
  test("stays off unless the org explicitly allows sharing", async () => {
    expect((await cp.admin("PUT", "/policy", {})).status).toBe(200)
    signin((await cp.join("sync@acme.com", "member")).token)
    const organization = await client()
    expect(await run(organization.sync())).toBe(false)
    expect((await cp.admin("PUT", "/policy", { share: "allowed" })).status).toBe(200)
    await run(organization.refresh())
    expect(await run(organization.sync())).toBe(true)
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
    const organization = await client()
    const hooks = await OrganizationPlugin(organization)({} as never)
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
    expect(await run(organization.usage.pending())).toBe(2)
    expect(await run(organization.usage.flush())).toBe(true)
    expect(await run(organization.usage.pending())).toBe(0)

    const summary = await cp.store.usage.summary({
      org: cp.owner.org.id,
      by: "project",
      from: 0,
      to: Date.now() + 1,
      user: dev.user.id,
    })
    expect(summary).toMatchObject([{ key: "web", requests: 2, cost: 1.25 }])
    // The flush refreshed the policy, so the exhausted daily budget now blocks the next request.
    expect(await run(organization.blocked())).toContain("daily personal AI budget")
    await expect(
      hooks["chat.params"]!({ model: { providerID: "anthropic", id: "claude-sonnet-4" } } as never, {} as never),
    ).rejects.toThrow("budget")
  })

  test("records that cannot be delivered are spooled and sent by the next process", async () => {
    expect((await cp.admin("PUT", "/policy", {})).status).toBe(200)
    const remote = await plane({ isolated: true })
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

describe("tool-run audit", () => {
  // A finished tool part, as the session publishes it.
  const tool = (id: string, name: string, state: Record<string, unknown>) => ({
    event: {
      type: "message.part.updated",
      properties: {
        part: { id, sessionID: "ses_t", messageID: "msg_t", type: "tool", callID: `call_${id}`, tool: name, state },
      },
    },
  })
  const time = { start: Date.now() - 1_500, end: Date.now() }

  test("finished tool runs go to the org audit log at the level the policy sets", async () => {
    expect((await cp.admin("PUT", "/policy", { audit: { tools: "summary" } })).status).toBe(200)
    const dev = await cp.join("tools@acme.com", "member")
    signin(dev.token)
    const organization = await client()
    const hooks = await OrganizationPlugin(organization)({} as never)
    await hooks.event!({
      event: {
        type: "message.updated",
        properties: {
          info: {
            id: "msg_t",
            sessionID: "ses_t",
            role: "assistant",
            providerID: "anthropic",
            modelID: "claude-sonnet-4",
            path: { cwd: "/work/web", root: "/work/web" },
          },
        },
      },
    } as never)
    const read = tool("prt_read", "read", {
      status: "completed",
      input: { filePath: "/work/web/src/app.ts" },
      output: "export {}",
      title: "src/app.ts",
      metadata: {},
      time,
    })
    for (const event of [
      // Running parts are not finished yet.
      tool("prt_read", "read", { status: "running", input: { filePath: "/work/web/src/app.ts" }, time }),
      read,
      // A later update to a finished part reports nothing new.
      read,
      tool("prt_bash", "bash", {
        status: "error",
        input: { command: "TOKEN=secret rm -rf build", description: "Clean" },
        error: "The user rejected permission to use this specific tool call.",
        time,
      }),
      tool("prt_fetch", "webfetch", {
        status: "completed",
        input: { url: "https://docs.acme.dev/guide?token=secret" },
        output: "",
        title: "",
        metadata: {},
        time,
      }),
      // Compaction rewrites parts that finished long before.
      tool("prt_old", "read", {
        status: "completed",
        input: { filePath: "/work/web/old.ts" },
        output: "",
        title: "",
        metadata: {},
        time: { ...time, compacted: Date.now() },
      }),
    ])
      await hooks.event!(event as never)
    expect(await run(organization.tools.pending())).toBe(3)
    expect(await run(organization.tools.flush())).toBe(true)

    const logged = async () =>
      (await cp.store.audit.query({ org: cp.owner.org.id, actions: ["client.tool_run"], limit: 10 })).filter(
        (event) => event.actor === dev.user.id,
      )
    const summary = await logged()
    expect(summary.map((event) => [event.target, event.details])).toEqual([
      [
        "webfetch",
        {
          tool: "webfetch",
          outcome: "completed",
          duration_ms: 1_500,
          session: "ses_t",
          project: "web",
          subject: "https://docs.acme.dev",
        },
      ],
      [
        "bash",
        {
          tool: "bash",
          outcome: "error",
          duration_ms: 1_500,
          session: "ses_t",
          project: "web",
          subject: "rm",
          error: "The user rejected permission to use this specific tool call.",
        },
      ],
      [
        "read",
        {
          tool: "read",
          outcome: "completed",
          duration_ms: 1_500,
          session: "ses_t",
          project: "web",
          subject: "src/app.ts",
        },
      ],
    ])
    expect(summary.every((event) => event.email === "tools@acme.com")).toBe(true)

    // With inputs on, the tool's input comes too.
    expect((await cp.admin("PUT", "/policy", { audit: { tools: "inputs" } })).status).toBe(200)
    await run(organization.refresh())
    await hooks.event!(
      tool("prt_grep", "grep", {
        status: "completed",
        input: { pattern: "password", path: "/work/web/src" },
        output: "",
        title: "",
        metadata: {},
        time,
      }) as never,
    )
    expect(await run(organization.tools.flush())).toBe(true)
    expect((await logged())[0].details).toMatchObject({
      subject: "src",
      input: JSON.stringify({ pattern: "password", path: "/work/web/src" }),
    })

    // Off again, nothing is queued.
    expect((await cp.admin("PUT", "/policy", {})).status).toBe(200)
    await run(organization.refresh())
    await hooks.event!(
      tool("prt_list", "list", { status: "completed", input: {}, output: "", title: "", metadata: {}, time }) as never,
    )
    expect(await run(organization.tools.pending())).toBe(0)
    expect(await logged()).toHaveLength(4)
  })
})

describe("sign-in", () => {
  // What the IDEs drive through `kilo serve`, and `kilo org login` in the terminal.
  test("a device sign-in waits for the browser; a token signs in at once; signing out forgets both", async () => {
    const dev = await cp.join("device@acme.com", "member")
    // Device sign-in goes through the org's SSO; the browser leg is approved directly below.
    await cp.store.sso.set(cp.owner.org.id, {
      protocol: "oidc",
      issuer: "https://idp.test",
      client: "kilo",
      secret: "unused",
      scopes: "openid email",
      enforce: false,
      provision: false,
    })
    const organization = await client()
    const attempt = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)

    const pending = await attempt(organization.signin.start({ url: cp.url, org: "acme" }))
    expect(pending.code).toMatch(/^[A-Z]{4}-[A-Z]{4}$/)
    expect(pending.link).toEndWith(`/device?code=${pending.code}`)
    expect(await run(organization.signin.pending())).toMatchObject({ code: pending.code, org: "acme" })
    await cp.store.device.decide(pending.code, "approved", dev.user.id)
    expect(await attempt(organization.signin.finish())).toEqual({
      org: "Acme",
      email: "device@acme.com",
      role: "member",
    })
    expect((await run(organization.stored()))?.user.email).toBe("device@acme.com")
    expect(await run(organization.signin.pending())).toBeUndefined()

    const denied = await attempt(organization.signin.start({ url: cp.url, org: "acme" }))
    await cp.store.device.decide(denied.code, "denied")
    await expect(attempt(organization.signin.finish())).rejects.toThrow("Sign-in was denied.")

    await run(organization.signout())
    expect(await run(organization.stored())).toBeUndefined()
    await expect(attempt(organization.signin.start())).rejects.toThrow("Give the control plane URL")
    await expect(attempt(organization.signin.token({ url: cp.url, org: "acme", token: "korg_nope" }))).rejects.toThrow(
      "rejected this token",
    )
    expect(await attempt(organization.signin.token({ url: cp.url, org: "acme", token: dev.token }))).toMatchObject({
      email: "device@acme.com",
    })
    expect((await run(organization.status())).policy?.user.email).toBe("device@acme.com")
    await cp.store.sso.remove(cp.owner.org.id)
  }, 30_000)
})

describe("LLM gateway", () => {
  test("providers clients don't know arrive with their name, models and SDK", async () => {
    const litellm = {
      kind: "openai-compatible",
      base: "https://litellm.acme.internal/v1",
      key: "sk-litellm-virtual-key",
      name: "LiteLLM",
      models: [
        {
          id: "claude-sonnet",
          name: "Claude Sonnet",
          context: 200000,
          output: 64000,
          reasoning: true,
          attachments: true,
        },
        { id: "llama-70b", cost: { input: 0.5, output: 0.8 } },
      ],
    }
    const bedrock = {
      kind: "bedrock",
      base: "https://bedrock-runtime.us-east-1.amazonaws.com",
      auth: { type: "bearer" },
      key: "bedrock-api-key",
      models: [{ id: "us.anthropic.claude-sonnet-4-5-20250929-v1:0", context: 200000 }],
    }
    expect((await cp.admin("PUT", "/gateway/providers/litellm", litellm)).status).toBe(200)
    expect((await cp.admin("PUT", "/gateway/providers/bedrock-claude", bedrock)).status).toBe(200)
    try {
      const dev = await cp.join("custom@acme.com", "member")
      signin(dev.token)
      const organization = await client()
      const cfg: Config.Info = {}
      await run(organization.overlay(cfg))
      expect(cfg.provider?.litellm).toEqual({
        name: "LiteLLM",
        npm: "@ai-sdk/openai-compatible",
        models: {
          "claude-sonnet": {
            name: "Claude Sonnet",
            limit: { context: 200000, output: 64000 },
            reasoning: true,
            attachment: true,
            modalities: { input: ["text", "image", "pdf"] },
          },
          "llama-70b": { name: "llama-70b", cost: { input: 0.5, output: 0.8 } },
        },
        options: { baseURL: `${cp.url}/gateway/litellm`, apiKey: dev.token },
      })
      // Claude on Bedrock is reached through Anthropic's API at the gateway.
      expect(cfg.provider?.["bedrock-claude"]).toMatchObject({
        name: "bedrock-claude",
        npm: "@ai-sdk/anthropic",
        models: { "us.anthropic.claude-sonnet-4-5-20250929-v1:0": { limit: { context: 200000, output: 0 } } },
      })
    } finally {
      await cp.admin("DELETE", "/gateway/providers/litellm")
      await cp.admin("DELETE", "/gateway/providers/bedrock-claude")
    }
  })

  test("routed providers call the control plane with the organization token and are metered there", async () => {
    expect((await cp.admin("PUT", "/policy", {})).status).toBe(200)
    const route = { kind: "openai-compatible", base: "https://openrouter.ai/api/v1", key: "sk-or-org-key-0123456789" }
    expect((await cp.admin("PUT", "/gateway/providers/openrouter", route)).status).toBe(200)
    try {
      const dev = await cp.join("gateway@acme.com", "member")
      signin(dev.token)
      const organization = await client()
      const cfg: Config.Info = { provider: { openrouter: { options: { apiKey: "sk-or-personal", timeout: 5000 } } } }
      await run(organization.overlay(cfg))
      expect(cfg.provider?.openrouter?.options).toEqual({
        apiKey: dev.token,
        baseURL: `${cp.url}/gateway/openrouter`,
        timeout: 5000,
      })

      const hooks = await OrganizationPlugin(organization)({ worktree: "/work/api", directory: "/work/api" } as never)
      const headers = async (providerID: string) => {
        const output = { headers: {} as Record<string, string> }
        await hooks["chat.headers"]!({ sessionID: "ses_9", model: { providerID, id: "m" } } as never, output)
        return output.headers
      }
      expect(await headers("openrouter")).toEqual({ "x-org-session": "ses_9", "x-org-project": "api" })
      expect(await headers("anthropic")).toEqual({})

      // The gateway meters these calls itself, so the client does not report them as well.
      await hooks.event!({
        event: {
          type: "message.updated",
          properties: {
            info: {
              id: "msg_gw",
              sessionID: "ses_9",
              role: "assistant",
              providerID: "openrouter",
              modelID: "anthropic/claude-sonnet-4",
              path: { cwd: "/work/api", root: "/work/api" },
            },
          },
        },
      } as never)
      await hooks.event!({
        event: {
          type: "message.part.updated",
          properties: {
            part: {
              id: "prt_gw",
              sessionID: "ses_9",
              messageID: "msg_gw",
              type: "step-finish",
              reason: "stop",
              cost: 0.5,
              tokens: { input: 100, output: 20, reasoning: 0, cache: { read: 0, write: 0 } },
            },
          },
        },
      } as never)
      expect(await run(organization.usage.pending())).toBe(0)

      // An exclusive gateway refuses every provider it does not route.
      expect((await cp.admin("PUT", "/policy", { gateway: { exclusive: true } })).status).toBe(200)
      await run(organization.refresh())
      const params = (providerID: string, id: string) =>
        hooks["chat.params"]!({ model: { providerID, id } } as never, {} as never)
      await expect(params("anthropic", "claude-sonnet-4")).rejects.toThrow("not allowed by your organization's policy")
      await expect(params("openrouter", "anthropic/claude-sonnet-4")).resolves.toBeUndefined()
    } finally {
      await cp.admin("DELETE", "/gateway/providers/openrouter")
      await cp.admin("PUT", "/policy", {})
    }
  })
})

describe("resilience", () => {
  test("a cached policy keeps applying while the control plane is unreachable", async () => {
    const remote = await plane({ isolated: true })
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
    process.env.KILO_ORG_REQUIRED = "1"
    const organization = await client()
    await run(organization.ready())
    expect(await run(organization.current())).toBeDefined()
    await cp.store.user.update(dev.user.id, { active: false })
    await run(organization.refresh())
    expect(await run(organization.current())).toBeUndefined()
    expect(await run(organization.blocked())).toContain("kilo org login")
  })

  test("an unchanged policy is confirmed with a 304 and keeps the cached copy", async () => {
    expect((await cp.admin("PUT", "/policy", strict)).status).toBe(200)
    signin((await cp.join("etag@acme.com", "member")).token)
    const organization = await client()
    await run(organization.ready())
    const before = await run(organization.status())
    await Bun.sleep(5)
    await run(organization.refresh())
    const after = await run(organization.status())
    expect(after.policy).toEqual(before.policy)
    expect(after.fetched!).toBeGreaterThan(before.fetched!)
  })
})
