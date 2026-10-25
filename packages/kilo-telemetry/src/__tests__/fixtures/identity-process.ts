// Records every request the telemetry package makes. tucode sends none, so the list must stay empty.
const requests: { method: string; url: string }[] = []
globalThis.fetch = Object.assign(
  async (url: string | URL | Request, options?: RequestInit) => {
    const request = url instanceof Request ? url : new Request(url, options)
    requests.push({ method: request.method, url: request.url })
    return new Response("{}", { status: 200 })
  },
  { preconnect() {} },
)

const { Telemetry } = await import("../../telemetry")
const { Client } = await import("../../client")

await Telemetry.init({
  dataPath: process.env.TEST_DATA!,
  version: "1.0.0",
  enabled: true,
})
Telemetry.trackCliStart()
await Telemetry.updateIdentity("test-token", "org-test")
Telemetry.trackAuthSuccess("kilo")
Telemetry.trackSessionStart("session-test", "model-test", "provider-test")
Telemetry.trackCliExit()
Telemetry.flushInBackground()
await Bun.sleep(400)
await Client.shutdown()
console.log(JSON.stringify({ requests, enabled: Telemetry.isEnabled() }))
process.exit(0)
