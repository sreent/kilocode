import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Policy as PolicySchema } from "@enterprise/protocol/schema"
import { resolve } from "../src/policy"

const Policy = { parse: Schema.decodeUnknownSync(PolicySchema) }

const base = (input: Partial<Parameters<typeof resolve>[0]> = {}) =>
  resolve({ policy: Policy.parse({}), version: 1, groups: [], modes: [], budgets: [], ...input })

describe("model access resolution", () => {
  test("absence of configuration never restricts", () => {
    expect(base().models).toEqual({ allow: null, deny: [] })
  })

  test("org ceiling normalizes bare providers to provider wildcards", () => {
    const policy = Policy.parse({ models: { blocked: ["openai", "anthropic/claude-opus-*"] } })
    expect(base({ policy }).models.deny).toEqual(["openai/*", "anthropic/claude-opus-*"])
  })

  test("default policy and group grants are unioned", () => {
    const policy = Policy.parse({ models: { default: { mode: "selected", items: ["anthropic"] } } })
    const result = base({
      policy,
      groups: [{ name: "research", models: { mode: "selected", items: ["openai/gpt-5"] } }],
    })
    expect(result.models.allow).toEqual(["anthropic/*", "openai/gpt-5"])
    expect(result.groups).toEqual(["research"])
  })

  test("any grant of all lifts the selection but not the ceiling", () => {
    const policy = Policy.parse({
      models: { blocked: ["openai"], default: { mode: "selected", items: ["anthropic"] } },
    })
    const result = base({ policy, groups: [{ name: "power", models: { mode: "all", items: [] } }] })
    expect(result.models).toEqual({ allow: null, deny: ["openai/*"] })
  })

  test("explicit none takes access away", () => {
    const policy = Policy.parse({ models: { default: { mode: "none", items: [] } } })
    expect(base({ policy }).models.allow).toEqual([])
  })

  test("groups without a model policy don't contribute grants", () => {
    const policy = Policy.parse({ models: { default: { mode: "none", items: [] } } })
    const result = base({ policy, groups: [{ name: "plain", models: null }] })
    expect(result.models.allow).toEqual([])
  })
})

describe("mcp resolution", () => {
  test("open mode allows anything not blocked", () => {
    const policy = Policy.parse({ mcp: { block: ["npx -y evil-*"] } })
    expect(base({ policy }).mcp.allow).toBeNull()
    expect(base({ policy }).mcp.deny).toEqual(["npx -y evil-*"])
  })

  test("allowlist mode always admits org-provided servers", () => {
    const policy = Policy.parse({
      mcp: {
        mode: "allowlist",
        allow: ["https://mcp.internal.example.com/*"],
        servers: {
          docs: { type: "remote", url: "https://docs.example.com/mcp" },
          git: { type: "local", command: ["git-mcp", "--readonly"] },
        },
      },
    })
    expect(base({ policy }).mcp.allow).toEqual([
      "https://mcp.internal.example.com/*",
      "https://docs.example.com/mcp",
      "git-mcp --readonly",
    ])
  })
})

describe("modes and budgets", () => {
  test("org modes become agent configs keyed by slug", () => {
    const result = base({
      modes: [
        {
          slug: "reviewer",
          name: "Reviewer",
          description: "",
          prompt: "Review code carefully.",
          mode: "subagent",
          permission: { edit: "deny" },
        },
      ],
    })
    expect(result.agents).toEqual({
      reviewer: {
        description: "Reviewer",
        prompt: "Review code carefully.",
        mode: "subagent",
        permission: { edit: "deny" },
      },
    })
  })

  test("a budget at or over its amount is exceeded", () => {
    const under = base({ budgets: [{ scope: "member", period: "day", amount: 10, spent: 9.99 }] })
    const over = base({ budgets: [{ scope: "member", period: "day", amount: 10, spent: 10 }] })
    expect(under.budget.exceeded).toBe(false)
    expect(over.budget.exceeded).toBe(true)
  })

  test("product telemetry is off unless an org turns it on", () => {
    expect(base().telemetry.product).toBe(false)
  })
})

describe("secure defaults", () => {
  test("sharing and vendor session sync are off unless an org opts in", () => {
    expect(base().share).toBe("disabled")
  })
})
