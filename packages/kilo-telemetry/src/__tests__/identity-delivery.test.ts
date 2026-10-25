import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

// tucode sends no product analytics: whatever the telemetry settings say, the package makes no
// request, neither to PostHog nor to Kilo's profile API, and keeps no alias or profile cache.

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "tucode-telemetry-"))
})
afterEach(() => rm(dir, { recursive: true, force: true }))

async function run(env: Record<string, string>) {
  const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "fixtures/identity-process.ts")], {
    env: { ...process.env, KILO_MACHINE_ID: "", TEST_DATA: dir, ...env },
    stdout: "pipe",
    stderr: "pipe",
  })
  const output = await new Response(child.stdout).text()
  const error = await new Response(child.stderr).text()
  expect(await child.exited, error).toBe(0)
  return JSON.parse(output) as { requests: { method: string; url: string }[]; enabled: boolean }
}

test.each(["all", ""])("sends nothing with KILO_TELEMETRY_LEVEL=%p and telemetry switched on", async (level) => {
  const result = await run({ KILO_TELEMETRY_LEVEL: level })
  expect(result.requests).toEqual([])
  expect(result.enabled).toBe(false)
  expect((await readdir(dir)).filter((file) => file !== "telemetry-id")).toEqual([])
})
