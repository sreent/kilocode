import { describe, expect, test } from "bun:test"
import path from "path"
import { KiloOauthCallbackPage } from "@opencode-ai/core/kilocode/oauth/page"

const root = path.join(__dirname, "..", "..")

describe("tucode OAuth branding", () => {
  test("Codex OAuth browser flow uses tucode branding", async () => {
    const src = await Bun.file(path.join(root, "src", "plugin", "openai", "codex.ts")).text()

    // OpenAI's Codex sign-in knows the client as "kilo"; only the pages people see say tucode.
    expect(src).toContain('originator: "kilo"')
    expect(src).toContain('"User-Agent": `kilo/${InstallationVersion}`')
    expect(src).toContain("return to ${Brand.name")
    expect(src).not.toContain('originator: "opencode"')
    expect(src).not.toContain("return to OpenCode")
  })

  test("core OAuth browser flow uses tucode branding", async () => {
    const src = await Bun.file(path.join(root, "..", "core", "src", "plugin", "provider", "openai.ts")).text()
    const pages = [
      KiloOauthCallbackPage.success({ provider: "ChatGPT" }),
      KiloOauthCallbackPage.error("Denied", { provider: "ChatGPT" }),
    ]

    expect(src).toContain('originator: "kilo"')
    expect(src).toContain('"User-Agent": `kilo/${InstallationVersion}`')
    expect(src).toContain("KiloOauthCallbackPage")
    expect(src).not.toContain('originator: "opencode"')
    for (const page of pages) {
      expect(page).toContain("· tucode</title>")
      expect(page).toContain('aria-label="tucode"')
      expect(page).toContain('viewBox="56 104 400 304"')
      expect(page).not.toContain("Kilo")
      expect(page).not.toContain("OpenCode")
      expect(page).not.toContain('viewBox="0 0 234 42"')
    }
  })

  test("MCP OAuth callback page uses tucode branding", async () => {
    const src = await Bun.file(path.join(root, "src", "mcp", "oauth-callback.ts")).text()

    expect(src).toContain("return to ${Brand.name")
    expect(src).not.toContain("return to OpenCode")
  })
})
