import type { Context } from "hono"
import { HTTPException } from "hono/http-exception"
import type { ContentfulStatusCode } from "hono/utils/http-status"
import { z } from "zod"
import type { Org, Store, Token, User } from "./store"
import { can, type Capability, type Role } from "./roles"

export type Config = {
  // Public URL of this server; used for OIDC redirect URIs, device verification links and cookie scoping.
  base: string
  // Key material for sealing secrets at rest (ENTERPRISE_SECRET). SSO cannot be configured without it.
  secret?: string
  // Trust X-Forwarded-For for audit IPs when running behind a reverse proxy.
  proxy: boolean
  // DNS TXT lookup used for domain verification; injectable for tests.
  txt: (name: string) => Promise<string[][]>
}

export type Env = {
  Bindings: { ip?: string }
  Variables: {
    store: Store
    config: Config
    user: User
    token: Token
    cookie: boolean
    org: Org
    role: Role
    inherited: boolean
  }
}

export type Ctx = Context<Env>

export const cookie = "ent_session"

export function fail(status: ContentfulStatusCode, message: string): never {
  throw new HTTPException(status, { message })
}

export async function body<T extends z.ZodType>(c: Ctx, schema: T): Promise<z.infer<T>> {
  const raw = await c.req.json().catch(() => fail(400, "request body must be valid JSON"))
  const parsed = schema.safeParse(raw)
  if (!parsed.success) fail(400, z.prettifyError(parsed.error))
  return parsed.data
}

export function need(c: Ctx, cap: Capability) {
  if (!can(c.var.role, cap)) fail(403, `your role (${c.var.role}) cannot perform ${cap}`)
}

export function ip(c: Ctx) {
  if (c.var.config.proxy) {
    const forwarded = c.req.header("x-forwarded-for")?.split(",").at(0)?.trim()
    if (forwarded) return forwarded
  }
  return c.env?.ip ?? null
}

export function actor(c: Ctx) {
  return { id: c.var.user.id, email: c.var.user.email }
}

export function audit(c: Ctx, action: string, target?: string | null, details?: Record<string, unknown>) {
  c.var.store.audit.record({ org: c.var.org.id, action, actor: actor(c), target, details, ip: ip(c) })
}

// Accepts epoch milliseconds or anything Date can parse (ISO dates).
export function time(value: string | undefined, fallback: number) {
  if (!value) return fallback
  const parsed = /^\d+$/.test(value) ? Number(value) : Date.parse(value)
  if (Number.isNaN(parsed)) fail(400, `invalid time: ${value}`)
  return parsed
}

export function csv(rows: Record<string, unknown>[], columns: string[]) {
  const cell = (value: unknown) => {
    const text = value == null ? "" : typeof value === "string" ? value : JSON.stringify(value)
    // Neutralise spreadsheet formula injection as well as quoting separators.
    const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text
    return /[",\n\r]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe
  }
  return (
    [columns.join(","), ...rows.map((row) => columns.map((column) => cell(row[column])).join(","))].join("\n") + "\n"
  )
}

export function escape(text: string) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
}

export function page(title: string, content: string) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)}</title>
<style>
  :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: Canvas; color: CanvasText; }
  main { max-width: 420px; padding: 32px 16px; text-align: center; }
  .code { font: 600 28px ui-monospace, monospace; letter-spacing: 4px; margin: 16px 0; }
  a.button, button { display: inline-block; padding: 10px 18px; border-radius: 8px; border: 0; background: #2563eb; color: white; font: inherit; text-decoration: none; cursor: pointer; }
  input { font: 600 20px ui-monospace, monospace; padding: 8px; width: 12ch; text-align: center; text-transform: uppercase; }
  p { line-height: 1.5; }
</style>
</head>
<body><main>${content}</main></body>
</html>`
}
