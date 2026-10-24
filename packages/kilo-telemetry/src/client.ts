import type { PostHog } from "posthog-node"
import { Identity } from "./identity.js"
import { TelemetryEvent } from "./events.js"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import path from "node:path"

export namespace Client {
  let client: PostHog | null = null
  let enabled = true
  let directory = ""
  const pending = new Set<string>()

  // TU Code sends no product analytics. init never creates a PostHog client, so capture, alias and
  // flush do nothing and nothing reaches PostHog, whatever the telemetry settings say.
  export function init(dir = "") {
    directory = dir
    pending.clear()
  }

  function marker(id: string, alias: string) {
    const key = createHash("sha256")
      .update(JSON.stringify([id, alias]))
      .digest("hex")
    return path.join(directory, `telemetry-alias-${key}`)
  }

  export function getClient(): PostHog | null {
    return client
  }

  export function setEnabled(value: boolean) {
    enabled = value
    if (!client) return
    if (value) client.optIn()
    else client.optOut()
  }

  export function isEnabled(): boolean {
    return enabled && client !== null
  }

  export function capture(event: TelemetryEvent, properties?: Record<string, unknown>) {
    if (!enabled || !client) return

    const distinctId = Identity.getDistinctId()
    const orgId = Identity.getOrganizationId()

    client.capture({
      distinctId,
      event,
      properties: {
        ...properties,
        ...(orgId && { kilocodeOrganizationId: orgId }),
      },
    })
  }

  export function alias(distinctId: string, aliasId: string) {
    if (!enabled || !client) return
    const file = marker(distinctId, aliasId)
    if (pending.has(file)) return
    try {
      if (directory && readFileSync(file, "utf8") === "1") return
    } catch (err) {
      if (process.env.KILO_PRINT_LOGS) console.warn("telemetry alias marker read failed; retrying link", err)
    }
    pending.add(file)

    client.alias({
      distinctId,
      alias: aliasId,
    })
  }

  export async function shutdown(timeoutMs?: number): Promise<void> {
    if (client) {
      try {
        // PostHog's shutdown drains the queue internally and is bounded by
        // shutdownTimeoutMs. Calling flush() first is redundant and unbounded:
        // when the endpoint is unreachable (offline, firewall, DNS adblock),
        // flush retries up to 3x with 3s delays plus 10s per attempt before
        // throwing, blocking process exit before shutdown's outer cap kicks in.
        await client.shutdown(timeoutMs)
      } finally {
        client = null
      }
    }
  }

  // Flush queued events in the background without blocking the caller. The
  // flush is delayed slightly so commands that exit immediately pay only the
  // single shutdown() flush instead of an in-flight flush plus a follow-up
  // flush for CLI_EXIT. For commands that outlive the delay, the upload
  // overlaps with execution, so by the time shutdown() runs the queue is
  // usually empty (or the connection is still warm) and process exit is not
  // delayed by a network round trip. The unref'd timer never keeps a process
  // alive on its own. The authoritative, error-handled flush still happens in
  // shutdown(); failures here are retried there, so they are only surfaced
  // when debug logging is on.
  export function flushInBackground(delayMs = 300): void {
    if (!enabled || !client) return
    const timer = setTimeout(() => {
      if (!client) return
      client.flush().catch((err) => {
        if (process.env.KILO_PRINT_LOGS) console.warn("telemetry background flush failed", err)
      })
    }, delayMs)
    timer.unref?.()
  }
}
