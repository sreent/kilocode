import { describe, expect, test } from "bun:test"
import path from "path"
import { KiloOauthCallbackPage } from "@opencode-ai/core/kilocode/oauth/page"

const root = path.join(__dirname, "..", "..")

describe("TU Code OAuth branding", () => {
  test("Codex OAuth browser flow uses TU Code branding", async () => {
    const src = await Bun.file(path.join(root, "src", "plugin", "openai", "codex.ts")).text()

    // OpenAI's Codex sign-in knows the client as "kilo"; only the pages people see say TU Code.
    expect(src).toContain('originator: "kilo"')
    expect(src).toContain('"User-Agent": `kilo/${InstallationVersion}`')
    expect(src).toContain("return to ${Brand.name")
    expect(src).not.toContain('originator: "opencode"')
    expect(src).not.toContain("return to OpenCode")
  })

  test("core OAuth browser flow uses TU Code branding", async () => {
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
      expect(page).toContain("· TU Code</title>")
      expect(page).toContain('aria-label="TU Code"')
      expect(page).toContain('viewBox="56 104 400 304"')
      expect(page).not.toContain("Kilo")
      expect(page).not.toContain("OpenCode")
      expect(page).not.toContain('viewBox="0 0 234 42"')
    }
  })

  test("MCP OAuth callback page uses TU Code branding", async () => {
    const src = await Bun.file(path.join(root, "src", "mcp", "oauth-callback.ts")).text()

    expect(src).toContain("return to ${Brand.name")
    expect(src).not.toContain("return to OpenCode")
  })
})
