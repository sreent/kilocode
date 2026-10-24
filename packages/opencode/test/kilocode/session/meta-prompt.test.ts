import { expect, test } from "bun:test"
import type { Provider } from "@/provider/provider"
import { SystemPrompt } from "@/session/system"
import { Brand } from "@/tucode/brand"

test("Muse Spark identifies as TU Code and uses TU Code's documentation", () => {
  const prompt = SystemPrompt.provider({ api: { id: "meta/muse-spark-preview" } } as Provider.Model)[0]
  expect(prompt).toContain(`You are ${Brand.name}`)
  expect(prompt).toContain("Muse Spark")
  expect(prompt).toContain(`${Brand.repository}/tree/main/packages/kilo-docs/pages`)
  expect(prompt).not.toContain("You are OpenCode")
  expect(prompt).not.toContain("identify yourself as OpenCode")
  expect(prompt).not.toContain("https://opencode.ai/docs")
  expect(prompt).not.toContain("https://kilo.ai/docs")
})
