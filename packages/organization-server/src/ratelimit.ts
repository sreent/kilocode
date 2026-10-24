export * as RateLimit from "./ratelimit"

import { Clock, Context, Effect, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"

// Token buckets in memory: a key may make `limit` requests in a burst, and earns them back evenly
// over `window` milliseconds. Each server counts on its own, so behind a load balancer a client can
// reach the limit on every replica; the gateway's per-member limits, which must hold exactly, are
// counted in the database instead.

export type Rule = { readonly limit: number; readonly window: number }

export interface Interface {
  // Counts a request against a key. Returns how many seconds to wait when none is left, else 0.
  readonly take: (key: string, rule: Rule) => Effect.Effect<number>
  // How many seconds a key must wait, without counting a request.
  readonly wait: (key: string, rule: Rule) => Effect.Effect<number>
}

export class Service extends Context.Service<Service, Interface>()("@organization/RateLimit") {}

// Keys kept at most; the least recently seen go first. A forgotten key starts with a full bucket.
const most = 100_000

export const layer = Layer.sync(Service, () => {
  const buckets = new Map<string, { tokens: number; at: number }>()
  const level = (key: string, rule: Rule, now: number) => {
    const bucket = buckets.get(key)
    if (!bucket) return rule.limit
    return Math.min(rule.limit, bucket.tokens + ((now - bucket.at) * rule.limit) / rule.window)
  }
  // Until one request's worth has been earned back.
  const seconds = (tokens: number, rule: Rule) =>
    tokens >= 1 ? 0 : Math.max(1, Math.ceil(((1 - tokens) * rule.window) / rule.limit / 1000))

  const take: Interface["take"] = (key, rule) =>
    Effect.map(Clock.currentTimeMillis, (now) => {
      const tokens = level(key, rule, now)
      if (tokens < 1) return seconds(tokens, rule)
      buckets.delete(key)
      buckets.set(key, { tokens: tokens - 1, at: now })
      if (buckets.size > most) buckets.delete(buckets.keys().next().value!)
      return 0
    })
  const wait: Interface["wait"] = (key, rule) =>
    Effect.map(Clock.currentTimeMillis, (now) => seconds(level(key, rule, now), rule))
  return Service.of({ take, wait })
})

export const node = LayerNode.make({ service: Service, layer, deps: [] })
