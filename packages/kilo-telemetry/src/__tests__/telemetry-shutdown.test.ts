import { describe, test, expect } from "bun:test"
import { Client } from "../client.js"
import { Telemetry } from "../telemetry.js"

describe("Telemetry.shutdown", () => {
  test("returns at once, since tucode never creates a PostHog client", async () => {
    Client.init()
    expect(Client.getClient()).toBeNull()
    Client.setEnabled(true)
    expect(Client.isEnabled()).toBe(false)
    await Telemetry.shutdown(50)
    expect(Client.getClient()).toBeNull()
  })
})
