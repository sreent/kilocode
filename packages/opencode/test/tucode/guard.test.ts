// kilocode_change - new file (tucode)
import { describe, expect, test } from "bun:test"
import { blocked } from "../../src/tucode/guard"

describe("TU Code network guard", () => {
  test("names Kilo's service hosts and nothing else", () => {
    expect(blocked("https://api.kilo.ai/api/profile")).toBe("api.kilo.ai")
    expect(blocked("https://ai-gateway.kilo.ai/api/v1/models")).toBe("ai-gateway.kilo.ai")
    expect(blocked("https://KILO.AI./docs")).toBe("kilo.ai")
    expect(blocked(new URL("wss://events.kiloapps.io/socket"))).toBe("events.kiloapps.io")
    expect(blocked(new Request("https://ingest.kilosessions.ai/sessions"))).toBe("ingest.kilosessions.ai")
    expect(blocked("https://kilocode.ai")).toBe("kilocode.ai")

    expect(blocked("http://kilo.internal/session")).toBeUndefined()
    expect(blocked("https://notkilo.ai")).toBeUndefined()
    expect(blocked("https://kilo.ai.example.com")).toBeUndefined()
    expect(blocked("https://ai.example.com/api/v1")).toBeUndefined()
    expect(blocked("/relative")).toBeUndefined()
  })

  test("refuses fetch and WebSocket connections to Kilo's services before they open", async () => {
    const error = await fetch("https://api.kilo.ai/api/profile").catch((err: unknown) => err)
    expect(error).toBeInstanceOf(TypeError)
    expect(String(error)).toContain("TU Code does not connect to Kilo's services (api.kilo.ai)")
    expect(() => new WebSocket("wss://events.kiloapps.io")).toThrow("events.kiloapps.io")
  })

  test("lets every other request through", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response("ok") })
    try {
      expect(await fetch(server.url).then((response) => response.text())).toBe("ok")
    } finally {
      await server.stop(true)
    }
  })
})
