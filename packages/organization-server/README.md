# Organization server

A self-hosted server for running Kilo across an organization: single sign-on, SCIM provisioning, organization policy (model, MCP and tool-permission controls), org-managed agents, an LLM gateway, audit logs and streaming, usage analytics and budgets. The Kilo CLI, VS Code extension and JetBrains plugin sign in to it and enforce what it decides.

These are standard features of this fork's Kilo Code, not a separate paid tier. Upstream Kilo offers similar features in its hosted Enterprise plan, on a backend that is not open source; this package implements the same concepts so they run on your own infrastructure. The roles, model access rules and audit event names follow Kilo's published Enterprise documentation, so they behave the way Kilo users expect.

## What it provides

| Area | Details |
|---|---|
| Organizations | Owner, admin, member and billing manager roles; one level of sub-organizations whose parent owners, admins and billing managers get access without a seat; a seat limit across an organization and its sub-organizations |
| Sign-in | Single sign-on with OpenID Connect (discovery, PKCE, nonce, JWKS-verified ID tokens) or SAML 2.0 (signed responses, metadata import, optional IdP-initiated sign-in); RFC 8628 device flow for the CLI and IDEs; invite links; admin-issued tokens for orgs without SSO |
| Provisioning | Verified-domain just-in-time provisioning; SCIM 2.0 `Users` and `Groups`, handling the request quirks Okta and Entra ID are known for (string booleans, PATCH with and without paths). Not yet validated against live IdP tenants |
| Model access | Org-wide denylist ceiling, default policy and group grants (`all`, `selected`, `none`); effective access = ceiling ∩ (default ∪ group grants) |
| MCP controls | Open or allowlist mode, blocklist, matched on the server URL or command line; org-provided servers pushed to every client |
| Tool permissions | Org `permission` rules; denies are hard rules users and sessions cannot override |
| Org agents | Custom modes delivered to clients as locked agents |
| Guardrails | Org rules appended to every system prompt; session sharing, vendor session sync and product analytics off unless the org enables them |
| Audit log | Every administrative and sign-in event, and when the policy asks, each tool the agent runs; filterable by action, actor and date, cursor-paged, CSV export, configurable retention |
| Audit streaming | New audit events pushed to SIEMs as they happen: HMAC-signed HTTPS webhooks, RFC 5424 syslog over TLS, or OpenTelemetry logs over OTLP/HTTP, in order, at least once, resuming after outages |
| LLM gateway | Routes chosen providers through the server, which holds the org's credentials, enforces model policy, budgets and per-member rate limits on every call, meters usage from the responses and logs each call. Upstreams: Anthropic, OpenAI, Azure OpenAI, any OpenAI-compatible server or gateway (LiteLLM, vLLM, Ollama, OpenRouter, Portkey), and Claude on Amazon Bedrock and Google Vertex AI |
| Prices | The org's own rates or discounts per provider or model, for negotiated prices and models the catalog doesn't price |
| Data policy | Refuses providers that may train on the org's data, keep it, or process it outside chosen regions, judged by the terms admins record for each provider. OpenRouter-compatible providers get the filters as routing preferences on every request |
| Usage | Per-LLM-call usage, metered by the gateway or reported by clients (idempotent); breakdowns by user, model, provider, day, project and source; CSV export |
| Analytics | Adoption by day, week or month (active and new people, sessions, requests, spend), members who don't use Kilo, and groups, sub-organizations and models compared with the period before; weekly or monthly reports posted to a webhook, such as a Slack channel |
| Budgets | Daily or monthly limits for the whole organization (its sub-organizations included), each person, one person, a group's combined spend, and a sub-organization's allowance; clients refuse new requests once one is reached, and so does the gateway |
| Admin console | Built-in web UI at `/admin` ([`packages/organization-console`](../organization-console)), built like Kilo's own web console |
| Deployment | One binary or container with Postgres embedded, or any number of replicas behind a load balancer on a shared PostgreSQL server ([storage and high availability](#storage-and-high-availability)) |

## Quick start

```sh
# From source the server serves the console's build output, so build it once.
(cd packages/organization-console && bun run build)

cd packages/organization-server

# 1. Create the first organization and owner. Prints an owner token once.
bun run bootstrap --org "Acme" --slug acme --email you@acme.com

# 2. Start the server.
ORGANIZATION_BASE_URL=https://ai.acme.com ORGANIZATION_SECRET=$(openssl rand -hex 32) bun run start
```

Open `https://ai.acme.com/admin` and paste the owner token, or configure SSO and sign in with it.

For production, build a self-contained binary (Bun runtime, an embedded Postgres, the admin console and all dependencies included) and run it anywhere with glibc:

```sh
bun run build   # dist/organization-server
./dist/organization-server bootstrap --org Acme --slug acme --email you@acme.com
./dist/organization-server serve
```

### Docker

The image ([`Dockerfile`](Dockerfile)) packages that binary on a distroless base. It runs as an unprivileged user (uid 65532) and keeps its database in the `/data` volume.

```sh
bun run build
docker build -t organization-server .
docker run --rm -v organization-data:/data organization-server bootstrap --org Acme --slug acme --email you@acme.com
export ORGANIZATION_SECRET=$(openssl rand -hex 32)   # keep it: stored keys can't be decrypted without it
docker run -d -p 8787:8787 -v organization-data:/data \
  -e ORGANIZATION_BASE_URL=https://ai.acme.com -e ORGANIZATION_SECRET organization-server
```

Point liveness probes at `GET /healthz`, and readiness probes at `GET /readyz`, which also checks the database. A bind-mounted data directory must be writable by uid 65532. The embedded database opens in one process at a time, so run `bootstrap` while the server is stopped; while it runs, `bootstrap` exits with an error saying so. To run several containers, give them all `ORGANIZATION_DATABASE_URL` instead ([storage and high availability](#storage-and-high-availability)).

Always run it behind HTTPS. Tokens and the admin session cookie must not travel in clear text, and the server warns at startup if `ORGANIZATION_BASE_URL` is not `https://` (localhost excepted).

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `ORGANIZATION_BASE_URL` | `http://localhost:<port>` | Public URL; used for SSO redirect URIs, device-login links and cookie scope |
| `ORGANIZATION_PORT` | `8787` | Listen port |
| `ORGANIZATION_HOST` | `0.0.0.0` | Listen address |
| `ORGANIZATION_DATABASE_URL` | unset | A PostgreSQL server to keep everything in, as `postgres://user:password@host:5432/database`. Needed for more than one replica. Unset, the server uses its embedded database |
| `ORGANIZATION_DATABASE_POOL` | `10` | Connections each server opens to `ORGANIZATION_DATABASE_URL` |
| `ORGANIZATION_DATA` | `./data` | Data directory. The embedded database lives in `postgres/` inside it |
| `ORGANIZATION_BACKUP_DIR` | `<ORGANIZATION_DATA>/backups` | Where the embedded database is [backed up](#backups) |
| `ORGANIZATION_BACKUP_HOURS` | `24` | Hours between backups; `0` takes none on a schedule |
| `ORGANIZATION_BACKUP_KEEP` | `7` | Backups to keep |
| `ORGANIZATION_DB` | `<ORGANIZATION_DATA>/enterprise.db` | The SQLite database of earlier versions, copied in on first start ([upgrading](#upgrading-from-sqlite)) |
| `ORGANIZATION_SECRET` | unset | Key material for encrypting SSO client secrets and gateway credentials at rest (AES-256-GCM). Required before SSO or the gateway can be configured; keep it stable |
| `ORGANIZATION_TRUST_PROXY` | unset | How many reverse proxies stand in front of the server (`true` for one). Audit entries and [rate limits](#rate-limits) then take the client's address from `X-Forwarded-For`, that many entries from its end |
| `ORGANIZATION_RATE_LIMIT` | `600` | [Requests a minute](#rate-limits) each token may make; `0` for no limit |
| `ORGANIZATION_RATE_LIMIT_ANONYMOUS` | `300` | Requests a minute each client address may make without a token; `0` for no limit |
| `ORGANIZATION_AUDIT_RETENTION_DAYS` | `365` | Audit history to keep; `0` keeps it forever |
| `ORGANIZATION_MODELS_URL` | `https://models.dev/api.json` | Model price catalog the gateway meters with, as a URL or a local file path in models.dev's format. Empty turns pricing off |
| `ORGANIZATION_LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error`; logs are logfmt on stdout |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | unset | Also send logs and traces over OTLP (HTTP, JSON); `OTEL_EXPORTER_OTLP_HEADERS` adds headers |

The server also reads a `.env` file from its working directory, a convenient place for these settings; keep it readable only by the service account.

## Storage and high availability

Everything is kept in PostgreSQL, embedded in the server or on a PostgreSQL server.

**Embedded (the default).** Without `ORGANIZATION_DATABASE_URL`, the server runs Postgres in its own process ([PGlite](https://pglite.dev), Postgres compiled to WebAssembly), with its files in `ORGANIZATION_DATA/postgres`. There is nothing else to install. It is for one server: the directory is locked while the server has it open, so a second server, or a `bootstrap` while the server runs, exits with an error instead of corrupting it. A commit is on disk before the request that made it completes. The server [backs it up](#backups) itself.

**A PostgreSQL server, for high availability.** Point every server at the same database with `ORGANIZATION_DATABASE_URL` (PostgreSQL 14 or later; a managed service such as Amazon RDS, Cloud SQL or Azure Database for PostgreSQL works), give them all the same `ORGANIZATION_SECRET` and `ORGANIZATION_BASE_URL`, and put them behind a load balancer that checks `GET /readyz`. Back up and replicate the database with your usual Postgres tooling.

- Any server handles any request, with no session affinity. Sign-ins keep their state in the database, so an SSO sign-in or a device login can start on one server and finish on another.
- Servers apply database migrations as they start, one at a time under an advisory lock, so they can start together. A server that can't reach or open its database exits at startup with the reason.
- Each audit stream is delivered by one server at a time, which holds a one-minute lease on it. If that server stops in the middle of a delivery, another sends the batch again when the lease runs out. Audit events get their ids in commit order, so a stream never passes over one that commits late.
- Checks that guard a write, such as keeping an organization's last owner, run in one transaction under a database-wide lock, so two servers can't both pass them.

### Backups

A server on the embedded database backs it up itself: every 24 hours (`ORGANIZATION_BACKUP_HOURS`), before an upgrade migrates it, and when it receives `SIGUSR2` (`docker kill --signal=USR2 <container>`, `systemctl kill -s USR2 <unit>`, or on Kubernetes `kubectl debug -it <pod> --image=busybox --target=<container> -- kill -USR2 1`). Backups go to `ORGANIZATION_BACKUP_DIR`, `backups/` in the data directory unless set, which keeps the newest 7 (`ORGANIZATION_BACKUP_KEEP`). Each one is a gzipped tarball of the database's files at one moment, readable only by the server's user, and holds everything the server keeps: its secrets sealed with `ORGANIZATION_SECRET`, the audit log and usage. Requests wait while one is taken, about a tenth of a second for a small database. Copy backups somewhere else too, such as object storage: one on the database's own volume doesn't survive losing it.

With the server stopped, `organization-server backup [--out <file>]` takes one, and `organization-server restore <file>` replaces the database with one. A restore checks the file is a backup of this database first, and moves the database it replaces aside instead of deleting it. When the server starts on a backup from an earlier version, it migrates it as on any upgrade. To move to a PostgreSQL server from a backup, restore it, then [move](#moving-to-a-postgresql-server).

A PostgreSQL server is backed up with its own tools: `pg_dump`, or a managed service's snapshots and point-in-time recovery.

### Upgrading from SQLite

Earlier versions were named `enterprise-server`, read `ENTERPRISE_*` settings, and kept everything in a SQLite file (`ENTERPRISE_DB`, by default `data/enterprise.db`). Rename the settings to `ORGANIZATION_*` (`ENTERPRISE_DB` becomes `ORGANIZATION_DB`); the server refuses to start while any `ENTERPRISE_*` setting is left. Then stop the old server and start the new one with the same data directory. On its first start on an empty database, the new server copies every row in, keeping ids so audit streams resume where they stopped, logs `copied the SQLite database into Postgres`, and leaves the file as it was. With `ORGANIZATION_DATABASE_URL` set, the rows go to the PostgreSQL server instead.

### Moving to a PostgreSQL server

Stop the server, then start it with `ORGANIZATION_DATABASE_URL` pointing at an empty database and the same `ORGANIZATION_DATA`. On its first start it copies the embedded database into the PostgreSQL server, logs `copied the embedded database into the Postgres server`, and leaves the embedded files as they were. Then start the other servers.

## Connecting clients

Deploy `organization.json` to each developer machine with your MDM:

| OS | Path |
|---|---|
| Linux | `/etc/kilo/organization.json` |
| macOS | `/Library/Application Support/kilo/organization.json` |
| Windows | `%ProgramData%\kilo\organization.json` |

```json
{ "url": "https://ai.acme.com", "org": "acme", "required": true }
```

Developers then run `kilo org login`, which opens the browser for SSO. The VS Code and JetBrains extensions run the same CLI underneath and pick up the same sign-in, provided they are built from this fork. The marketplace builds of upstream Kilo don't contain these features. Other commands: `kilo org status`, `kilo org policy`, `kilo org logout`. With `required: true` (the default for a managed file) the agent refuses to run until the user has signed in and a policy is loaded.

Without a managed file, `KILO_ORG_URL`, `KILO_ORG` and optionally `KILO_ORG_TOKEN` (for CI) do the same. A managed file always wins over the environment. Devices and CI set up before the rename keep working: a managed `enterprise.json` applies while no `organization.json` exists, and the `KILO_ENTERPRISE_*` variables while their `KILO_ORG*` counterparts are unset. Stored sign-ins don't carry over, so people run `kilo org login` once more.

See [FORK.md](../../FORK.md) for exactly where the client enforces each policy.

## Single sign-on

Each org connects one identity provider, with OpenID Connect or SAML 2.0. People sign in to the console with it, and approve CLI and IDE device logins with it.

### OpenID Connect

1. Set `ORGANIZATION_SECRET` on the server.
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

Client-side enforcement stops honest mistakes, but a person with an API key can always use it from some other tool. The gateway closes that gap for the providers it routes: the organization's credentials stay on the server, and people reach the provider only through it.

1. Set `ORGANIZATION_SECRET`, then add providers under Governance → LLM gateway, or with `PUT /api/v1/orgs/{org}/gateway/providers/{id}` and `{ "kind": "anthropic", "base": "https://api.anthropic.com/v1", "key": "sk-ant-..." }`. `base` includes the API version path.
2. Signed-in clients pick the routes up with the policy. Each routed provider's requests go to `<server>/gateway/<id>/...` with the person's organization token as the API key; nobody needs, or sees, the provider's credentials.
3. Turn on **Only allow gateway providers** (`"gateway": { "exclusive": true }` in the policy) and clients refuse every other provider.

A provider id clients already know (`anthropic`, `openai`, `openrouter`, ...) routes that provider; its models and prices come from the models.dev catalog. Any other id defines a provider of its own: give it a `name` and its `models`, and clients list them under that name.

| `kind` | Clients speak | Relayed endpoints | Metered from |
|---|---|---|---|
| `anthropic` | Anthropic Messages | `POST /messages`, `POST /messages/count_tokens`, `GET /models` | `usage` in the message, or `message_start` and `message_delta` events |
| `openai` | OpenAI | `POST /responses`, `POST /chat/completions`, `GET /models` | `usage` in the response, or the `response.completed` event |
| `openai-compatible` | OpenAI Chat Completions | `POST /chat/completions`, `GET /models` | the final chunk's `usage`; the gateway adds `stream_options.include_usage` to streamed calls |
| `bedrock` | Anthropic Messages | `POST /messages`; `GET /models` from the provider's model list | Claude's own usage events, translated from Bedrock's event stream |
| `vertex` | Anthropic Messages | `POST /messages`, `POST /messages/count_tokens`; `GET /models` from the model list | Claude's own usage events |

### Credentials, headers and query parameters

`auth` says how the gateway signs in upstream; `key` carries the secret, which is stored encrypted and never returned. Changing to another kind of credential needs its secret again.

| `auth` | Sends | Secret (`key`) |
|---|---|---|
| `{ "type": "bearer" }` (default, except as below) | `Authorization: Bearer <key>` | API key |
| `{ "type": "header", "name": "x-api-key" }` (default for `anthropic`) | the key in that header | API key |
| `{ "type": "none" }` | nothing | none |
| `{ "type": "aws", "region": "us-east-1", "access_key": "AKIA..." }` | an AWS Signature Version 4 | the secret access key |
| `{ "type": "google" }` (default for `vertex`) | a Google access token, exchanged and cached | the service account's JSON key |

`headers` adds headers to every call, such as another gateway's own key; their values are encrypted too, and an update that leaves `headers` out keeps them. `query` adds query parameters, such as Azure's `api-version`.

Examples:

- **LiteLLM**, vLLM, Ollama or any OpenAI-compatible server: `{ "kind": "openai-compatible", "base": "https://litellm.example.com/v1", "key": "<virtual key>", "name": "LiteLLM", "models": [{ "id": "claude-sonnet" }, { "id": "gpt-4o-mini" }] }`. **Import from upstream** in the console fills `models` from the server's own `/models` list (`POST .../providers/{id}/discover`). LiteLLM's `x-litellm-response-cost` header prices the calls it reports.
- **Portkey** or **Cloudflare AI Gateway**: the same, with the gateway's own key in `headers` (`x-portkey-api-key`, `cf-aig-authorization`).
- **Azure OpenAI**: `{ "kind": "openai", "base": "https://<resource>.openai.azure.com/openai/v1", "auth": { "type": "header", "name": "api-key" }, "key": "<key>", "models": [{ "id": "<deployment>" }] }`. Use an id other than `azure`, which is the client's own Azure provider.
- **Claude on Amazon Bedrock**: `{ "kind": "bedrock", "base": "https://bedrock-runtime.us-east-1.amazonaws.com", "auth": { "type": "aws", "region": "us-east-1", "access_key": "AKIA..." }, "key": "<secret access key>", "models": [{ "id": "us.anthropic.claude-sonnet-4-5-20250929-v1:0", "context": 200000, "cost": { "input": 3, "output": 15 } }] }`. A Bedrock API key works too, as `{ "type": "bearer" }`. The IAM user needs `bedrock:InvokeModel` and `bedrock:InvokeModelWithResponseStream`.
- **Claude on Google Vertex AI**: `{ "kind": "vertex", "base": "https://us-east5-aiplatform.googleapis.com/v1/projects/<project>/locations/us-east5", "key": "<service account JSON>", "models": [{ "id": "claude-sonnet-4-5@20250929" }] }`. The service account needs the Vertex AI User role. Gemini through Vertex's OpenAI-compatible endpoint is an `openai-compatible` provider with `{ "type": "google" }`.

Bedrock and Vertex providers need their model list, since clients don't know their model ids. Clients send Anthropic Messages requests; the gateway moves the model into the URL and the API version and beta flags into the body, signs the call, and turns Bedrock's binary event stream back into Anthropic's server-sent events. Bedrock's and Vertex's errors reach clients as Anthropic error bodies.

### Every call

On every call the gateway checks the token, membership, the [data policy](#data-policy) and the member's effective model policy, refuses with `402` once a budget is spent and with `429` past a rate limit, signs in upstream, and relays the response as it streams. Only content, version, beta and user-agent headers are relayed upstream; only content type, request ids, `retry-after` and rate-limit headers come back. Usage is recorded with `source: "gateway"` when the response ends, including when the client hangs up. Usage clients report for a routed provider is dropped, so nothing counts twice.

**Prices.** A call is priced by the first that applies: the organization's own price for the model (Governance → LLM gateway → Prices, or `PUT /api/v1/orgs/{org}/prices`), what the upstream reports (OpenRouter, LiteLLM), the provider's model list, then `ORGANIZATION_MODELS_URL` with the same arithmetic the CLI uses. An organization price is either rates per million tokens or a discount off the catalog price, for one model or for all of a provider's (`"model": "*"`). Organization prices apply to usage clients report as well.

**Rate limits.** `"gateway": { "limits": { "requests": 60, "tokens": 400000 } }` in the policy caps each member per minute; tokens count input and output, cache and reasoning included. The counts live in the database, so every replica enforces the same totals. A call past a limit gets `429` with `retry-after`.

**Call log.** Every call is logged, refused ones too: who made it, the model, the status and the reason the gateway refused it, tokens, cost and time taken (Insight → Gateway call log, or `GET /api/v1/orgs/{org}/gateway/calls`). With `"gateway": { "log": { "bodies": true } }`, the first 64 KB of each request and response are kept too, so admins can read prompts and answers; turn it on only where that is allowed. The log is kept for `log.retention` days, 30 by default.

## Data policy

The data policy decides which providers may see the organization's code and prompts (Governance → Data policy, or `data` in the policy). Admins record each provider's terms as the organization's agreement with it states them, by the provider id clients use:

| Field | Meaning |
|---|---|
| `training` | Whether the provider may train models on prompts and completions |
| `retention` | Days it keeps them; `0` is zero data retention |
| `regions` | Where it processes them, as region codes the organization chooses (`eu`, `us`, `uk`). Empty means not on record |
| `routing` | The provider is an OpenRouter-compatible API that sends each request on to one of many companies (OpenRouter, the Kilo gateway) |
| `note` | Where the terms come from, for the next admin |

Then the filters: `"training": "denied"` refuses providers that may train on the data, `"retention": "zero"` refuses providers that keep any, and `regions` refuses providers that process data anywhere else. With any filter on, only providers whose terms meet every filter can be used, and a provider without recorded terms is refused, so a provider nobody has checked can't slip through.

- **Clients** drop the models of refused providers from the model list and refuse requests to them, saying why ("Your organization's data policy doesn't allow openai: it keeps data for 30 days"). The effective policy carries the admitted providers and the reasons.
- **The gateway** refuses calls to a refused provider with `403` and the code `data_policy`, whatever the client does.
- **Routed requests.** For a provider with `routing`, clients and the gateway add OpenRouter's [provider routing preferences](https://openrouter.ai/docs/guides/routing/provider-selection) to every request: `data_collection: "deny"` when training is denied and `zdr: true` when retention must be zero, so only endpoints that meet the filters serve it. The client SDKs for OpenRouter, the Kilo gateway and OpenAI-compatible providers send them; the gateway adds them to chat completions and responses calls. Regions can't be routed this way, so a routed provider still needs regions that meet the filter.

The terms are the organization's record, not something the server can check: keep them in step with the agreements.

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
  "gateway": {
    "exclusive": false,
    "limits": { "requests": 60, "tokens": 400000 },
    "log": { "bodies": false, "retention": 30 }
  },
  "data": {
    "training": "denied",
    "retention": "zero",
    "regions": ["eu"],
    "providers": {
      "anthropic": { "training": false, "retention": 0, "regions": ["eu"], "note": "Zero retention addendum" },
      "openrouter": { "training": false, "retention": 0, "regions": ["eu"], "routing": true }
    }
  },
  "audit": { "tools": "summary" }
}
```

- **Model identifiers** are `provider/model` as the client knows them, for example `anthropic/claude-sonnet-4`, or `kilo/anthropic/claude-opus-4` for models routed through the Kilo gateway provider. An entry without a slash means the whole provider; `*` matches any characters, including `/`.
- **`models.blocked`** is the org-wide ceiling. Nothing granted anywhere can get past it.
- **`models.default`** applies to everyone, and each group can carry its own grant. A person's effective access is the ceiling intersected with the union of the default and their groups' grants. If none of these is set, access is unrestricted below the ceiling.
- **MCP rules** match the server's target, its URL or its full command line, never its name, because users choose names freely.
- **`permission`** uses the same format as the CLI's `permission` config. Deny rules become hard rules; allow and ask rules override user config but not a user's session approvals.
- **`share`** controls session sharing and syncing sessions to the upstream vendor's cloud. **`telemetry.product`** controls the upstream product analytics. Both default to off.
- **`data`** is the [data policy](#data-policy): filters on training, retention and regions, and each provider's recorded terms.
- **`audit.tools`** has clients add each tool the agent runs to the audit log: `summary` or `inputs` (see [agent tool runs](#agent-tool-runs)). `off`, the default, logs none.
- **`gateway.exclusive`** makes clients refuse every provider the [LLM gateway](#llm-gateway) does not route. **`gateway.limits`** caps each member's gateway requests and tokens per minute, and **`gateway.log`** sets whether the call log keeps bodies and for how many days.

Budgets are managed separately (Governance → Budgets or `PUT /api/v1/orgs/{org}/budgets`), in US dollars over UTC `day`s or `month`s:

| `scope` | `target` | Caps |
|---|---|---|
| `org` | | Everyone's spend, sub-organizations' included |
| `member` | | Each person's spend: the default per-person cap |
| `user` | user id | One person's spend, in place of `member` |
| `group` | group id | What a group's members spend together |
| `suborg` | sub-organization id | A sub-organization's spend: the allowance its parent gives it, which its own admins can't change |

A sub-organization is bound by its own budgets, by its parent's `org` budget and by the allowance its parent gives it. `GET /api/v1/orgs/{org}/budgets` returns each budget with what this period has spent against it, and, for a sub-organization, the parent's budgets that bind it.

**Seats.** `PATCH /api/v1/orgs/{org}` with `{ "seats": 50 }` (owners, top-level organizations only; `null` for no limit) caps how many people hold a seat: an active membership in the organization or any of its sub-organizations, counted once per person. Suspended members hold none. Once the seats are taken, adding a member, accepting an invite, signing in through single sign-on for the first time, and SCIM creating or reactivating a user are all refused, SCIM with a `403`. `GET /api/v1/orgs/{org}` reports `seats: { limit, used }`.

## Audit streaming

Under Insight → Audit streaming (or `POST /api/v1/orgs/{org}/audit/streams`), owners and admins add destinations that receive every new audit event. A stream starts with the events recorded after it is created, its own creation first; older history is in the CSV export.

- **Webhook**: a `POST` of `{ "org": { "id", "slug", "name" }, "events": [...] }`, up to 200 events per request. Each event is the audit API's event plus an ISO `time`. An optional header, such as Splunk HEC's `Authorization: Splunk <token>`, is stored encrypted. Every delivery carries `x-org-delivery` (a unique id) and `x-org-signature: t=<unix seconds>,v1=<hex>`, where the hex is the HMAC-SHA256 of `<t>.<raw body>` keyed with the stream's signing secret, which is shown once when the stream is created. Compare signatures in constant time, and reject timestamps more than a few minutes old. Any 2xx response accepts the batch; redirects are not followed.
- **Syslog**: one RFC 5424 message per event over TCP, TLS by default (RFC 5425), with RFC 6587 octet-counting framing: facility 13 (log audit), severity informational, `APP-NAME` `kilo-organization`, `MSGID` the action, and the event as JSON in the message.
- **OpenTelemetry**: OTLP/HTTP log export in [JSON encoding](https://opentelemetry.io/docs/specs/otlp/#json-protobuf-encoding), posted to a collector's logs endpoint, usually `https://<collector>:4318/v1/logs`. An OpenTelemetry Collector's `otlp` receiver takes it and forwards it wherever the collector exports; backends that accept OTLP/HTTP with JSON directly work too. Each delivery is one resource (`service.name` `kilo-organization`, plus `kilo.org.id`, `kilo.org.slug` and `kilo.org.name`) with one log record per event: its time, severity `INFO`, the event as JSON in the body, and the attributes `event.name` (the action), `kilo.audit.id`, `user.id`, `user.email`, `kilo.audit.target` and `client.address`. Deliveries aren't signed; collectors authenticate with a header, such as `Authorization: Bearer <token>`, stored encrypted. Records a collector accepts the batch but refuses (an OTLP partial success) are logged on the server and not sent again.

Events are delivered in order and at least once, so receivers can use the event `id` to drop the rare duplicate. A failing destination is retried with backoff, from 5 seconds up to every 5 minutes, and resumes exactly where it stopped. Its error shows on the stream until it recovers, and pausing a stream keeps its place. "Send test" sends a synthetic `audit.stream_test` event (id `0`) without affecting delivery. With several servers, one at a time delivers each stream (see [high availability](#storage-and-high-availability)).

## Agent tool runs

With `audit.tools` set in the policy (Insight → Audit log, or the policy JSON), the CLI and the IDE extensions add each tool call the agent finishes to the audit log, as a `client.tool_run` event attributed to the person whose client ran it. The event's target is the tool, and its details:

| Field | |
|---|---|
| `tool` | `bash`, `read`, `edit`, `webfetch`, an MCP server's tool, and so on |
| `outcome` | `completed`, or `error` when the tool failed or the person refused to let it run |
| `duration_ms` | How long it ran |
| `session`, `project` | The session id, and the name of the project's folder |
| `subject` | What it acted on: a file or folder (relative to the project), the site a URL is on (`https://docs.example.com`, never the rest of the URL), or the program a command runs (`git`, never its arguments) |
| `error` | Why it failed, up to 1,000 characters |
| `input` | With `inputs` only: the tool's input as JSON, up to 4,000 characters, such as a whole command line or the text written to a file |

Clients send them in batches every 15 seconds, keep them on disk while the server can't be reached, and can resend safely: each is recorded once. The server keeps only what the policy asks for, whatever a client sends, and streams them like every other event. They can be numerous; the audit retention (`ORGANIZATION_AUDIT_RETENTION_DAYS`) applies to them too. Like the rest of client-side enforcement, they record what an unmodified client reports (see [limits](#limits-of-client-side-enforcement)).

## Analytics and reports

Insight → Analytics shows adoption and comparisons; the same figures come from the API, for dashboards and BI tools. Owners, admins and billing managers can read them, with a token issued for them (`POST /api/v1/orgs/{org}/members/{user}/tokens`).

- `GET /api/v1/orgs/{org}/analytics/adoption?from=2026-09-01&to=2026-10-01&interval=week`: members, seats, people who made a request in the range, those whose first request ever was in it, sessions, requests and spend, interval by interval (`day`, `week` from Monday or `month`, in UTC; chosen from the range when omitted), and the members who made no request, with when they last did.
- `GET /api/v1/orgs/{org}/analytics/compare?by=group&from=...&to=...`: each group (`group`), the organization and each sub-organization (`suborg`), or each model (`model`), with people, requests, tokens and spend in the range and in the range of the same length before it.

`from` and `to` take dates or epoch milliseconds, and default to the last 30 days.

**Scheduled reports** (Insight → Scheduled reports, or `/api/v1/orgs/{org}/reports`) post a summary an hour after each week (Monday to Sunday) or month ends, in UTC: spend and how it moved on the period before, requests, how many members used Kilo and how many for the first time, and the top five models and spenders. `"format": "text"` posts `{ "text": ... }`, which Slack, Mattermost and Google Chat incoming webhooks show as a message; `"format": "json"` posts the whole summary. Deliveries are signed like audit stream webhooks with a secret shown once at creation, never follow redirects, and are retried every 15 minutes until they succeed or the next period's report replaces them. `POST /api/v1/orgs/{org}/reports/{id}/send` sends the last whole period's report now.

## Audit events

`audit.stream_create`, `audit.stream_remove`, `audit.stream_update`, `budget.update`, `client.tool_run`, `custom_mode.create`, `custom_mode.delete`, `custom_mode.update`, `domain.create`, `gateway.provider_create`, `gateway.provider_remove`, `gateway.provider_update`, `group.create`, `group.delete`, `group.update`, `member.add`, `member.change_role`, `member.remove`, `organization.create`, `organization.settings_change`, `policy.update`, `price.update`, `report.create`, `report.delete`, `report.update`, `scim.group_create`, `scim.group_delete`, `scim.group_update`, `scim.token_create`, `scim.token_revoke`, `scim.user_activate`, `scim.user_create`, `scim.user_deactivate`, `scim.user_delete`, `scim.user_update`, `sso.auto_provision`, `sso.remove`, `sso.remove_domain`, `sso.set_domain`, `sso.update`, `token.create`, `token.revoke`, `user.accept_invite`, `user.login`, `user.logout`, `user.revoke_invite`, `user.send_invite`.

Each entry records time, action, actor (user and email snapshot), target, details (for example the role before and after, or the models added to the blocklist) and client IP.

## API

All endpoints take `Authorization: Bearer <token>` and return JSON. The contract is defined once in [`packages/organization-protocol`](../organization-protocol) and served as OpenAPI at `GET /api/v1/openapi.json`; the CLI and the admin console use clients derived from it. Errors are `{ "_tag": "...", "message": "..." }` with the matching HTTP status.

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
| `/api/v1/orgs/{org}/audit/streams`, `/audit/streams/{id}`, `/audit/streams/{id}/test` | Audit streams (webhook, syslog and OTLP destinations) |
| `POST /api/v1/orgs/{org}/audit/tools` | [Agent tool runs](#agent-tool-runs) a client reports, kept as `audit.tools` says |
| `/api/v1/orgs/{org}/usage`, `/usage/export` | Usage ingestion, breakdowns and CSV export |
| `/api/v1/orgs/{org}/analytics/adoption`, `/analytics/compare` | [Analytics](#analytics-and-reports) |
| `/api/v1/orgs/{org}/reports`, `/reports/{id}`, `/reports/{id}/send` | Scheduled reports |
| `/api/v1/orgs/{org}/budgets` | Budgets |
| `/api/v1/orgs/{org}/gateway`, `/gateway/providers/{id}` | LLM gateway providers (keys are write-only) |
| `/gateway/{provider}/...` | The gateway itself; speaks each provider's own API, with an organization token as the API key |
| `/api/v1/orgs/{org}/sso`, `/sso/saml`, `/domains`, `/scim/tokens` | Identity configuration: `PUT /sso` saves OpenID Connect, `PUT /sso/saml` saves SAML 2.0 |
| `/sso/saml/{org}/metadata`, `/sso/saml/{org}/acs` | SAML service provider metadata, and where the identity provider posts responses |
| `/api/v1/orgs/{org}/suborgs` | Sub-organizations |
| `/scim/v2/...` | SCIM 2.0 |
| `GET /healthz` | Liveness |
| `GET /readyz` | Readiness: the server and its database answer |

## Security model

- Bearer tokens are random 256-bit values, stored only as SHA-256 hashes, prefixed (`korg_`, `korgs_`) so secret scanners can find leaked ones, revocable, and expiring (90 days for CLI logins, 8 hours for browser sessions).
- **Every token is bound to the organization it was issued for**, and reaches only that org and its sub-orgs. An org's admins configure that org's identity provider, so an identity asserted through it must never carry into another org that happens to share the person. The test suite includes this attack.
- Deactivating a user revokes all of their tokens at once. Suspended memberships grant nothing.
- SSO client secrets, gateway API keys, and audit streams' signing secrets and headers are encrypted at rest. The API never returns them; for a gateway key it shows only the last four characters. The gateway relays only its providers' chat endpoints and never follows upstream redirects, so an org key cannot be used for anything else or sent to another host.
- Invite and device codes are single-use, and device codes expire after 10 minutes.
- SAML responses must be signed by the org's identity provider and name it as their issuer: the server checks the issuer itself, so an identity provider that signs for several tenants with one key can't sign in for another org. Assertions are remembered until they expire, so a captured response can't be replayed.
- The browser session cookie is `HttpOnly`, `Secure` on HTTPS, and `SameSite=Lax`. Every cookie-authenticated write must carry a same-origin `Origin` header.
- The admin console is served with a strict Content Security Policy and renders all data as text.
- CSV exports neutralise spreadsheet formulas.

## Rate limits

Each token may make 600 requests a minute (`ORGANIZATION_RATE_LIMIT`), and each client address 300 without one (`ORGANIZATION_RATE_LIMIT_ANONYMOUS`), a minute's worth at once at most. Beyond that, requests get a `429` with `Retry-After`: in the API's error format, in SCIM's for identity providers, and as a page in the browser. Health checks, the console's files and the [LLM gateway](#llm-gateway) aren't counted; the policy's `gateway.limits` sets the gateway's per-member limits. Each server counts on its own, so with several behind a load balancer a client can reach the limit on each.

Behind a reverse proxy, set `ORGANIZATION_TRUST_PROXY` to how many proxies there are, or every client shares the proxy's address. Each proxy appends the address it saw to `X-Forwarded-For`, so the server reads the client's that many entries from the end and never trusts the entries before it, which the client wrote itself.

The page where people enter a device sign-in code also allows each address 20 wrong codes in 10 minutes (RFC 8628 §5.1): plenty for typos, nothing like the billions a guesser would need.

## Limits of client-side enforcement

The CLI enforces policy on the developer's machine. That stops honest mistakes and policy drift, but a user who controls their machine can always run some other tool with their own API key. For providers routed through the [LLM gateway](#llm-gateway), model access, budgets and usage metering hold on the server instead: people never hold the key. What the gateway cannot control is a provider account someone pays for themselves; block that provider in `models.blocked` and, if you need it enforced on the network, at your egress proxy.

## Development

```sh
bun test                    # unit and integration tests on an in-memory Postgres, including a local OIDC provider and SAML-signed responses
bun run typecheck
bun run migration           # after changing src/db/schema.sql.ts; --check fails when one is missing
bun run build               # dist/organization-server with the console embedded
```

The server is built on the same stack as the Kilo CLI's own server:

| Concern | Where |
|---|---|
| HTTP API | `effect/unstable/httpapi`: the shared contract in `packages/organization-protocol`, handlers in `src/handlers/`, auth and org scoping as middleware in `src/middleware/` |
| Browser flows | Device approval and SSO pages in `src/routes/`, the console's static files in `src/routes/console.ts` |
| Storage | Drizzle on PostgreSQL (`drizzle-orm/effect-postgres` over `@effect/sql-pg`), schema in `src/db/schema.sql.ts`, generated TypeScript migrations in `src/db/migration/`; the embedded database is PGlite behind the same client (`src/db/embedded.ts`), and earlier data is copied in by `src/db/legacy.ts` |
| Services | Effect services wired as a `LayerNode` graph (`src/app.ts`); configuration through Effect `Config` (`src/config.ts`) |
| Observability | Effect logging (logfmt) and OTLP export (`src/observability.ts`) |
