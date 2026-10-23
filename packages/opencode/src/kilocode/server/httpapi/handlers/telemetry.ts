import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Telemetry } from "@kilocode/kilo-telemetry"
import { InstanceHttpApi } from "@/server/routes/instance/httpapi/api"
import { TelemetryCapturePayload, TelemetrySetEnabledPayload } from "../groups/telemetry"
import { Enterprise } from "@/enterprise/enterprise" // kilocode_change - enterprise

export const telemetryHandlers = HttpApiBuilder.group(InstanceHttpApi, "telemetry", (handlers) =>
  Effect.gen(function* () {
    const enterprise = yield* Enterprise.Service // kilocode_change - enterprise
    const capture = Effect.fn("TelemetryHttpApi.capture")(function* (ctx: {
      payload: typeof TelemetryCapturePayload.Type
    }) {
      // fire-and-forget: log instead of swallowing
      yield* Effect.sync(() =>
        Telemetry.track(ctx.payload.event as any, ctx.payload.properties as Record<string, unknown> | undefined),
      ).pipe(Effect.catchCause((cause) => Effect.logWarning("telemetry.capture failed", cause)))
      return true
    })

    const setEnabled = Effect.fn("TelemetryHttpApi.setEnabled")(function* (ctx: {
      payload: typeof TelemetrySetEnabledPayload.Type
    }) {
      const allowed = yield* enterprise.telemetry() // kilocode_change - enterprise
      yield* Effect.sync(() => Telemetry.setEnabled(ctx.payload.enabled && allowed)) // kilocode_change - enterprise
      return true
    })

    return handlers.handle("capture", capture).handle("setEnabled", setEnabled)
  }),
)
