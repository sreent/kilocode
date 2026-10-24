# About this fork

This repository is a fork of [Kilo Code](https://github.com/Kilo-Org/kilocode), the open-source AI coding agent, which is itself a fork of [OpenCode](https://github.com/anomalyco/opencode). On top of upstream it adds **self-hosted organizations**: single sign-on, SCIM, organization policy (model, MCP and tool-permission controls), org-managed agents, an LLM gateway, audit logs and streaming, usage analytics and budgets. They are standard features of this Kilo Code, not a separate enterprise tier.

Upstream Kilo offers similar features in its hosted Enterprise plan, on a backend that is not open source. The open-source repository contains only the clients (CLI, VS Code extension, JetBrains plugin), so this fork implements both sides itself:

- **Organization server**: [`packages/organization-server`](packages/organization-server/README.md), a server you run (Postgres, embedded or on a PostgreSQL server for high availability; ships as a single binary with the admin console inside).
- **Admin console**: [`packages/organization-console`](packages/organization-console), the web UI the server hosts at `/admin`.
- **Contract**: [`packages/organization-protocol`](packages/organization-protocol), the API definition, schemas and role model shared by the server, the CLI and the console.
- **Client integration**: [`packages/opencode/src/organization`](packages/opencode/src/organization), which makes the CLI, and therefore the IDE extensions that run it, fetch and enforce the org policy.

## Provenance and license

- Imported from Kilo-Org/kilocode release `v7.8.17` (commit `eb11204e8f`) **with full git history**, so upstream releases can be merged normally (see [Keeping up with upstream](#keeping-up-with-upstream)).
- Upstream is MIT licensed (Copyright (c) 2026 Kilo Code, Copyright (c) 2025 opencode). `LICENSE` is unchanged and must stay with every copy. New code in this fork is also MIT; add your own copyright line to `LICENSE` if you want one.

## Trademarks and distribution

MIT covers the code, not names or logos. "Kilo" and "Kilo Code" identify Kilo's products. Before you publish builds (the CLI on npm, the VS Code Marketplace, the JetBrains Marketplace, installers), rebrand them so users can't confuse your distribution with Kilo's, and drop any claim of Kilo affiliation.

Where the branding lives:

- Binary name `kilo`, npm package `@kilocode/cli`
- VS Code publisher `kilocode` / extension `kilo-code`
- The managed config directory `/etc/kilo` and the macOS MDM domain `ai.opencode.managed`
- Roughly 90 hard-coded `kilo.ai` / `app.kilo.ai` URLs across the CLI, webview, core, gateway and JetBrains code

Do the rename as one scripted change, like upstream's `script/upstream/transforms`, so it can be re-applied after each merge.

Organization features only work in builds made from this repository. The marketplace builds of upstream Kilo don't contain the client integration.

## What's fork-owned

| Path | Contents |
|---|---|
| `packages/organization-protocol/` | Shared contract: HTTP API groups, schemas, errors, middleware tags, role capabilities, typed client |
| `packages/organization-server/` | Organization server: API, SSO, SCIM, policy, gateway, audit, usage, budgets, tests |
| `packages/organization-console/` | Admin console |
| `packages/opencode/src/organization/` | Client: deployment settings, policy fetch and cache, enforcement, usage reporting, `kilo org` command |
| `packages/opencode/test/organization/` | Contract tests that run the client against the real organization server |
| `FORK.md` | This file |

Changes to upstream files are kept to one-line calls into the organization module. They use upstream's own `kilocode_change` markers, which upstream's annotation check (`script/check-opencode-annotations.ts`) requires, tagged `organization` to tell them apart from Kilo's changes: `// kilocode_change - organization`, `// kilocode_change start - organization: <why>` / `// kilocode_change end`, and `// kilocode_change - new file (organization)` atop fork-owned files in shared directories. `git grep -n "kilocode_change.*organization"` lists every one:

| Upstream file | Hook |
|---|---|
| `packages/opencode/src/config/config.ts` | Apply the org policy as the last config layer, above user, project, managed and env config |
| `packages/opencode/src/provider/provider.ts` | Drop models outside the user's effective model access |
| `packages/opencode/src/mcp/index.ts` | Refuse MCP servers outside the allowlist or on the blocklist; every connection path passes here |
| `packages/opencode/src/permission/index.ts` | Add org deny rules to the hard ruleset of every permission ask |
| `packages/opencode/src/plugin/index.ts` | Always load the organization plugin, even with `KILO_DISABLE_DEFAULT_PLUGINS` |
| `packages/opencode/src/effect/app-runtime.ts`, `packages/opencode/src/server/routes/instance/httpapi/server.ts` | Register the `Organization` service in the CLI's and the local server's layer graphs |
| `packages/opencode/src/kilocode/cli/setup.ts` | Startup switches (product analytics, sharing, vendor session sync); register `kilo org` |
| `packages/opencode/src/kilocode/cli/bootstrap-runtime.ts` | Load the org policy before the first instance starts |
| `packages/opencode/src/kilocode/cli/lazy-kilo-commands.ts` | Lazy loader for `kilo org` |
| `packages/opencode/src/kilocode/server/httpapi/handlers/telemetry.ts` | Stop the runtime telemetry toggle from re-enabling analytics the org turned off |
| `packages/opencode/src/kilo-sessions/kilo-sessions.ts` | Keep sessions from syncing to the upstream vendor's cloud unless the org allows sharing |

`packages/opencode/package.json` also depends on `@organization/protocol`.

## How it's built

The organization features use the same stack and conventions as the rest of Kilo, so it reads like upstream code and moves with it:

| Concern | Core Kilo | Organization features |
|---|---|---|
| HTTP API | `effect/unstable/httpapi` contract, handlers and middleware (`packages/opencode/src/server`) | One contract in `packages/organization-protocol`, served by `HttpApiBuilder` in the organization server and called through `HttpApiClient` by the CLI and the console |
| Schemas | Effect Schema | Effect Schema, shared by all three; the console validates edits with the same schemas the server enforces |
| Storage | Drizzle on SQLite, generated TypeScript migrations (`packages/core`) | Drizzle on Postgres through Effect's SQL client, with the same generated TypeScript migrations: embedded with PGlite for one server, or a PostgreSQL server for several |
| Services | Effect services in a `LayerNode` graph | The organization server is a `LayerNode` graph; the CLI's `Organization` service is one more node in the CLI's graph |
| Configuration and logs | Effect `Config`, Effect logging, OTLP | The same |
| Web UI | SolidJS + Vite on `@kilocode/kilo-web-ui` (`packages/kilo-console`) | The admin console reuses the web console's shell, page anatomy, components and themes |
| Tests | `bun test`, Effect test harness | The same; the CLI's contract tests run against a real organization server |

## How the client enforces policy

| Policy | Enforced at | Notes |
|---|---|---|
| Sign-in required | Before every LLM request | Set by a managed `organization.json`; users can't remove it without admin rights on their machine |
| Model access | Model list at load time, and again before every request | A request to a newly blocked model is refused even before the list refreshes |
| MCP allow/block | Every MCP connection | Matched on the server URL or command line, not its name |
| Tool permission denies | Hard ruleset, plus the config layer | No saved approval, session rule or "allow everything" mode overrides them |
| Org agents, org MCP servers, sharing, analytics | Last config layer | Org agents are marked `source: organization` |
| Vendor session sync | Wherever a session would leave the machine for the vendor's cloud | Off unless the org sets `share: allowed`; also off while no policy is loaded |
| Org rules | System prompt of every request | |
| Budgets | Before every request | Spend refreshes after each usage upload |
| Usage | Each LLM call (step) | Batched every 15 s, spooled to disk when offline, de-duplicated by the server |
| Gateway providers | Last config layer | Their base URL becomes `<server>/gateway/<id>` and their API key the organization token; a provider clients don't know (LiteLLM, Claude on Bedrock or Vertex) is defined from the name and models the server sends; with `gateway.exclusive`, every other provider is refused |

The policy is fetched at startup (waiting at most 5 s), refreshed every 5 minutes with an ETag, and cached on disk.

- **Offline:** a cached policy keeps applying for up to 7 days. After that it's treated as missing, so cutting off the organization server can't pin a lenient old policy.
- **Revoked tokens and suspended members:** the policy is dropped immediately rather than kept stale.

Client-side enforcement guards against mistakes and drift, not against a user who controls their own machine and runs some other tool. For providers routed through the organization server's [LLM gateway](packages/organization-server/README.md#llm-gateway), the server enforces model access, budgets and rate limits on every call, meters usage itself and logs each call, because only the server holds the provider credentials. The gateway reaches Anthropic, OpenAI, Azure OpenAI, any OpenAI-compatible server or gateway (LiteLLM among them), and Claude on Amazon Bedrock and Google Vertex AI.

### Client configuration

| Source | Example | Precedence |
|---|---|---|
| Managed file (MDM) | `/etc/kilo/organization.json` → `{"url": "https://ai.acme.com", "org": "acme", "required": true}` | Highest; can't be overridden |
| Environment | `KILO_ORG_URL`, `KILO_ORG`, `KILO_ORG_TOKEN` (CI), `KILO_ORG_REQUIRED=1` | |
| Stored login | Written by `kilo org login` (mode 0600) | |

With none of these present, every hook is a no-op and the CLI behaves exactly like upstream.

Settings from before these features were renamed still apply: a managed `enterprise.json` while no `organization.json` exists, and each `KILO_ENTERPRISE_*` variable while its `KILO_ORG*` counterpart is unset, so devices and CI set up earlier stay enrolled. Stored sign-ins don't carry over: people run `kilo org login` once more. `KILO_ORG_ID` and `kilo orgs` are unrelated: they select an organization on Kilo's hosted service.

### Signing in from the IDEs

People sign in from their IDE's profile: the Profile page in VS Code, and Settings → Tools → Kilo → User Profile in JetBrains IDEs. Both show the organization, who is signed in, the policy version, gateway providers and why the agent is blocked, and sign in with the same device code as `kilo org login`. On a device that isn't enrolled, a small link on the same page connects to an organization. Both drive the CLI's `/kilo/org` routes, and a sign-in or sign-out reloads the providers, models and agents the policy shapes.

JetBrains builds use Kilo's released CLI unless built with `-Pkilo.cli.pinned=false`. That CLI has no organization routes, so the section stays hidden until the plugin pins or bundles this fork's CLI (see [Trademarks and distribution](#trademarks-and-distribution)).

## Keeping up with upstream

Fresh clones need the remote once: `git remote add upstream https://github.com/Kilo-Org/kilocode.git`.

```sh
git fetch upstream --tags
git merge v7.9.0                      # or upstream/main
git grep -n "kilocode_change.*organization"   # check each hook still sits where it should
git lfs fetch upstream HEAD           # LFS files of the merged tree (screenshot baselines, videos)
git lfs push --object-id origin $(git lfs ls-files -l | cut -d' ' -f1)   # upload the ones the fork lacks
bun install                           # regenerates bun.lock; on a bun.lock conflict take upstream's, then re-run
(cd packages/organization-protocol && bun test)
(cd packages/organization-server && bun test && bun run typecheck)
(cd packages/organization-console && bun run typecheck && bun run build)
(cd packages/opencode && bun run typecheck && bun test ./test/organization)
(cd packages/opencode && bun run --conditions=browser src/index.ts generate > /dev/null)  # catches import cycles typecheck can't
```

Because all new code lives in fork-owned directories, merges normally touch only the marked hooks above. The organization packages depend on upstream's `effect`, `@opencode-ai/core` and `@kilocode/kilo-web-ui`, so an upstream change to those can surface as a typecheck error in them; the commands above catch it.

## CI

The import brought upstream's GitHub Actions workflows along. Two adjustments make the pull-request checks work in this repository:

- **Runners:** `test.yml` runs on GitHub-hosted runners (`ubuntu-24.04`, `windows-2025`, `macos-15`) instead of Kilo's private Blacksmith runners, which this repository can't use. Fork-only CI settings are marked `kilocode_change - fork`. The other workflows that target Blacksmith are guarded with `github.repository == 'Kilo-Org/kilocode'` and skip themselves here.
- **Git LFS:** the screenshot baselines and videos are stored in this repository's own LFS storage. Pushing upstream history doesn't upload them, because husky replaces git-lfs's `pre-push` hook, so upload them after each merge (see the commands above). Without them, the Visual Regression checks fail at checkout.

Still open, and yours to decide before the fork lands on `main`:

- **Missing secrets:** release and publish workflows need Kilo's secrets.
- **Scheduled bots:** stale-PR, auto-close, community sweep and beta releases run on a schedule from the default branch. Most are guarded like the Blacksmith workflows, but not all.

Turn off the workflows you don't want in the repository's Actions settings, or move them under `.github/workflows/disabled/` (the pattern upstream uses).

The husky `pre-push` hook runs a full monorepo typecheck, then the JetBrains plugin typecheck. The JetBrains step downloads Kilo's pinned CLI release metadata from the GitHub API. Where that API is unreachable, `./gradlew typecheck -Pkilo.cli.pinned=false` checks the plugin against the CLI in this repository instead; build it first with `bun run script/build.ts --single --skip-install` in `packages/opencode`.

## Roadmap

1. **Rebranding and distribution** (see above).
2. **Operations.** A Helm chart, rate limiting, and built-in backups of the embedded database. The container image exists ([`packages/organization-server/Dockerfile`](packages/organization-server/Dockerfile)), and replicas can share a PostgreSQL server ([storage and high availability](packages/organization-server/README.md#storage-and-high-availability)).
3. **SIEM streaming, next steps.** Audit events already stream to webhooks and syslog. Next: OTLP log export, and opt-in audit of client-side events such as tool runs.
4. **Analytics.** Adoption dashboards, team and sub-organization comparisons, scheduled reports, an analytics API.
5. **Live policy reload** of the model list in running clients, without a restart.
6. **Spend management.** Group budgets, distributing funds across sub-organizations, seat management.
7. **Provider data filters.** Filter providers by data policy (training on prompts, retention, region), like Kilo's provider filters.
