import { Hono } from "hono"
import type { Env } from "./context"

// Admin console: a dependency-free single page served by the control plane. All data comes from
// the same /api/v1 endpoints as every other client, so the server remains the only authority.

const csp = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join("; ")

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Enterprise Admin</title>
<style>
  :root { color-scheme: light dark; --bg: #f7f7f8; --panel: #fff; --text: #1a1a1e; --muted: #6b6b76; --line: #e3e3e8; --accent: #2563eb; --danger: #c62828; --ok: #2e7d32; }
  @media (prefers-color-scheme: dark) { :root { --bg: #111114; --panel: #1b1b20; --text: #ececf1; --muted: #9a9aa6; --line: #2c2c34; --accent: #60a5fa; --danger: #ef5350; --ok: #66bb6a; } }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.5 system-ui, sans-serif; background: var(--bg); color: var(--text); }
  header { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; padding: 12px 16px; border-bottom: 1px solid var(--line); background: var(--panel); }
  header h1 { font-size: 16px; margin: 0 auto 0 0; }
  nav { display: flex; gap: 4px; flex-wrap: wrap; padding: 8px 16px; border-bottom: 1px solid var(--line); background: var(--panel); }
  nav button { background: none; color: var(--text); border: 0; padding: 6px 10px; border-radius: 6px; }
  nav button.active { background: var(--accent); color: white; }
  main { max-width: 1100px; margin: 0 auto; padding: 16px; }
  section { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 16px; margin-bottom: 16px; overflow-x: auto; }
  h2 { font-size: 15px; margin: 0 0 12px; }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
  th { color: var(--muted); font-weight: 600; font-size: 12px; text-transform: uppercase; letter-spacing: .03em; }
  input, select, textarea { font: inherit; color: inherit; background: var(--bg); border: 1px solid var(--line); border-radius: 6px; padding: 6px 8px; }
  textarea { width: 100%; min-height: 220px; font-family: ui-monospace, monospace; font-size: 13px; }
  button { font: inherit; cursor: pointer; border-radius: 6px; border: 1px solid var(--line); background: var(--panel); color: var(--text); padding: 6px 12px; }
  button.primary { background: var(--accent); border-color: var(--accent); color: white; }
  button.danger { color: var(--danger); }
  form, .row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin: 8px 0; }
  .muted { color: var(--muted); }
  .error { color: var(--danger); white-space: pre-wrap; }
  .ok { color: var(--ok); }
  .secret { font-family: ui-monospace, monospace; word-break: break-all; background: var(--bg); border: 1px dashed var(--line); padding: 8px; border-radius: 6px; }
  .badge { font-size: 12px; padding: 2px 8px; border-radius: 999px; border: 1px solid var(--line); }
  code { font-family: ui-monospace, monospace; font-size: 12px; }
  code.wrap { white-space: pre-wrap; word-break: break-word; }
  .center { max-width: 420px; margin: 10vh auto; }
</style>
</head>
<body>
<div id="app"><main class="muted">Loading…</main></div>
<script src="/admin/app.js" defer></script>
</body>
</html>`

const script = String.raw`"use strict"
const state = { token: sessionStorage.getItem("ent_token"), me: null, org: null, role: null, tab: "overview" }

// Mirrors src/roles.ts so the UI only offers what the server will accept.
const caps = {
  "member.read": ["owner", "admin", "billing_manager"], "member.write": ["owner", "admin"],
  "group.read": ["owner", "admin", "billing_manager"], "group.write": ["owner"],
  "policy.read": ["owner", "admin", "billing_manager"], "policy.write": ["owner"],
  "mode.write": ["owner", "admin"], "audit.read": ["owner", "admin"], "usage.read": ["owner", "admin", "billing_manager"],
  "budget.write": ["owner", "billing_manager"], "sso.write": ["owner", "admin"], "suborg.read": ["owner", "admin", "billing_manager"],
}
const can = (cap) => (caps[cap] || []).includes(state.role)

function h(tag, attrs, ...children) {
  const el = document.createElement(tag)
  for (const [key, value] of Object.entries(attrs || {})) {
    if (key.startsWith("on")) el.addEventListener(key.slice(2), value)
    else if (key === "class") el.className = value
    else if (key === "value") el.value = value
    else if (value === true) el.setAttribute(key, "")
    else if (value !== false && value != null) el.setAttribute(key, value)
  }
  for (const child of children.flat()) if (child != null && child !== false) el.append(child instanceof Node ? child : String(child))
  return el
}

async function api(method, path, body) {
  const headers = {}
  if (body !== undefined) headers["content-type"] = "application/json"
  if (state.token) headers.authorization = "Bearer " + state.token
  const res = await fetch(path, { method, headers, credentials: "same-origin", body: body === undefined ? undefined : JSON.stringify(body) })
  if (res.status === 204) return null
  const type = res.headers.get("content-type") || ""
  const data = type.includes("json") ? await res.json() : await res.text()
  if (!res.ok) throw new Error((data && data.error) || "HTTP " + res.status)
  return data
}
const org = (suffix) => "/api/v1/orgs/" + encodeURIComponent(state.org.slug) + suffix

async function download(path, name) {
  const headers = state.token ? { authorization: "Bearer " + state.token } : {}
  const res = await fetch(path, { headers, credentials: "same-origin" })
  if (!res.ok) return alert("Export failed: HTTP " + res.status)
  const url = URL.createObjectURL(await res.blob())
  h("a", { href: url, download: name }).click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function when(ms) { return ms ? new Date(ms).toLocaleString() : "—" }
function money(n) { return "$" + Number(n || 0).toFixed(2) }
function day(value, end) { if (!value) return undefined; const d = new Date(value + "T00:00:00Z"); return String(d.getTime() + (end ? 86400000 : 0)) }
function query(params) { const q = new URLSearchParams(); for (const [k, v] of Object.entries(params)) if (v) q.set(k, v); const s = q.toString(); return s ? "?" + s : "" }
function table(columns, rows) {
  return h("table", {}, h("thead", {}, h("tr", {}, columns.map((c) => h("th", {}, c)))), h("tbody", {}, rows.length ? rows : h("tr", {}, h("td", { colspan: columns.length, class: "muted" }, "Nothing here yet."))))
}
function status(el) { return { error: (e) => { el.className = "error"; el.textContent = e.message || String(e) }, ok: (t) => { el.className = "ok"; el.textContent = t } } }
function reveal(label, value) { return h("div", {}, h("p", {}, label + " — shown once, copy it now:"), h("div", { class: "secret" }, value)) }
function panel(title, ...children) { return h("section", {}, h("h2", {}, title), ...children) }
function jsonEditor(value, onsave) {
  const area = h("textarea", { spellcheck: "false" })
  area.value = JSON.stringify(value, null, 2)
  const msg = h("div")
  const save = h("button", { class: "primary", onclick: async () => {
    const parsed = (() => { try { return { value: JSON.parse(area.value) } } catch (e) { return { error: e } } })()
    if (parsed.error) return status(msg).error(parsed.error)
    try { await onsave(parsed.value); status(msg).ok("Saved.") } catch (e) { status(msg).error(e) }
  } }, "Save")
  return [area, h("div", { class: "row" }, save, msg)]
}

const views = {
  async overview() {
    const now = Date.now()
    const usage = await api("GET", org("/usage" + query({ by: "user", from: String(now - 30 * 86400000) })))
    const total = usage.rows.reduce((sum, row) => sum + row.cost, 0)
    const policy = can("policy.read") ? await api("GET", org("/policy")) : null
    return [
      panel(state.org.name,
        h("p", {}, "Slug ", h("code", {}, state.org.slug), " · your role ", h("span", { class: "badge" }, state.role), state.org.inherited ? " (inherited from parent organization)" : ""),
        policy ? h("p", {}, "Policy version " + policy.version + " · updated " + when(policy.updated)) : null,
        h("p", {}, "Spend in the last 30 days: ", h("strong", {}, money(total)), " across " + usage.rows.length + " " + (can("usage.read") ? "people" : "of your sessions"))),
      panel("Connect the CLI and IDE extensions",
        h("p", { class: "muted" }, "Deploy this file to /etc/kilo/enterprise.json (macOS: /Library/Application Support/kilo, Windows: %ProgramData%\\kilo) with your MDM, then have people run kilo enterprise login."),
        h("div", { class: "secret" }, JSON.stringify({ url: location.origin, org: state.org.slug, required: true }, null, 2))),
    ]
  },

  async members() {
    const data = await api("GET", org("/members"))
    const msg = h("div")
    const roles = ["member", "admin", "billing_manager", "owner"]
    const rows = data.members.map((m) => h("tr", {},
      h("td", {}, m.email), h("td", {}, m.name || ""),
      h("td", {}, can("member.write")
        ? h("select", { onchange: async (e) => { try { await api("PATCH", org("/members/" + m.id), { role: e.target.value }); status(msg).ok("Role updated.") } catch (err) { status(msg).error(err); e.target.value = m.role } } },
            roles.map((r) => h("option", { value: r, selected: r === m.role }, r)))
        : m.role),
      h("td", {}, m.groups.join(", ")),
      h("td", {}, m.active ? "active" : h("span", { class: "error" }, "suspended")),
      h("td", {}, can("member.write") ? [
        h("button", { onclick: async () => { try { const t = await api("POST", org("/members/" + m.id + "/tokens"), {}); msg.replaceChildren(reveal("Access token for " + m.email, t.token)) } catch (err) { status(msg).error(err) } } }, "Issue token"), " ",
        h("button", { class: "danger", onclick: async () => { if (!confirm("Remove " + m.email + "?")) return; try { await api("DELETE", org("/members/" + m.id)); render() } catch (err) { status(msg).error(err) } } }, "Remove"),
      ] : null)))
    const invite = h("form", { onsubmit: async (e) => {
      e.preventDefault()
      const form = new FormData(e.target)
      try {
        const created = await api("POST", org("/invites"), { email: form.get("email"), role: form.get("role") })
        msg.replaceChildren(reveal("Invite token (send privately)", created.token),
          h("p", {}, "They can run: ", h("code", {}, "kilo enterprise login --url " + location.origin + " --org " + state.org.slug + " --invite " + created.token)),
          created.sso ? h("p", {}, "Or simply sign in with SSO at ", h("code", {}, created.sso)) : null)
      } catch (err) { status(msg).error(err) }
    } }, h("input", { name: "email", type: "email", placeholder: "email@company.com", required: true }), h("select", { name: "role" }, roles.map((r) => h("option", { value: r }, r))), h("button", { class: "primary" }, "Invite"))
    return [panel("Members", can("member.write") ? invite : null, msg, table(["Email", "Name", "Role", "Groups", "Status", ""], rows))]
  },

  async groups() {
    const [groups, members] = await Promise.all([api("GET", org("/groups")), can("member.read") ? api("GET", org("/members")) : { members: [] }])
    const msg = h("div")
    const editor = (g) => {
      const models = g.models || { mode: "inherit", items: [] }
      const mode = h("select", {}, ["inherit", "all", "selected", "none"].map((m) => h("option", { value: m, selected: m === models.mode }, m === "inherit" ? "no model policy" : m)))
      const items = h("input", { value: (models.items || []).join(", "), placeholder: "anthropic, openrouter/*:free", size: 40 })
      const picks = members.members.map((m) => h("label", {}, h("input", { type: "checkbox", value: m.id, checked: g.members.some((x) => x.id === m.id) }), " " + m.email))
      return h("tr", {},
        h("td", {}, g.name),
        h("td", {}, mode, " ", items),
        h("td", {}, h("div", { style: "display:grid;gap:2px;max-height:160px;overflow:auto" }, picks)),
        h("td", {}, h("button", { class: "primary", onclick: async () => {
          try {
            const policy = mode.value === "inherit" ? null : { mode: mode.value, items: items.value.split(",").map((s) => s.trim()).filter(Boolean) }
            await api("PATCH", org("/groups/" + g.id), { models: policy })
            await api("PUT", org("/groups/" + g.id + "/members"), { users: picks.map((p) => p.querySelector("input")).filter((i) => i.checked).map((i) => i.value) })
            status(msg).ok("Saved " + g.name + ".")
          } catch (err) { status(msg).error(err) }
        } }, "Save"), " ", h("button", { class: "danger", onclick: async () => { if (!confirm("Delete group " + g.name + "?")) return; try { await api("DELETE", org("/groups/" + g.id)); render() } catch (err) { status(msg).error(err) } } }, "Delete")))
    }
    const create = h("form", { onsubmit: async (e) => { e.preventDefault(); try { await api("POST", org("/groups"), { name: new FormData(e.target).get("name") }); render() } catch (err) { status(msg).error(err) } } },
      h("input", { name: "name", placeholder: "Group name", required: true }), h("button", { class: "primary" }, "Create group"))
    if (!can("group.write")) return [panel("Your groups", table(["Name"], groups.groups.map((g) => h("tr", {}, h("td", {}, g.name)))))]
    return [panel("Groups",
      h("p", { class: "muted" }, "Effective model access = organization ceiling ∩ (default policy ∪ grants of every group a person is in). Groups without a model policy grant nothing extra."),
      create, msg, table(["Group", "Model access", "Members", ""], groups.groups.map(editor)))]
  },

  async policy() {
    const current = await api("GET", org("/policy"))
    const mine = await api("GET", org("/policy/effective"))
    return [
      panel("Organization policy (version " + current.version + ")",
        h("p", { class: "muted" }, "models.blocked is the org-wide ceiling (a bare provider id blocks all its models; otherwise a glob over provider/model). models.default applies to everyone: {mode: all|selected|none, items}. mcp.mode \"allowlist\" only allows servers whose URL or command matches mcp.allow. permission deny rules cannot be overridden by users. share and telemetry.product are off unless enabled."),
        can("policy.write") ? jsonEditor(current.policy, (value) => api("PUT", org("/policy"), value).then(render)) : h("pre", {}, JSON.stringify(current.policy, null, 2))),
      panel("Effective policy for you", h("pre", {}, JSON.stringify(mine, null, 2))),
    ]
  },

  async modes() {
    const data = await api("GET", org("/modes"))
    const msg = h("div")
    const template = { slug: "security-reviewer", name: "Security Reviewer", description: "Reviews diffs for security issues", prompt: "You are a meticulous security reviewer...", mode: "subagent", permission: { edit: "deny" } }
    const rows = data.modes.map((m) => h("tr", {}, h("td", {}, h("code", {}, m.slug)), h("td", {}, m.name), h("td", {}, m.mode), h("td", {}, when(m.updated)),
      h("td", {}, can("mode.write") ? h("button", { class: "danger", onclick: async () => { try { await api("DELETE", org("/modes/" + m.id)); render() } catch (err) { status(msg).error(err) } } }, "Delete") : null)))
    return [panel("Organization modes (custom agents)",
      h("p", { class: "muted" }, "Delivered to every CLI and IDE client as locked agents. Saving an existing slug updates it."),
      table(["Slug", "Name", "Mode", "Updated", ""], rows), msg,
      can("mode.write") ? jsonEditor(template, async (value) => {
        const existing = data.modes.find((m) => m.slug === value.slug)
        await (existing ? api("PUT", org("/modes/" + existing.id), value) : api("POST", org("/modes"), value))
        render()
      }) : null)]
  },

  async usage() {
    const params = state.usage || { by: "user", from: "", to: "" }
    const data = await api("GET", org("/usage" + query({ by: params.by, from: day(params.from), to: day(params.to, true) })))
    const controls = h("form", { onsubmit: (e) => { e.preventDefault(); const f = new FormData(e.target); state.usage = { by: f.get("by"), from: f.get("from"), to: f.get("to") }; render() } },
      "Group by ", h("select", { name: "by" }, ["user", "model", "provider", "day", "project"].map((b) => h("option", { value: b, selected: b === params.by }, b))),
      " from ", h("input", { type: "date", name: "from", value: params.from }), " to ", h("input", { type: "date", name: "to", value: params.to }),
      h("button", { class: "primary" }, "Apply"),
      can("usage.read") ? h("button", { type: "button", onclick: () => download(org("/usage/export" + query({ from: day(params.from), to: day(params.to, true) })), "usage.csv") }, "Export CSV") : null)
    const rows = data.rows.map((r) => h("tr", {}, h("td", {}, r.key || "—"), h("td", {}, r.requests), h("td", {}, r.users), h("td", {}, r.input.toLocaleString()), h("td", {}, r.output.toLocaleString()), h("td", {}, money(r.cost))))
    return [panel("Usage", controls, table([params.by, "Requests", "People", "Input tokens", "Output tokens", "Cost"], rows))]
  },

  async audit() {
    const params = state.audit || { action: "", actor: "", from: "", to: "" }
    const filters = { action: params.action, actor: params.actor, from: day(params.from), to: day(params.to, true) }
    const data = await api("GET", org("/audit" + query({ ...filters, limit: "200" })))
    const body = h("tbody")
    const add = (events) => body.append(...events.map((e) => h("tr", {}, h("td", {}, when(e.at)), h("td", {}, h("code", {}, e.action)), h("td", {}, e.email || ""), h("td", {}, e.target || ""), h("td", {}, h("code", { class: "wrap" }, JSON.stringify(e.details))), h("td", {}, e.ip || ""))))
    add(data.events)
    const more = h("button", { onclick: async () => {
      const next = await api("GET", org("/audit" + query({ ...filters, limit: "200", before: String(state.cursor) })))
      add(next.events); state.cursor = next.next; if (!next.next || next.events.length < 200) more.remove()
    } }, "Load more")
    state.cursor = data.next
    const controls = h("form", { onsubmit: (e) => { e.preventDefault(); const f = new FormData(e.target); state.audit = Object.fromEntries(f.entries()); render() } },
      h("input", { name: "action", placeholder: "actions, e.g. user.login,member.change_role", value: params.action, size: 36 }),
      h("input", { name: "actor", placeholder: "actor email", value: params.actor }),
      h("input", { type: "date", name: "from", value: params.from }), h("input", { type: "date", name: "to", value: params.to }),
      h("button", { class: "primary" }, "Filter"),
      h("button", { type: "button", onclick: () => download(org("/audit" + query({ ...filters, format: "csv" })), "audit.csv") }, "Export CSV"))
    return [panel("Audit log", controls,
      h("table", {}, h("thead", {}, h("tr", {}, ["Time", "Action", "Actor", "Target", "Details", "IP"].map((c) => h("th", {}, c)))), body),
      data.events.length === 200 ? more : null)]
  },

  async budgets() {
    const data = await api("GET", org("/budgets"))
    const rows = data.budgets.map((b) => h("tr", {}, h("td", {}, b.scope), h("td", {}, b.target || "—"), h("td", {}, b.period), h("td", {}, money(b.amount))))
    return [panel("Budgets",
      h("p", { class: "muted" }, "scope \"org\" caps total spend, \"member\" is the default per-person cap, \"user\" overrides it for one person (target = user id). period is \"day\" or \"month\" (UTC). Clients refuse new requests once a budget is reached."),
      table(["Scope", "Target", "Period", "Amount"], rows),
      can("budget.write") ? jsonEditor(data.budgets, (value) => api("PUT", org("/budgets"), { budgets: value }).then(render)) : null)]
  },

  async security() {
    const [sso, domains, tokens] = await Promise.all([api("GET", org("/sso")), api("GET", org("/domains")), api("GET", org("/scim/tokens"))])
    const msg = h("div")
    const ssoForm = h("form", { onsubmit: async (e) => {
      e.preventDefault()
      const f = new FormData(e.target)
      try {
        await api("PUT", org("/sso"), { issuer: f.get("issuer"), client_id: f.get("client_id"), client_secret: f.get("client_secret") || undefined, scopes: f.get("scopes"), enforce: f.get("enforce") === "on", provision: f.get("provision") === "on" })
        status(msg).ok("Single sign-on saved.")
      } catch (err) { status(msg).error(err) }
    } },
      h("input", { name: "issuer", placeholder: "https://login.example.com", value: sso.issuer || "", size: 32, required: true }),
      h("input", { name: "client_id", placeholder: "client id", value: sso.client_id || "", required: true }),
      h("input", { name: "client_secret", type: "password", placeholder: sso.configured ? "client secret (unchanged)" : "client secret" }),
      h("input", { name: "scopes", value: sso.scopes || "openid email profile" }),
      h("label", {}, h("input", { type: "checkbox", name: "enforce", checked: sso.enforce }), " require SSO"),
      h("label", {}, h("input", { type: "checkbox", name: "provision", checked: sso.provision !== false }), " auto-join verified domains"),
      h("button", { class: "primary" }, "Save"))
    const domainRows = domains.domains.map((d) => h("tr", {}, h("td", {}, d.name), h("td", {}, d.verified ? h("span", { class: "ok" }, "verified") : h("span", {}, "TXT ", h("code", {}, d.record.value))),
      h("td", {}, d.verified ? null : h("button", { onclick: async () => { try { await api("POST", org("/domains/" + encodeURIComponent(d.name) + "/verify")); render() } catch (err) { status(msg).error(err) } } }, "Verify"), " ",
        h("button", { class: "danger", onclick: async () => { try { await api("DELETE", org("/domains/" + encodeURIComponent(d.name))); render() } catch (err) { status(msg).error(err) } } }, "Remove"))))
    const addDomain = h("form", { onsubmit: async (e) => { e.preventDefault(); try { await api("POST", org("/domains"), { domain: new FormData(e.target).get("domain") }); render() } catch (err) { status(msg).error(err) } } },
      h("input", { name: "domain", placeholder: "example.com", required: true }), h("button", {}, "Add domain"))
    const tokenRows = tokens.tokens.map((t) => h("tr", {}, h("td", {}, t.name), h("td", {}, when(t.created)), h("td", {}, when(t.used)), h("td", {}, t.revoked ? "revoked" : h("button", { class: "danger", onclick: async () => { try { await api("DELETE", org("/scim/tokens/" + t.id)); render() } catch (err) { status(msg).error(err) } } }, "Revoke"))))
    const newToken = h("button", { onclick: async () => { try { const t = await api("POST", org("/scim/tokens"), { name: "SCIM" }); msg.replaceChildren(reveal("SCIM bearer token (base URL " + t.base + ")", t.token)) } catch (err) { status(msg).error(err) } } }, "Create SCIM token")
    return [
      panel("Single sign-on (OIDC)", h("p", { class: "muted" }, "Register this redirect URI with your identity provider: ", h("code", {}, sso.redirect_uri), ". Sign-in URL: ", h("code", {}, sso.login_url)), ssoForm),
      panel("Verified domains", h("p", { class: "muted" }, "People with a verified email domain join automatically as members when they sign in with SSO."), addDomain, table(["Domain", "Status", ""], domainRows)),
      panel("SCIM provisioning", h("p", { class: "muted" }, "Point your IdP's SCIM 2.0 connector at " + location.origin + "/scim/v2 with a bearer token."), newToken, table(["Name", "Created", "Last used", ""], tokenRows)),
      msg,
    ]
  },

  async suborgs() {
    const data = await api("GET", org("/suborgs"))
    const msg = h("div")
    const rows = data.suborgs.map((s) => h("tr", {}, h("td", {}, s.name), h("td", {}, h("code", {}, s.slug)), h("td", {}, s.members), h("td", {}, money(s.spent))))
    const create = state.org.parent ? null : h("form", { onsubmit: async (e) => { e.preventDefault(); const f = new FormData(e.target); try { await api("POST", org("/suborgs"), { name: f.get("name"), slug: f.get("slug") }); location.reload() } catch (err) { status(msg).error(err) } } },
      h("input", { name: "name", placeholder: "Business unit", required: true }), h("input", { name: "slug", placeholder: "slug", required: true, pattern: "[a-z0-9][a-z0-9-]{1,62}" }), h("button", { class: "primary" }, "Create sub-organization"))
    return [panel("Sub-organizations", h("p", { class: "muted" }, "Each sub-organization has its own members, policy and budgets. Parent owners, admins and billing managers can manage them without a seat."), create, msg, table(["Name", "Slug", "Members", "Spend this month"], rows))]
  },
}

const tabs = [
  ["overview", "Overview", () => true], ["members", "Members", () => can("member.read")], ["groups", "Groups", () => true],
  ["policy", "Policy", () => can("policy.read")], ["modes", "Modes", () => true], ["usage", "Usage", () => true],
  ["audit", "Audit log", () => can("audit.read")], ["budgets", "Budgets", () => can("usage.read")],
  ["security", "Security", () => can("sso.write")], ["suborgs", "Sub-orgs", () => can("suborg.read")],
]

async function render() {
  const root = document.getElementById("app")
  const visible = tabs.filter(([, , show]) => show())
  if (!visible.some(([id]) => id === state.tab)) state.tab = "overview"
  const content = h("main", {}, h("p", { class: "muted" }, "Loading…"))
  const select = h("select", { onchange: (e) => { state.org = state.me.orgs.find((o) => o.slug === e.target.value); state.role = state.org.role; render() } },
    state.me.orgs.map((o) => h("option", { value: o.slug, selected: o.slug === state.org.slug }, o.name + (o.inherited ? " (managed)" : ""))))
  root.replaceChildren(
    h("header", {}, h("h1", {}, "Enterprise Admin"), select, h("span", { class: "muted" }, state.me.user.email), h("button", { onclick: logout }, "Sign out")),
    h("nav", {}, visible.map(([id, label]) => h("button", { class: id === state.tab ? "active" : "", onclick: () => { state.tab = id; render() } }, label))),
    content)
  try { content.replaceChildren(...(await views[state.tab]()).filter(Boolean)) } catch (err) { content.replaceChildren(h("section", {}, h("p", { class: "error" }, err.message))) }
}

async function logout() {
  await api("POST", "/api/v1/auth/logout").catch(() => null)
  sessionStorage.removeItem("ent_token")
  location.reload()
}

function login(message) {
  const root = document.getElementById("app")
  const msg = h("p", { class: "error" }, message || "")
  root.replaceChildren(h("div", { class: "center" }, h("section", {},
    h("h2", {}, "Sign in"),
    h("form", { onsubmit: (e) => { e.preventDefault(); location.href = "/sso/" + encodeURIComponent(new FormData(e.target).get("org")) + "/start" } },
      h("input", { name: "org", placeholder: "organization slug", required: true }), h("button", { class: "primary" }, "Continue with SSO")),
    h("p", { class: "muted" }, "Or paste an access token (for example the bootstrap owner token):"),
    h("form", { onsubmit: (e) => { e.preventDefault(); sessionStorage.setItem("ent_token", new FormData(e.target).get("token")); location.reload() } },
      h("input", { name: "token", type: "password", placeholder: "ent_…", required: true, size: 30 }), h("button", {}, "Use token")),
    msg)))
}

async function start() {
  try {
    state.me = await api("GET", "/api/v1/me")
  } catch (err) {
    sessionStorage.removeItem("ent_token")
    return login(state.token ? err.message : "")
  }
  if (!state.me.orgs.length) return login("This account has no organization access.")
  state.org = state.me.orgs[0]
  state.role = state.org.role
  render()
}
start()
`

export const admin = new Hono<Env>()

admin.get("/admin", (c) => c.html(html, 200, { "content-security-policy": csp, "cache-control": "no-store" }))
admin.get("/admin/app.js", (c) =>
  c.body(script, 200, {
    "content-type": "text/javascript; charset=utf-8",
    "content-security-policy": csp,
    "cache-control": "no-store",
  }),
)
admin.get("/", (c) => c.redirect("/admin"))
admin.get("/favicon.ico", (c) => c.body(null, 204))
