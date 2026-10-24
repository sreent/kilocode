export * as Analytics from "./analytics"

import type { Interval } from "@organization/protocol/schema"

// Intervals in UTC: days, weeks starting on Monday, and months starting on the 1st.

const day = 24 * 60 * 60 * 1000

// The start of the interval a time falls in.
export function floor(interval: Interval, time: number) {
  const date = new Date(time)
  if (interval === "month") return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)
  const midnight = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
  return interval === "day" ? midnight : midnight - ((date.getUTCDay() + 6) % 7) * day
}

// The start of the interval after the one that starts at `boundary`.
export function step(interval: Interval, boundary: number) {
  if (interval === "day") return boundary + day
  if (interval === "week") return boundary + 7 * day
  const date = new Date(boundary)
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1)
}

// The starts of every interval that overlaps [from, to).
export function buckets(interval: Interval, from: number, to: number) {
  const starts: number[] = []
  for (let at = floor(interval, from); at < to; at = step(interval, at)) starts.push(at)
  return starts
}
