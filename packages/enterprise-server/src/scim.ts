import { Hono } from "hono"
import { createMiddleware } from "hono/factory"
import { HTTPException } from "hono/http-exception"
import type { ContentfulStatusCode } from "hono/utils/http-status"
import { z } from "zod"
import { ip, type Ctx, type Env } from "./context"
import type { Group, User } from "./store"

// SCIM 2.0 (RFC 7643 / RFC 7644) for IdP-driven provisioning (Okta, Entra ID, OneLogin, ...).
// The bearer token decides the org, so one base URL serves every org on the server.

const urn = {
  user: "urn:ietf:params:scim:schemas:core:2.0:User",
  group: "urn:ietf:params:scim:schemas:core:2.0:Group",
  list: "urn:ietf:params:scim:api:messages:2.0:ListResponse",
  patch: "urn:ietf:params:scim:api:messages:2.0:PatchOp",
  error: "urn:ietf:params:scim:api:messages:2.0:Error",
}

function problem(status: ContentfulStatusCode, detail: string, type?: string): never {
  const payload = { schemas: [urn.error], status: String(status), detail, ...(type ? { scimType: type } : {}) }
  throw new HTTPException(status, {
    message: detail,
    res: new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/scim+json" } }),
  })
}

function send(c: Ctx, data: unknown, status: ContentfulStatusCode = 200) {
  return c.body(JSON.stringify(data), status, { "content-type": "application/scim+json" })
}

async function read<T extends z.ZodType>(c: Ctx, schema: T): Promise<z.infer<T>> {
  const raw = await c.req.json().catch(() => problem(400, "request body must be valid JSON", "invalidSyntax"))
  const parsed = schema.safeParse(raw)
  if (!parsed.success) problem(400, z.prettifyError(parsed.error), "invalidValue")
  return parsed.data
}

// Entra ID sends booleans as "True"/"False" strings.
function bool(value: unknown) {
  if (typeof value === "string") return value.toLowerCase() === "true"
  return value === true
}

// Supports the `attr eq "value"` filters IdPs use to look up existing resources.
function filter(text: string | undefined) {
  if (!text) return undefined
  const match = text.trim().match(/^([\w.$]+(?:\[[^\]]*\])?(?:\.\w+)?)\s+eq\s+"((?:[^"\\]|\\.)*)"$/i)
  if (!match) problem(400, `unsupported filter: ${text}`, "invalidFilter")
  return { attr: match[1].toLowerCase(), value: match[2].replaceAll('\\"', '"') }
}

function page<T>(c: Ctx, rows: T[]) {
  const start = Math.max(Number(c.req.query("startIndex") ?? 1) || 1, 1)
  const count = Math.min(Math.max(Number(c.req.query("count") ?? 100) || 0, 0), 500)
  const slice = rows.slice(start - 1, start - 1 + count)
  return {
    schemas: [urn.list],
    totalResults: rows.length,
    startIndex: start,
    itemsPerPage: slice.length,
    Resources: slice,
  }
}

const Email = z.looseObject({ value: z.string(), primary: z.unknown().optional(), type: z.string().optional() })
const Name = z.looseObject({
  formatted: z.string().optional(),
  givenName: z.string().optional(),
  familyName: z.string().optional(),
})
const UserInput = z.looseObject({
  userName: z.string().min(1),
  externalId: z.string().optional(),
  displayName: z.string().optional(),
  name: Name.optional(),
  emails: z.array(Email).optional(),
  active: z.unknown().optional(),
})
const Member = z.looseObject({ value: z.string() })
const GroupInput = z.looseObject({
  displayName: z.string().min(1).max(200),
  externalId: z.string().optional(),
  members: z.array(Member).optional(),
})
const Partial = z.record(z.string(), z.unknown())
const Patch = z.looseObject({
  Operations: z
    .array(z.looseObject({ op: z.string(), path: z.string().optional(), value: z.unknown().optional() }))
    .min(1),
})

function fullname(name: z.infer<typeof Name> | undefined, display: string | undefined) {
  if (display) return display
  if (name?.formatted) return name.formatted
  const joined = [name?.givenName, name?.familyName].filter(Boolean).join(" ")
  return joined || undefined
}

function address(input: { userName?: string; emails?: z.infer<typeof Email>[] }) {
  const primary = input.emails?.find((email) => bool(email.primary)) ?? input.emails?.at(0)
  const value = input.userName?.includes("@") ? input.userName : primary?.value
  if (!value || !value.includes("@"))
    problem(400, "userName or a primary email must be an email address", "invalidValue")
  return value.trim().toLowerCase()
}

export const scim = new Hono<Env>()

scim.onError((err, c) => {
  if (err instanceof HTTPException) return err.getResponse()
  console.error("scim error", err)
  return send(c, { schemas: [urn.error], status: "500", detail: "internal error" }, 500)
})

scim.use(
  "*",
  createMiddleware<Env>(async (c, next) => {
    const value = c.req
      .header("authorization")
      ?.match(/^Bearer\s+(.+)$/i)
      ?.at(1)
    const token = value ? c.var.store.token.verify(value) : undefined
    if (!token || token.kind !== "scim") problem(401, "invalid SCIM bearer token")
    c.set("token", token)
    c.set("org", c.var.store.org.get(token.org)!)
    await next()
  }),
)

function record(c: Ctx, action: string, target: string, details?: Record<string, unknown>) {
  c.var.store.audit.record({
    org: c.var.org.id,
    action,
    actor: { id: null, email: `scim:${c.var.token.name}` },
    target,
    details,
    ip: ip(c),
  })
}

function user(c: Ctx, row: User) {
  const store = c.var.store
  const membership = store.member.get(c.var.org.id, row.id)
  return {
    schemas: [urn.user],
    id: row.id,
    externalId: row.external ?? undefined,
    userName: row.email,
    displayName: row.name ?? undefined,
    name: row.name ? { formatted: row.name } : undefined,
    emails: [{ value: row.email, primary: true, type: "work" }],
    active: row.active === 1 && membership != null && membership.suspended == null,
    groups: store.group.of(c.var.org.id, row.id).map((group) => ({ value: group.id, display: group.name })),
    meta: {
      resourceType: "User",
      created: new Date(row.created).toISOString(),
      location: `${c.var.config.base}/scim/v2/Users/${row.id}`,
    },
  }
}

function group(c: Ctx, row: Group, members = true) {
  return {
    schemas: [urn.group],
    id: row.id,
    displayName: row.name,
    externalId: row.external ?? undefined,
    members: members
      ? c.var.store.group.members(row.id).map((member) => ({
          value: member.id,
          display: member.email,
          $ref: `${c.var.config.base}/scim/v2/Users/${member.id}`,
        }))
      : undefined,
    meta: {
      resourceType: "Group",
      created: new Date(row.created).toISOString(),
      location: `${c.var.config.base}/scim/v2/Groups/${row.id}`,
    },
  }
}

// Users are scoped to the org: only people with a membership (active or suspended) are visible.
function member(c: Ctx, id: string) {
  const store = c.var.store
  const row = store.user.get(id)
  if (!row || !store.member.get(c.var.org.id, row.id)) problem(404, `user ${id} not found`)
  return row
}

// Applies identity fields only when no org outside this one depends on the account.
function identity(c: Ctx, row: User, input: { email?: string; name?: string; external?: string }) {
  const store = c.var.store
  if (store.member.foreign(row.id, c.var.org.id) > 0) return row
  if (input.email && input.email !== row.email) {
    const clash = store.user.find(input.email)
    if (clash && clash.id !== row.id) problem(409, `userName ${input.email} is already in use`, "uniqueness")
  }
  return store.user.update(row.id, { email: input.email, name: input.name, external: input.external })
}

function activate(c: Ctx, row: User, active: boolean) {
  const store = c.var.store
  const current = store.member.get(c.var.org.id, row.id)
  if (!current || (current.suspended == null) === active) return
  store.member.suspend(c.var.org.id, row.id, !active)
  record(c, active ? "scim.user_activate" : "scim.user_deactivate", row.id, { email: row.email })
}

scim.get("/ServiceProviderConfig", (c) =>
  send(c, {
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig"],
    patch: { supported: true },
    bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
    filter: { supported: true, maxResults: 500 },
    changePassword: { supported: false },
    sort: { supported: false },
    etag: { supported: false },
    authenticationSchemes: [
      { type: "oauthbearertoken", name: "OAuth Bearer Token", description: "Org-scoped SCIM token", primary: true },
    ],
  }),
)

scim.get("/ResourceTypes", (c) =>
  send(c, {
    schemas: [urn.list],
    totalResults: 2,
    Resources: [
      {
        schemas: ["urn:ietf:params:scim:schemas:core:2.0:ResourceType"],
        id: "User",
        name: "User",
        endpoint: "/Users",
        schema: urn.user,
      },
      {
        schemas: ["urn:ietf:params:scim:schemas:core:2.0:ResourceType"],
        id: "Group",
        name: "Group",
        endpoint: "/Groups",
        schema: urn.group,
      },
    ],
  }),
)

scim.get("/Schemas", (c) =>
  send(c, {
    schemas: [urn.list],
    totalResults: 2,
    Resources: [
      { id: urn.user, name: "User", description: "User account" },
      { id: urn.group, name: "Group", description: "Group of users" },
    ],
  }),
)

scim.get("/Users", (c) => {
  const store = c.var.store
  const query = filter(c.req.query("filter"))
  const rows = store.member.list(c.var.org.id).filter((row) => {
    if (!query) return true
    if (query.attr === "username" || query.attr.startsWith("emails")) return row.email === query.value.toLowerCase()
    if (query.attr === "externalid") return row.external === query.value
    if (query.attr === "id") return row.id === query.value
    return problem(400, `unsupported filter attribute: ${query.attr}`, "invalidFilter")
  })
  return send(
    c,
    page(
      c,
      rows.map((row) => user(c, row)),
    ),
  )
})

scim.get("/Users/:id", (c) => send(c, user(c, member(c, c.req.param("id")))))

scim.post("/Users", async (c) => {
  const input = await read(c, UserInput)
  const store = c.var.store
  const email = address(input)
  const existing = store.user.find(email)
  if (existing && store.member.get(c.var.org.id, existing.id))
    problem(409, `userName ${email} is already provisioned`, "uniqueness")
  const name = fullname(input.name, input.displayName)
  const row = existing
    ? identity(c, existing, { name, external: input.externalId })
    : store.user.ensure({ email, name, external: input.externalId })
  if (!row.active) store.user.update(row.id, { active: true })
  store.member.add(c.var.org.id, row.id, "member")
  if (input.active !== undefined && !bool(input.active)) store.member.suspend(c.var.org.id, row.id, true)
  record(c, "scim.user_create", row.id, { email })
  return send(c, user(c, store.user.get(row.id)!), 201)
})

scim.put("/Users/:id", async (c) => {
  const row = member(c, c.req.param("id"))
  const input = await read(c, UserInput)
  const next = identity(c, row, {
    email: address(input),
    name: fullname(input.name, input.displayName),
    external: input.externalId,
  })
  if (input.active !== undefined) activate(c, next, bool(input.active))
  record(c, "scim.user_update", row.id, { email: next.email })
  return send(c, user(c, c.var.store.user.get(row.id)!))
})

scim.patch("/Users/:id", async (c) => {
  const row = member(c, c.req.param("id"))
  const input = await read(c, Patch)
  const changes: {
    email?: string
    name?: string
    given?: string
    family?: string
    external?: string
    active?: boolean
  } = {}
  for (const op of input.Operations) {
    if (op.op.toLowerCase() === "remove") continue
    // Without a path the value is a partial resource; with one it's a single attribute.
    const updates = op.path ? { [op.path]: op.value } : (Partial.safeParse(op.value).data ?? {})
    for (const [path, value] of Object.entries(updates)) {
      const key = path.toLowerCase()
      if (key === "active") changes.active = bool(value)
      if (key === "username" && typeof value === "string") changes.email = value
      if (key.startsWith("emails")) {
        const list = z.array(Email).safeParse(Array.isArray(value) ? value : [{ value, primary: true }]).data ?? []
        const primary = list.find((email) => bool(email.primary)) ?? list.at(0)
        if (primary?.value.includes("@") && !changes.email) changes.email = primary.value
      }
      if ((key === "displayname" || key === "name.formatted") && typeof value === "string") changes.name = value
      if (key === "name.givenname" && typeof value === "string") changes.given = value
      if (key === "name.familyname" && typeof value === "string") changes.family = value
      if (key === "name") {
        const parsed = Name.safeParse(value).data
        if (parsed) changes.name = fullname(parsed, undefined)
      }
      if (key === "externalid" && typeof value === "string") changes.external = value
    }
  }
  const name = changes.name ?? ([changes.given, changes.family].filter(Boolean).join(" ") || undefined)
  const next = identity(c, row, { email: changes.email?.trim().toLowerCase(), name, external: changes.external })
  if (changes.active !== undefined) activate(c, next, changes.active)
  record(c, "scim.user_update", row.id, { email: next.email, active: changes.active })
  return send(c, user(c, c.var.store.user.get(row.id)!))
})

scim.delete("/Users/:id", (c) => {
  const store = c.var.store
  const row = member(c, c.req.param("id"))
  store.member.remove(c.var.org.id, row.id)
  // Fully deprovisioned once no org holds a membership: deactivating also revokes every token.
  if (store.member.count(row.id) === 0) store.user.update(row.id, { active: false })
  record(c, "scim.user_delete", row.id, { email: row.email })
  return c.body(null, 204)
})

function owned(c: Ctx, id: string) {
  return c.var.store.group.get(c.var.org.id, id) ?? problem(404, `group ${id} not found`)
}

function members(c: Ctx, id: string, values: { value: string }[]) {
  for (const entry of values)
    if (!c.var.store.group.join(c.var.org.id, id, entry.value))
      problem(400, `user ${entry.value} is not provisioned`, "invalidValue")
}

scim.get("/Groups", (c) => {
  const store = c.var.store
  const query = filter(c.req.query("filter"))
  const excluded = (c.req.query("excludedAttributes") ?? "").toLowerCase().split(",").includes("members")
  const rows = store.group.list(c.var.org.id).filter((row) => {
    if (!query) return true
    if (query.attr === "displayname") return row.name === query.value
    if (query.attr === "externalid") return row.external === query.value
    if (query.attr === "id") return row.id === query.value
    return problem(400, `unsupported filter attribute: ${query.attr}`, "invalidFilter")
  })
  return send(
    c,
    page(
      c,
      rows.map((row) => group(c, row, !excluded)),
    ),
  )
})

scim.get("/Groups/:id", (c) => {
  const excluded = (c.req.query("excludedAttributes") ?? "").toLowerCase().split(",").includes("members")
  return send(c, group(c, owned(c, c.req.param("id")), !excluded))
})

scim.post("/Groups", async (c) => {
  const input = await read(c, GroupInput)
  const store = c.var.store
  if (store.group.list(c.var.org.id).some((row) => row.name === input.displayName))
    problem(409, `group ${input.displayName} already exists`, "uniqueness")
  const row = store.group.create(c.var.org.id, { name: input.displayName, external: input.externalId })
  members(c, row.id, input.members ?? [])
  record(c, "scim.group_create", row.id, { name: row.name })
  return send(c, group(c, row), 201)
})

scim.put("/Groups/:id", async (c) => {
  const row = owned(c, c.req.param("id"))
  const input = await read(c, GroupInput)
  const store = c.var.store
  store.group.update(c.var.org.id, row.id, { name: input.displayName, external: input.externalId })
  store.group.assign(c.var.org.id, row.id, [])
  members(c, row.id, input.members ?? [])
  record(c, "scim.group_update", row.id, { name: input.displayName })
  return send(c, group(c, store.group.get(c.var.org.id, row.id)!))
})

scim.patch("/Groups/:id", async (c) => {
  const row = owned(c, c.req.param("id"))
  const input = await read(c, Patch)
  const store = c.var.store
  for (const op of input.Operations) {
    const kind = op.op.toLowerCase()
    const path = op.path?.toLowerCase()
    const list = z.array(Member).safeParse(op.value).data ?? []
    if (path?.startsWith("members[") && kind === "remove") {
      const id = op.path!.match(/value\s+eq\s+"([^"]+)"/i)?.at(1)
      if (id) store.group.leave(row.id, id)
      continue
    }
    if (path === "members") {
      if (kind === "add") members(c, row.id, list)
      if (kind === "remove" && list.length) for (const entry of list) store.group.leave(row.id, entry.value)
      if (kind === "remove" && !list.length) store.group.assign(c.var.org.id, row.id, [])
      if (kind === "replace") {
        store.group.assign(c.var.org.id, row.id, [])
        members(c, row.id, list)
      }
      continue
    }
    if (path === "displayname" && typeof op.value === "string")
      store.group.update(c.var.org.id, row.id, { name: op.value })
    if (path === "externalid" && typeof op.value === "string")
      store.group.update(c.var.org.id, row.id, { external: op.value })
    const value = path ? undefined : Partial.safeParse(op.value).data
    if (value) {
      if (typeof value.displayName === "string") store.group.update(c.var.org.id, row.id, { name: value.displayName })
      if (typeof value.externalId === "string") store.group.update(c.var.org.id, row.id, { external: value.externalId })
      const entries = z.array(Member).safeParse(value.members).data
      if (entries && kind === "replace") store.group.assign(c.var.org.id, row.id, [])
      if (entries) members(c, row.id, entries)
    }
  }
  record(c, "scim.group_update", row.id, { operations: input.Operations.length })
  return send(c, group(c, store.group.get(c.var.org.id, row.id)!))
})

scim.delete("/Groups/:id", (c) => {
  const row = owned(c, c.req.param("id"))
  c.var.store.group.remove(c.var.org.id, row.id)
  record(c, "scim.group_delete", row.id, { name: row.name })
  return c.body(null, 204)
})
