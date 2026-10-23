# Enterprise control plane

A self-hosted server that gives the Kilo CLI, VS Code extension and JetBrains plugin the governance features of a managed enterprise plan: single sign-on, SCIM provisioning, organization policy (model, MCP and tool-permission controls), org-managed agents, audit logs, usage analytics and budgets.

It is part of this fork, not of upstream Kilo Code. Upstream's enterprise features run on Kilo's hosted backend, which is not open source; this package reimplements the same concepts so they can run on your own infrastructure. The semantics follow Kilo's published Enterprise documentation (roles, model access rules, audit event names) so the behaviour is familiar.

## What it provides

| Area | Details |
|---|---|
| Organizations | Owner, admin, member and billing manager roles; one level of sub-organizations whose parent owners, admins and billing managers get access without a seat |
| Sign-in | Single sign-on with OpenID Connect (discovery, PKCE, nonce, JWKS-verified ID tokens) or SAML 2.0 (signed responses, metadata import, optional IdP-initiated sign-in); RFC 8628 device flow for the CLI and IDEs; invite links; admin-issued tokens for orgs without SSO |
| Provisioning | Verified-domain just-in-time provisioning; SCIM 2.0 `Users` and `Groups`, handling the request quirks Okta and Entra ID are known for (string booleans, PATCH with and without paths). Not yet validated against live IdP tenants |
| Model access | Org-wide denylist ceiling, default policy and group grants (`all`, `selected`, `none`); effective access = ceiling ∩ (default ∪ group grants) |
| MCP controls | Open or allowlist mode, blocklist, matched on the server URL or command line; org-provided servers pushed to every client |
| Tool permissions | Org `permission` rules; denies are hard rules users and sessions cannot override |
| Org agents | Custom modes delivered to clients as locked agents |
| Guardrails | Org rules appended to every system prompt; session sharing, vendor session sync and product analytics off unless the org enables them |
| Audit log | Every administrative and sign-in event, filterable by action, actor and date, cursor-paged, CSV export, configurable retention |
| Audit streaming | New audit events pushed to SIEMs as they happen: HMAC-signed HTTPS webhooks or RFC 5424 syslog over TLS, in order, at least once, resuming after outages |
| LLM gateway | Routes chosen providers (Anthropic, OpenAI, OpenAI-compatible) through the server, which holds the org's API keys, enforces model policy and budgets on every call and meters usage from the responses |
| Usage | Per-LLM-call usage, metered by the gateway or reported by clients (idempotent); breakdowns by user, model, provider, day, project and source; CSV export |
| Budgets | Org-wide, per-member default and per-user daily or monthly limits; clients refuse new requests once one is reached, and so does the gateway |
| Admin console | Built-in web UI at `/admin` ([`packages/enterprise-console`](../enterprise-console)), built like Kilo's own web console |
| Deployment | One binary or container with Postgres embedded, or any number of replicas behind a load balancer on a shared PostgreSQL server ([storage and high availability](#storage-and-high-availability)) |

## Quick start

```sh
# From source the server serves the console's build output, so build it once.
(cd packages/enterprise-console && bun run build)

cd packages/enterprise-server

# 1. Create the first organization and owner. Prints an owner token once.
bun run bootstrap --org "Acme" --slug acme --email you@acme.com

# 2. Start the server.
ENTERPRISE_BASE_URL=https://ai.acme.com ENTERPRISE_SECRET=$(openssl rand -hex 32) bun run start
```

Open `https://ai.acme.com/admin` and paste the owner token, or configure SSO and sign in with it.

For production, build a self-contained binary (Bun runtime, an embedded Postgres, the admin console and all dependencies included) and run it anywhere with glibc:

```sh
bun run build   # dist/enterprise-server
./dist/enterprise-server bootstrap --org Acme --slug acme --email you@acme.com
./dist/enterprise-server serve
```

### Docker

The image ([`Dockerfile`](Dockerfile)) packages that binary on a distroless base. It runs as an unprivileged user (uid 65532) and keeps its database in the `/data` volume.

```sh
bun run build
docker build -t enterprise-server .
docker run --rm -v enterprise-data:/data enterprise-server bootstrap --org Acme --slug acme --email you@acme.com
export ENTERPRISE_SECRET=$(openssl rand -hex 32)   # keep it: stored keys can't be decrypted without it
docker run -d -p 8787:8787 -v enterprise-data:/data \
  -e ENTERPRISE_BASE_URL=https://ai.acme.com -e ENTERPRISE_SECRET enterprise-server
```

Point liveness and readiness probes at `GET /healthz`. A bind-mounted data directory must be writable by uid 65532. The embedded database opens in one process at a time, so run `bootstrap` while the server is stopped; while it runs, `bootstrap` exits with an error saying so. To run several containers, give them all `ENTERPRISE_DATABASE_URL` instead ([storage and high availability](#storage-and-high-availability)).

Always run it behind HTTPS. Tokens and the admin session cookie must not travel in clear text, and the server warns at startup if `ENTERPRISE_BASE_URL` is not `https://` (localhost excepted).

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `ENTERPRISE_BASE_URL` | `http://localhost:<port>` | Public URL; used for SSO redirect URIs, device-login links and cookie scope |
| `ENTERPRISE_PORT` | `8787` | Listen port |
| `ENTERPRISE_HOST` | `0.0.0.0` | Listen address |
| `ENTERPRISE_DATABASE_URL` | unset | A PostgreSQL server to keep everything in, as `postgres://user:password@host:5432/database`. Needed for more than one replica. Unset, the server uses its embedded database |
| `ENTERPRISE_DATABASE_POOL` | `10` | Connections each server opens to `ENTERPRISE_DATABASE_URL` |
| `ENTERPRISE_DATA` | `./data` | Data directory. The embedded database lives in `postgres/` inside it |
| `ENTERPRISE_DB` | `<ENTERPRISE_DATA>/enterprise.db` | The SQLite database of earlier versions, copied in on first start ([upgrading](#upgrading-from-sqlite)) |
| `ENTERPRISE_SECRET` | unset | Key material for encrypting SSO client secrets and gateway API keys at rest (AES-256-GCM). Required before SSO or the gateway can be configured; keep it stable |
| `ENTERPRISE_TRUST_PROXY` | unset | Set to `1` behind a reverse proxy so audit entries record `X-Forwarded-For` |
| `ENTERPRISE_AUDIT_RETENTION_DAYS` | `365` | Audit history to keep; `0` keeps it forever |
| `ENTERPRISE_MODELS_URL` | `https://models.dev/api.json` | Model price catalog the gateway meters with, as a URL or a local file path in models.dev's format. Empty turns pricing off |
| `ENTERPRISE_LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error`; logs are logfmt on stdout |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | unset | Also send logs and traces over OTLP (HTTP, JSON); `OTEL_EXPORTER_OTLP_HEADERS` adds headers |

The server also reads a `.env` file from its working directory, a convenient place for these settings; keep it readable only by the service account. Back up the database: it holds the audit log and usage history.

## Storage and high availability

Everything is kept in PostgreSQL, embedded in the server or on a PostgreSQL server.

**Embedded (the default).** Without `ENTERPRISE_DATABASE_URL`, the server runs Postgres in its own process ([PGlite](https://pglite.dev), Postgres compiled to WebAssembly), with its files in `ENTERPRISE_DATA/postgres`. There is nothing else to install. It is for one server: the directory is locked while the server has it open, so a second server, or a `bootstrap` while the server runs, exits with an error instead of corrupting it. A commit is on disk before the request that made it completes. To back it up, stop the server and copy the directory, or snapshot the volume.

**A PostgreSQL server, for high availability.** Point every server at the same database with `ENTERPRISE_DATABASE_URL` (PostgreSQL 14 or later; a managed service such as Amazon RDS, Cloud SQL or Azure Database for PostgreSQL works), give them all the same `ENTERPRISE_SECRET` and `ENTERPRISE_BASE_URL`, and put them behind a load balancer that checks `GET /healthz`. Back up and replicate the database with your usual Postgres tooling.

- Any server handles any request, with no session affinity. Sign-ins keep their state in the database, so an SSO sign-in or a device login can start on one server and finish on another.
- Servers apply database migrations as they start, one at a time under an advisory lock, so they can start together. A server that can't reach or open its database exits at startup with the reason.
- Each audit stream is delivered by one server at a time, which holds a one-minute lease on it. If that server stops in the middle of a delivery, another sends the batch again when the lease runs out. Audit events get their ids in commit order, so a stream never passes over one that commits late.
- Checks that guard a write, such as keeping an organization's last owner, run in one transaction under a database-wide lock, so two servers can't both pass them.

### Upgrading from SQLite

Earlier versions kept everything in a SQLite file (`ENTERPRISE_DB`, by default `data/enterprise.db`). Stop the old server and start the new one with the same data directory. On its first start on an empty database, the new server copies every row in, keeping ids so audit streams resume where they stopped, logs `copied the SQLite database into Postgres`, and leaves the file as it was. With `ENTERPRISE_DATABASE_URL` set, the rows go to the PostgreSQL server instead.

### Moving to a PostgreSQL server

Stop the server, then start it with `ENTERPRISE_DATABASE_URL` pointing at an empty database and the same `ENTERPRISE_DATA`. On its first start it copies the embedded database into the PostgreSQL server, logs `copied the embedded database into the Postgres server`, and leaves the embedded files as they were. Then start the other servers.

## Connecting clients

Deploy `enterprise.json` to each developer machine with your MDM:

| OS | Path |
|---|---|
| Linux | `/etc/kilo/enterprise.json` |
| macOS | `/Library/Application Support/kilo/enterprise.json` |
| Windows | `%ProgramData%\kilo\enterprise.json` |

```json
{ "url": "https://ai.acme.com", "org": "acme", "required": true }
```

Developers then run `kilo enterprise login`, which opens the browser for SSO. The VS Code and JetBrains extensions run the same CLI underneath and pick up the same sign-in, provided they are built from this fork. The marketplace builds of upstream Kilo don't contain the enterprise layer. Other commands: `kilo enterprise status`, `kilo enterprise policy`, `kilo enterprise logout`. With `required: true` (the default for a managed file) the agent refuses to run until the user has signed in and a policy is loaded.

Without a managed file, `KILO_ENTERPRISE_URL`, `KILO_ENTERPRISE_ORG` and optionally `KILO_ENTERPRISE_TOKEN` (for CI) do the same. A managed file always wins over the environment.

See [FORK.md](../../FORK.md) for exactly where the client enforces each policy.

## Single sign-on

Each org connects one identity provider, with OpenID Connect or SAML 2.0. People sign in to the console with it, and approve CLI and IDE device logins with it.

### OpenID Connect

1. Set `ENTERPRISE_SECRET` on the server.
2. Register an OIDC web application with your identity provider (Okta, Entra ID, Google Workspace, Auth0, Keycloak, …). Redirect URI: `https://<server>/sso/callback`. Grant type: authorization code. Scopes: `openid email profile`.
3. In the admin console under Identity → Single sign-on and SCIM, choose OpenID Connect and enter the issuer URL, client ID and client secret. The server checks the issuer's discovery document before saving.

### SAML 2.0

1. In the admin console under Identity → Single sign-on and SCIM, choose SAML 2.0. The page shows what to register at your identity provider: the entity ID (`https://<server>/sso/saml/<org-slug>`, Okta's "Audience URI", Entra ID's "Identifier") and the ACS URL (`…/acs`, Okta's "Single sign-on URL", Entra ID's "Reply URL"). Identity providers that import service provider metadata can take `…/metadata` instead.
2. Have the identity provider send the person's email address, either as the NameID (email format) or as an `email`, `mail` or `…/claims/emailaddress` attribute. A display name (`displayName`, or `givenName` and `sn`) is optional.
3. Paste the identity provider's metadata XML into the console, or enter its entity ID, sign-in URL (HTTP-Redirect binding) and signing certificate. While the identity provider rotates its key, give both certificates.

The server accepts a response only if the identity provider signed it (the whole response or the assertion), it names the configured entity ID as its issuer, its audience is this org's entity ID, it is at most 10 minutes old, and it answers a sign-in this server started; each assertion works once. Sign-ins started from the identity provider's app list (IdP-initiated) are refused unless the org turns on "Allow sign-in from the identity provider": such a response answers no request from this server, so only its signature, lifetime and the one-use rule protect it. Encrypted assertions and single logout are not supported.

### Both

Optionally add and verify your email domain (a DNS TXT record) so people from that domain join automatically as members on first sign-in, and turn on "Require single sign-on" to disable invite links and admin-issued tokens for that org.

Sign-in URL for people: `https://<server>/sso/<org-slug>/start`.

## SCIM provisioning

Create a SCIM token under Identity → Single sign-on and SCIM, then point your IdP's SCIM 2.0 connector at `https://<server>/scim/v2` with that bearer token. The token decides which organization is provisioned.

| IdP action | Effect |
|---|---|
| Create user | Account created (or linked by email) and added as a member |
| Deactivate (`active: false`) | Membership suspended in this org; access stops immediately, history is kept, the IdP can reactivate |
| Delete user | Membership removed; if no memberships remain the account is deactivated and every token revoked |
| Push groups | Creates and maintains groups, which are the same groups that carry model-access grants |

SCIM never rewrites the email or name of an account that another organization also depends on.

## LLM gateway

Client-side enforcement stops honest mistakes, but a person with an API key can always use it from some other tool. The gateway closes that gap for the providers it routes: the organization's key stays on the server, and people reach the provider only through it.

1. Set `ENTERPRISE_SECRET`, then add providers under Governance → LLM gateway, or with `PUT /api/v1/orgs/{org}/gateway/providers/{id}` and `{ "kind": "anthropic", "base": "https://api.anthropic.com/v1", "key": "sk-ant-..." }`. The id is the client's provider id (`anthropic`, `openai`, `openrouter`, ...), and `base` includes the API version path.
2. Signed-in clients pick the routes up with the policy. Each routed provider's requests go to `<server>/gateway/<id>/...` with the person's enterprise token as the API key; nobody needs, or sees, the provider key.
3. Turn on **Only allow gateway providers** (`"gateway": { "exclusive": true }` in the policy) and clients refuse every other provider.

| `kind` | Relayed endpoints | Metered from |
|---|---|---|
| `anthropic` | `POST /messages`, `POST /messages/count_tokens`, `GET /models` | `usage` in the message, or `message_start` and `message_delta` events |
| `openai` | `POST /responses`, `POST /chat/completions`, `GET /models` | `usage` in the response, or the `response.completed` event |
| `openai-compatible` | `POST /chat/completions`, `GET /models` | the final chunk's `usage`; the gateway adds `stream_options.include_usage` to streamed calls |

On every call the gateway checks the token, membership and the member's effective model policy, refuses with `402` once a budget is spent, swaps in the org key and relays the response as it streams. Only content, version, beta and user-agent headers are relayed upstream; only content type, request ids, `retry-after` and rate-limit headers come back. Usage is recorded with `source: "gateway"` when the response ends, including when the client hangs up. It is priced from `ENTERPRISE_MODELS_URL` with the same arithmetic the CLI uses, or at the price the upstream reports, as OpenRouter does. Usage clients report for a routed provider is dropped, so nothing counts twice.

## Policy reference

Edit the policy as JSON in the admin console (Governance → Policy; it is checked against the policy schema before it is sent) or with `PUT /api/v1/orgs/{org}/policy`. Every field is optional.

```json
{
  "models": {
    "blocked": ["openai", "openrouter/*:free"],
    "default": { "mode": "selected", "items": ["anthropic", "kilo/anthropic/claude-sonnet-*"] }
  },
  "mcp": {
    "mode": "allowlist",
    "allow": ["https://mcp.acme.com/*", "npx -y @acme/mcp-server*"],
    "block": [],
    "servers": { "acme-docs": { "type": "remote", "url": "https://mcp.acme.com/docs" } }
  },
  "permission": { "bash": { "rm -rf *": "deny", "git push *": "ask" }, "webfetch": "deny" },
  "instructions": "Never paste customer data or credentials into prompts.",
  "share": "disabled",
  "telemetry": { "product": false },
  "gateway": { "exclusive": false }
}
```

- **Model identifiers** are `provider/model` as the client knows them, for example `anthropic/claude-sonnet-4`, or `kilo/anthropic/claude-opus-4` for models routed through the Kilo gateway provider. An entry without a slash means the whole provider; `*` matches any characters, including `/`.
- **`models.blocked`** is the org-wide ceiling. Nothing granted anywhere can get past it.
- **`models.default`** applies to everyone, and each group can carry its own grant. A person's effective access is the ceiling intersected with the union of the default and their groups' grants. If none of these is set, access is unrestricted below the ceiling.
- **MCP rules** match the server's target, its URL or its full command line, never its name, because users choose names freely.
- **`permission`** uses the same format as the CLI's `permission` config. Deny rules become hard rules; allow and ask rules override user config but not a user's session approvals.
- **`share`** controls session sharing and syncing sessions to the upstream vendor's cloud. **`telemetry.product`** controls the upstream product analytics. Both default to off.
- **`gateway.exclusive`** makes clients refuse every provider the [LLM gateway](#llm-gateway) does not route.

Budgets are managed separately (Governance → Budgets or `PUT /api/v1/orgs/{org}/budgets`): `org` caps total spend, `member` is the default per-person cap, and `user` overrides it for one person. Periods are UTC `day` or `month`.

## Audit streaming

Under Insight → Audit streaming (or `POST /api/v1/orgs/{org}/audit/streams`), owners and admins add destinations that receive every new audit event. A stream starts with the events recorded after it is created, its own creation first; older history is in the CSV export.

- **Webhook**: a `POST` of `{ "org": { "id", "slug", "name" }, "events": [...] }`, up to 200 events per request. Each event is the audit API's event plus an ISO `time`. An optional header, such as Splunk HEC's `Authorization: Splunk <token>`, is stored encrypted. Every delivery carries `x-enterprise-delivery` (a unique id) and `x-enterprise-signature: t=<unix seconds>,v1=<hex>`, where the hex is the HMAC-SHA256 of `<t>.<raw body>` keyed with the stream's signing secret, which is shown once when the stream is created. Compare signatures in constant time, and reject timestamps more than a few minutes old. Any 2xx response accepts the batch; redirects are not followed.
- **Syslog**: one RFC 5424 message per event over TCP, TLS by default (RFC 5425), with RFC 6587 octet-counting framing: facility 13 (log audit), severity informational, `APP-NAME` `kilo-enterprise`, `MSGID` the action, and the event as JSON in the message.

Events are delivered in order and at least once, so receivers can use the event `id` to drop the rare duplicate. A failing destination is retried with backoff, from 5 seconds up to every 5 minutes, and resumes exactly where it stopped. Its error shows on the stream until it recovers, and pausing a stream keeps its place. "Send test" sends a synthetic `audit.stream_test` event (id `0`) without affecting delivery. With several servers, one at a time delivers each stream (see [high availability](#storage-and-high-availability)).

## Audit events

`audit.stream_create`, `audit.stream_remove`, `audit.stream_update`, `budget.update`, `custom_mode.create`, `custom_mode.delete`, `custom_mode.update`, `domain.create`, `gateway.provider_create`, `gateway.provider_remove`, `gateway.provider_update`, `group.create`, `group.delete`, `group.update`, `member.add`, `member.change_role`, `member.remove`, `organization.create`, `organization.settings_change`, `policy.update`, `scim.group_create`, `scim.group_delete`, `scim.group_update`, `scim.token_create`, `scim.token_revoke`, `scim.user_activate`, `scim.user_create`, `scim.user_deactivate`, `scim.user_delete`, `scim.user_update`, `sso.auto_provision`, `sso.remove`, `sso.remove_domain`, `sso.set_domain`, `sso.update`, `token.create`, `token.revoke`, `user.accept_invite`, `user.login`, `user.logout`, `user.revoke_invite`, `user.send_invite`.

Each entry records time, action, actor (user and email snapshot), target, details (for example the role before and after, or the models added to the blocklist) and client IP.

## API

All endpoints take `Authorization: Bearer <token>` and return JSON. The contract is defined once in [`packages/enterprise-protocol`](../enterprise-protocol) and served as OpenAPI at `GET /api/v1/openapi.json`; the CLI and the admin console use clients derived from it. Errors are `{ "_tag": "...", "message": "..." }` with the matching HTTP status.

| Endpoint | Purpose |
|---|---|
| `GET /api/v1/me` | Caller and the organizations their token reaches |
| `POST /api/v1/auth/device`, `POST /api/v1/auth/device/token` | Device login (RFC 8628) |
| `POST /api/v1/auth/logout` | Revoke the current token |
| `GET/POST/DELETE /api/v1/me/tokens` | Personal access tokens |
| `POST /api/v1/invites/{token}/accept` | Accept an invite |
| `GET/PATCH /api/v1/orgs/{org}` | Organization |
| `/api/v1/orgs/{org}/members`, `/invites`, `/groups` | People |
| `/api/v1/orgs/{org}/policy`, `/policy/effective` | Policy and what a client enforces for the caller (supports `If-None-Match`) |
| `/api/v1/orgs/{org}/modes` | Org-managed agents |
| `/api/v1/orgs/{org}/audit`, `/audit/export` | Audit log (`action`, `actor`, `from`, `to`, `before`, `limit`) and its CSV export |
| `/api/v1/orgs/{org}/audit/streams`, `/audit/streams/{id}`, `/audit/streams/{id}/test` | Audit streams (webhook and syslog destinations) |
| `/api/v1/orgs/{org}/usage`, `/usage/export` | Usage ingestion and analytics |
| `/api/v1/orgs/{org}/budgets` | Budgets |
| `/api/v1/orgs/{org}/gateway`, `/gateway/providers/{id}` | LLM gateway providers (keys are write-only) |
| `/gateway/{provider}/...` | The gateway itself; speaks each provider's own API, with an enterprise token as the API key |
| `/api/v1/orgs/{org}/sso`, `/sso/saml`, `/domains`, `/scim/tokens` | Identity configuration: `PUT /sso` saves OpenID Connect, `PUT /sso/saml` saves SAML 2.0 |
| `/sso/saml/{org}/metadata`, `/sso/saml/{org}/acs` | SAML service provider metadata, and where the identity provider posts responses |
| `/api/v1/orgs/{org}/suborgs` | Sub-organizations |
| `/scim/v2/...` | SCIM 2.0 |
| `GET /healthz` | Liveness |

## Security model

- Bearer tokens are random 256-bit values, stored only as SHA-256 hashes, prefixed (`ent_`, `ents_`) so secret scanners can find leaked ones, revocable, and expiring (90 days for CLI logins, 8 hours for browser sessions).
- **Every token is bound to the organization it was issued for**, and reaches only that org and its sub-orgs. An org's admins configure that org's identity provider, so an identity asserted through it must never carry into another org that happens to share the person. The test suite includes this attack.
- Deactivating a user revokes all of their tokens at once. Suspended memberships grant nothing.
- SSO client secrets, gateway API keys, and audit streams' signing secrets and headers are encrypted at rest. The API never returns them; for a gateway key it shows only the last four characters. The gateway relays only its providers' chat endpoints and never follows upstream redirects, so an org key cannot be used for anything else or sent to another host.
- Invite and device codes are single-use, and device codes expire after 10 minutes.
- SAML responses must be signed by the org's identity provider and name it as their issuer: the server checks the issuer itself, so an identity provider that signs for several tenants with one key can't sign in for another org. Assertions are remembered until they expire, so a captured response can't be replayed.
- The browser session cookie is `HttpOnly`, `Secure` on HTTPS, and `SameSite=Lax`. Every cookie-authenticated write must carry a same-origin `Origin` header.
- The admin console is served with a strict Content Security Policy and renders all data as text.
- CSV exports neutralise spreadsheet formulas.

## Limits of client-side enforcement

The CLI enforces policy on the developer's machine. That stops honest mistakes and policy drift, but a user who controls their machine can always run some other tool with their own API key. For providers routed through the [LLM gateway](#llm-gateway), model access, budgets and usage metering hold on the server instead: people never hold the key. What the gateway cannot control is a provider account someone pays for themselves; block that provider in `models.blocked` and, if you need it enforced on the network, at your egress proxy.

## Development

```sh
bun test                    # unit and integration tests on an in-memory Postgres, including a local OIDC provider and SAML-signed responses
bun run typecheck
bun run migration           # after changing src/db/schema.sql.ts; --check fails when one is missing
bun run build               # dist/enterprise-server with the console embedded
```

The server is built on the same stack as the Kilo CLI's own server:

| Concern | Where |
|---|---|
| HTTP API | `effect/unstable/httpapi`: the shared contract in `packages/enterprise-protocol`, handlers in `src/handlers/`, auth and org scoping as middleware in `src/middleware/` |
| Browser flows | Device approval and SSO pages in `src/routes/`, the console's static files in `src/routes/console.ts` |
| Storage | Drizzle on PostgreSQL (`drizzle-orm/effect-postgres` over `@effect/sql-pg`), schema in `src/db/schema.sql.ts`, generated TypeScript migrations in `src/db/migration/`; the embedded database is PGlite behind the same client (`src/db/embedded.ts`), and earlier data is copied in by `src/db/legacy.ts` |
| Services | Effect services wired as a `LayerNode` graph (`src/app.ts`); configuration through Effect `Config` (`src/config.ts`) |
| Observability | Effect logging (logfmt) and OTLP export (`src/observability.ts`) |
