export * as Observability from "./observability"

import { Config, Effect, Layer, Logger, type LogLevel, Option, References } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { OtlpLogger, OtlpSerialization, OtlpTracer } from "effect/unstable/observability"
import { version } from "../package.json"

// Same building blocks as the CLI's observability (core's Logging and Otlp), shaped for a server:
// logfmt on stdout for the container platform, plus logs and traces over OTLP when
// OTEL_EXPORTER_OTLP_ENDPOINT is set.

const levels = {
  debug: "Debug",
  info: "Info",
  warn: "Warn",
  error: "Error",
} as const satisfies Record<string, LogLevel.LogLevel>

function headers(value: string | undefined) {
  if (!value) return undefined
  return Object.fromEntries(
    value.split(",").map((entry) => {
      const [key, ...rest] = entry.split("=")
      return [key.trim(), rest.join("=").trim()]
    }),
  )
}

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const env = yield* Config.all({
      level: Config.literals(Object.keys(levels) as (keyof typeof levels)[], "ENTERPRISE_LOG_LEVEL").pipe(
        Config.withDefault("info" as const),
      ),
      endpoint: Config.string("OTEL_EXPORTER_OTLP_ENDPOINT").pipe(Config.option),
      headers: Config.string("OTEL_EXPORTER_OTLP_HEADERS").pipe(Config.option),
    }).pipe(Effect.orDie)
    const level = Layer.succeed(References.MinimumLogLevel, levels[env.level])
    if (Option.isNone(env.endpoint)) return Layer.merge(Logger.layer([Logger.consoleLogFmt]), level)

    const otlp = {
      resource: { serviceName: "enterprise-server", serviceVersion: version },
      headers: headers(Option.getOrUndefined(env.headers)),
    }
    const base = env.endpoint.value.replace(/\/$/, "")
    return Layer.mergeAll(
      Logger.layer([Logger.consoleLogFmt, OtlpLogger.make({ url: `${base}/v1/logs`, ...otlp })]),
      OtlpTracer.layer({ url: `${base}/v1/traces`, ...otlp }),
      level,
    ).pipe(Layer.provide(OtlpSerialization.layerJson), Layer.provide(FetchHttpClient.layer))
  }),
)
