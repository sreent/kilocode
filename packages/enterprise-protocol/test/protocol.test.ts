import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { OpenApi } from "effect/unstable/httpapi"
import { Api } from "../src/api"
import { allows, normalize, refusal, target } from "../src/match"
import { Effective, GatewayProviderInput, Mode, Policy, UsageRecord } from "../src/schema"

describe("schemas", () => {
  test("an empty policy decodes to the secure defaults", () => {
    expect(Schema.decodeUnknownSync(Policy)({})).toEqual({
      models: { blocked: [] },
      mcp: { mode: "open", allow: [], block: [], servers: {} },
      permission: {},
      share: "disabled",
      telemetry: { product: false },
      gateway: { exclusive: false },
    })
  })

  test("an effective policy without a gateway, as cached by older clients, still decodes", () => {
    const cached = {
      org: { id: "org_1", slug: "acme", name: "Acme" },
      user: { id: "usr_1", email: "a@acme.com", role: "member" },
      ttl: 300,
      version: 1,
      groups: [],
      models: { allow: null, deny: [] },
      mcp: { allow: null, deny: [], servers: {} },
      permission: {},
      instructions: null,
      agents: {},
      share: "disabled",
      telemetry: { product: false },
      budget: { exceeded: false, limits: [] },
    }
    expect(Schema.decodeUnknownSync(Effective)(cached).gateway).toEqual({ exclusive: false, providers: [] })
  })

  test("gateway upstreams must be plain http(s) base URLs", () => {
    const decode = Schema.decodeUnknownSync(GatewayProviderInput)
    expect(decode({ kind: "anthropic", base: "https://api.anthropic.com/v1" })).toEqual({
      kind: "anthropic",
      base: "https://api.anthropic.com/v1",
    })
    expect(() => decode({ kind: "anthropic", base: "https://api.anthropic.com/v1?x=1" })).toThrow(/URL/)
    expect(() => decode({ kind: "bedrock", base: "https://example.com" })).toThrow()
  })

  test("invalid policies are rejected with a path to the problem", () => {
    expect(() => Schema.decodeUnknownSync(Policy)({ models: { default: { mode: "some" } } })).toThrow(/mode/)
  })

  test("org MCP servers keep unknown keys so clients receive them verbatim", () => {
    const policy = Schema.decodeUnknownSync(Policy)({
      mcp: { servers: { docs: { type: "remote", url: "https://docs.example.com/mcp", oauth: false, timeout: 5000 } } },
    })
    expect(policy.mcp.servers.docs).toEqual({
      type: "remote",
      url: "https://docs.example.com/mcp",
      oauth: false,
      timeout: 5000,
    })
  })

  test("modes and usage records fill defaults", () => {
    expect(Schema.decodeUnknownSync(Mode)({ slug: "rev", name: "Rev", prompt: "p" })).toMatchObject({
      description: "",
      mode: "primary",
    })
    expect(Schema.decodeUnknownSync(UsageRecord)({ id: "x", at: 1, provider: "a", model: "b" })).toEqual({
      id: "x",
      at: 1,
      provider: "a",
      model: "b",
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      cost: 0,
    })
  })
})

describe("api", () => {
  test("produces an OpenAPI document covering every group", () => {
    const doc = OpenApi.fromApi(Api)
    const paths = Object.keys(doc.paths)
    expect(paths).toContain("/api/v1/orgs/{org}/policy/effective")
    expect(paths).toContain("/scim/v2/Users/{id}")
    expect(paths).toContain("/api/v1/auth/device/token")
    expect(paths).toContain("/api/v1/orgs/{org}/gateway/providers/{id}")
    expect(paths.length).toBeGreaterThan(40)
  })
})

describe("matching", () => {
  const policy = {
    models: { allow: ["anthropic/*", "kilo/anthropic/claude-sonnet-*"], deny: ["anthropic/claude-opus-*"] },
    mcp: { allow: ["https://mcp.acme.dev/*", "git-mcp --readonly"], deny: ["npx -y evil*"] },
  }

  test("deny beats allow; anything outside a selection is refused", () => {
    expect(allows(policy, "anthropic", "claude-sonnet-4")).toBe(true)
    expect(allows(policy, "anthropic", "claude-opus-4")).toBe(false)
    expect(allows(policy, "kilo", "anthropic/claude-sonnet-4")).toBe(true)
    expect(allows(policy, "openai", "gpt-5")).toBe(false)
    expect(allows({ models: { allow: null, deny: [] } }, "openai", "gpt-5")).toBe(true)
  })

  test("an exclusive gateway refuses every provider it does not route", () => {
    const gateway = { exclusive: true, providers: [{ id: "anthropic", kind: "anthropic" as const }] }
    expect(allows({ ...policy, gateway }, "anthropic", "claude-sonnet-4")).toBe(true)
    expect(allows({ ...policy, gateway }, "anthropic", "claude-opus-4")).toBe(false)
    expect(allows({ ...policy, gateway }, "kilo", "anthropic/claude-sonnet-4")).toBe(false)
    expect(allows({ ...policy, gateway: { ...gateway, exclusive: false } }, "kilo", "anthropic/claude-sonnet-4")).toBe(
      true,
    )
  })

  test("MCP servers match on URL or command line", () => {
    expect(target({ type: "local", command: ["git-mcp", "--readonly"] })).toBe("git-mcp --readonly")
    expect(refusal(policy, { type: "remote", url: "https://mcp.acme.dev/github" })).toBeUndefined()
    expect(refusal(policy, { type: "local", command: ["git-mcp", "--readonly"] })).toBeUndefined()
    expect(refusal(policy, { type: "local", command: ["npx", "-y", "evil-server"] })).toContain("Blocked")
    expect(refusal(policy, { type: "remote", url: "https://elsewhere.dev/mcp" })).toContain("allowlist")
  })

  test("bare providers normalize to provider wildcards", () => {
    expect(normalize("openai")).toBe("openai/*")
    expect(normalize("openrouter/*:free")).toBe("openrouter/*:free")
  })
})
