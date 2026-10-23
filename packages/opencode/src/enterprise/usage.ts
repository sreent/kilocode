import { readdir, mkdir, rm, writeFile } from "fs/promises"
import path from "path"
import z from "zod"
import { Global } from "@opencode-ai/core/global"
import * as Log from "@opencode-ai/core/util/log"
import * as Enterprise from "./enterprise"

// Per-LLM-call usage reporting to the control plane. Records are keyed by the step-finish part
// id, which the server de-duplicates, so resending after a crash or a lost response is safe.

const log = Log.create({ service: "enterprise.usage" })
const max = 5_000
const batch = 500

export const Entry = z.object({
  id: z.string(),
  at: z.number(),
  session: z.string().optional(),
  project: z.string().optional(),
  provider: z.string(),
  model: z.string(),
  tokens: z.object({
    input: z.number(),
    output: z.number(),
    reasoning: z.number(),
    cache: z.object({ read: z.number(), write: z.number() }),
  }),
  cost: z.number(),
})
export type Entry = z.infer<typeof Entry>

const queue: Entry[] = []
const state: { timer?: ReturnType<typeof setInterval>; busy?: Promise<boolean> } = {}

const spool = () => path.join(Global.Path.data, "enterprise-usage")

export function push(entry: Entry) {
  queue.push(entry)
  if (queue.length > max) {
    const dropped = queue.splice(0, queue.length - max)
    log.warn("usage queue full, dropping oldest records", { dropped: dropped.length })
  }
  if (queue.length >= 50) void flush()
}

export function pending() {
  return queue.length
}

export async function flush(): Promise<boolean> {
  if (state.busy) return state.busy
  state.busy = send().finally(() => {
    state.busy = undefined
  })
  return state.busy
}

async function send() {
  const cfg = Enterprise.settings()
  if (!cfg?.token || cfg.error) return queue.length === 0
  while (queue.length) {
    const chunk = queue.slice(0, batch)
    const res = await fetch(Enterprise.endpoint(cfg, "/usage"), {
      method: "POST",
      headers: { authorization: `Bearer ${cfg.token}`, "content-type": "application/json" },
      body: JSON.stringify({ records: chunk }),
      signal: AbortSignal.timeout(10_000),
    }).catch((err: Error) => err)
    if (res instanceof Error || !res.ok) {
      log.warn("usage upload failed", { error: res instanceof Error ? res.message : `HTTP ${res.status}` })
      return false
    }
    queue.splice(0, chunk.length)
  }
  // Budgets are enforced from the effective policy, so pull fresh spend after reporting.
  if (Enterprise.current()?.budget.limits.length)
    await Enterprise.refresh().catch((err: Error) => log.warn("policy refresh failed", { error: err.message }))
  return true
}

// Picks up records spooled by earlier processes that could not reach the control plane.
async function recover() {
  const dir = spool()
  const files = await readdir(dir).catch(() => [] as string[])
  for (const name of files) {
    const target = path.join(dir, name)
    const parsed = z.array(Entry).safeParse(
      await Bun.file(target)
        .json()
        .catch(() => null),
    )
    await rm(target, { force: true })
    if (parsed.success) queue.push(...parsed.data)
  }
}

export async function start() {
  if (state.timer) return
  await recover()
  state.timer = setInterval(() => void flush(), 15_000)
  state.timer.unref?.()
}

export async function stop() {
  if (state.timer) clearInterval(state.timer)
  state.timer = undefined
  const sent = await Promise.race([flush(), Bun.sleep(3_000).then(() => false)])
  if (sent || queue.length === 0) return
  await mkdir(spool(), { recursive: true })
  await writeFile(path.join(spool(), `${process.pid}-${Date.now()}.json`), JSON.stringify(queue.splice(0)), {
    mode: 0o600,
  })
}
