import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { OpenApi } from "effect/unstable/httpapi"
import { Api } from "../src/api"
import {
  allows,
  dollars,
  filtering,
  normalize,
  overBudget,
  preferences,
  refusal,
  shortfall,
  target,
  withheld,
} from "../src/match"
import {
  DataTerms,
  defaultAuth,
  Effective,
  gatewayApi,
  GatewayProviderInput,
  Mode,
  Policy,
  Price,
  UsageRecord,
} from "../src/schema"

describe("schemas", () => {
  test("an empty policy decodes to the secure defaults", () => {
    expect(Schema.decodeUnknownSync(Policy)({})).toEqual({
      models: { blocked: [] },
      mcp: { mode: "open", allow: [], block: [], servers: {} },
      permission: {},
      share: "disabled",
      telemetry: { product: false },
      gateway: { exclusive: false, limits: {}, log: { bodies: false, retention: 30 } },
      data: { training: "allowed", retention: "any", regions: [], providers: {} },
    })
  })

  test("data terms default to no routing and reject unknown region codes", () => {
    const decode = Schema.decodeUnknownSync(DataTerms)
    expect(decode({ training: false, retention: 0, regions: ["eu"] })).toEqual({
      training: false,
      retention: 0,
      regions: ["eu"],
      routing: false,
    })
    expect(() => decode({ training: false, retention: 0, regions: ["EU West"] })).toThrow(/region code/)
    expect(() => decode({ training: false, retention: -1 })).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(Policy)({ data: { providers: { "Not An Id": { training: false, retention: 0 } } } }),
    ).toThrow(/provider id/)
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
    const decoded = Schema.decodeUnknownSync(Effective)(cached)
    expect(decoded.gateway).toEqual({ exclusive: false, providers: [] })
    expect(decoded.data).toEqual({
      training: "allowed",
      retention: "any",
      regions: [],
      providers: null,
      reasons: {},
      routing: [],
    })
  })

  test("gateway upstreams must be plain http(s) base URLs", () => {
    const decode = Schema.decodeUnknownSync(GatewayProviderInput)
    expect(decode({ kind: "anthropic", base: "https://api.anthropic.com/v1" })).toEqual({
      kind: "anthropic",
      base: "https://api.anthropic.com/v1",
      query: {},
      models: [],
    })
    expect(() => decode({ kind: "anthropic", base: "https://api.anthropic.com/v1?x=1" })).toThrow(/URL/)
    expect(() => decode({ kind: "azure", base: "https://example.com" })).toThrow()
  })

  test("gateway credentials and extra headers are validated", () => {
    const decode = Schema.decodeUnknownSync(GatewayProviderInput)
    const base = { kind: "bedrock", base: "https://bedrock-runtime.us-east-1.amazonaws.com" }
    expect(
      decode({ ...base, auth: { type: "aws", region: "us-gov-west-1", access_key: "AKIAIOSFODNN7EXAMPLE" } }).auth,
    ).toEqual({ type: "aws", region: "us-gov-west-1", access_key: "AKIAIOSFODNN7EXAMPLE" })
    expect(() =>
      decode({ ...base, auth: { type: "aws", region: "us east", access_key: "AKIAIOSFODNN7EXAMPLE" } }),
    ).toThrow(/region/)
    expect(() => decode({ ...base, auth: { type: "aws", region: "us-east-1", access_key: "secret" } })).toThrow(
      /access key/,
    )
    const openai = { kind: "openai-compatible", base: "https://litellm.internal/v1" }
    expect(decode({ ...openai, headers: { "x-portkey-api-key": "pk" } }).headers).toEqual({ "x-portkey-api-key": "pk" })
    // The HTTP client owns framing and the connection; letting a header override them could
    // smuggle requests.
    for (const name of ["host", "Content-Length", "transfer-encoding", "proxy-authorization"])
      expect(() => decode({ ...openai, headers: { [name]: "x" } })).toThrow(/header/)
    expect(() => decode({ ...openai, query: { "a b": "1" } })).toThrow(/query/)
  })

  test("a price sets either rates or a discount", () => {
    const decode = Schema.decodeUnknownSync(Price)
    expect(decode({ provider: "anthropic", model: "*", discount: 15 })).toEqual({
      provider: "anthropic",
      model: "*",
      discount: 15,
    })
    expect(() => decode({ provider: "anthropic", model: "*" })).toThrow(/either rates or a discount/)
    expect(() => decode({ provider: "anthropic", model: "*", discount: 15, rates: { input: 1, output: 2 } })).toThrow(
      /either rates or a discount/,
    )
    expect(() => decode({ provider: "anthropic", model: "*", discount: 120 })).toThrow()
  })

  test("Bedrock and Vertex providers speak Anthropic's API to clients", () => {
    expect(gatewayApi("bedrock")).toBe("anthropic")
    expect(gatewayApi("vertex")).toBe("anthropic")
    expect(gatewayApi("openai-compatible")).toBe("openai-compatible")
    expect(defaultAuth("anthropic")).toEqual({ type: "header", name: "x-api-key" })
    expect(defaultAuth("vertex")).toEqual({ type: "google" })
    expect(defaultAuth("openai")).toEqual({ type: "bearer" })
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

  test("a spent budget is explained without rounding small amounts away", () => {
    const limits = (amount: number, spent: number) => ({
      budget: { limits: [{ scope: "member" as const, period: "day" as const, amount, spent }] },
    })
    expect(overBudget(limits(10, 3))).toBeUndefined()
    expect(overBudget(limits(25, 25.5))).toBe(
      "Your daily personal AI budget of $25.00 has been reached ($25.50 spent). Contact your administrator.",
    )
    expect(overBudget(limits(0.005, 0.00846))).toContain("budget of $0.0050 has been reached ($0.0085 spent)")
    expect(overBudget(limits(0, 0))).toContain("budget of $0.00 has been reached ($0.00 spent)")
    expect([0.25, 0.0995, 0.00004].map(dollars)).toEqual(["$0.25", "$0.10", "<$0.0001"])
  })

  test("the data policy admits providers by their recorded terms", () => {
    const strict = { training: "denied" as const, retention: "zero" as const, regions: ["eu", "uk"] }
    const terms = (input: Partial<DataTerms> = {}): DataTerms => ({
      training: false,
      retention: 0,
      regions: ["eu"],
      routing: false,
      ...input,
    })
    expect(filtering({ training: "allowed", retention: "any", regions: [] })).toBe(false)
    expect(filtering({ training: "allowed", retention: "any", regions: ["eu"] })).toBe(true)
    expect(shortfall(strict, terms())).toBeUndefined()
    expect(shortfall(strict, terms({ training: true }))).toBe("it may train models on your data")
    expect(shortfall(strict, terms({ retention: 1 }))).toBe("it keeps data for 1 day")
    expect(shortfall(strict, terms({ retention: 30, regions: ["us", "eu"] }))).toBe(
      "it keeps data for 30 days; it processes data in us",
    )
    expect(shortfall(strict, terms({ regions: [] }))).toBe("where it processes data isn't on record")
    // Without filters nothing falls short, whatever the terms.
    expect(
      shortfall({ training: "allowed", retention: "any", regions: [] }, terms({ training: true, retention: 30 })),
    ).toBeUndefined()
  })

  test("providers outside the data policy are refused with the reason", () => {
    const data = {
      training: "denied" as const,
      retention: "zero" as const,
      regions: [],
      providers: ["anthropic", "openrouter"],
      reasons: { openai: "it keeps data for 30 days" },
      routing: ["openrouter"],
    }
    const open = { models: { allow: null, deny: [] }, data }
    expect(allows(open, "anthropic", "claude-sonnet-4")).toBe(true)
    expect(allows(open, "openai", "gpt-5")).toBe(false)
    expect(allows(open, "mistral", "codestral")).toBe(false)
    expect(withheld(open, "anthropic")).toBeUndefined()
    expect(withheld(open, "openai")).toBe(
      "Your organization's data policy doesn't allow openai: it keeps data for 30 days.",
    )
    expect(withheld(open, "mistral")).toBe(
      "Your organization's data policy doesn't allow mistral: its data terms aren't on record.",
    )
    expect(withheld({ data: { ...data, providers: null } }, "mistral")).toBeUndefined()
  })

  test("routed providers carry the data policy as OpenRouter preferences", () => {
    const data = { training: "denied" as const, retention: "zero" as const, routing: ["openrouter"] }
    expect(preferences({ data }, "openrouter")).toEqual({ data_collection: "deny", zdr: true })
    expect(preferences({ data: { ...data, retention: "any" } }, "openrouter")).toEqual({ data_collection: "deny" })
    expect(preferences({ data: { ...data, training: "allowed" } }, "openrouter")).toEqual({ zdr: true })
    expect(preferences({ data: { ...data, training: "allowed", retention: "any" } }, "openrouter")).toBeUndefined()
    expect(preferences({ data }, "anthropic")).toBeUndefined()
    expect(preferences({}, "openrouter")).toBeUndefined()
  })

  test("bare providers normalize to provider wildcards", () => {
    expect(normalize("openai")).toBe("openai/*")
    expect(normalize("openrouter/*:free")).toBe("openrouter/*:free")
  })
})
