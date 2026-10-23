# About this fork

This repository is a fork of [Kilo Code](https://github.com/Kilo-Org/kilocode), the open-source AI coding agent, which is itself a fork of [OpenCode](https://github.com/anomalyco/opencode). On top of upstream it adds a **self-hosted enterprise layer**: single sign-on, SCIM, organization policy (model, MCP and tool-permission controls), org-managed agents, audit logs, usage analytics and budgets.

Upstream Kilo's enterprise features run on Kilo's hosted backend, which is not open source. The open-source repository contains only the clients (CLI, VS Code extension, JetBrains plugin), so this fork implements both sides itself:

- **Control plane**: [`packages/enterprise-server`](packages/enterprise-server/README.md), a server you run (Hono + SQLite, ships as a single binary) with an admin console.
- **Client integration**: [`packages/opencode/src/enterprise`](packages/opencode/src/enterprise), which makes the CLI, and therefore the IDE extensions that run it, fetch and enforce the org policy.

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

Enterprise features only work in builds made from this repository. The marketplace builds of upstream Kilo don't contain the client integration.

## What's fork-owned

| Path | Contents |
|---|---|
| `packages/enterprise-server/` | Control plane: API, SSO, SCIM, policy, audit, usage, budgets, admin console, tests |
| `packages/opencode/src/enterprise/` | Client: deployment settings, policy fetch and cache, enforcement, usage reporting, `kilo enterprise` command |
| `packages/opencode/test/enterprise/` | Contract tests that run the client against the real control plane |
| `FORK.md` | This file |

Changes to upstream files are kept to one-line calls into the enterprise module, marked `enterprise_change` (the same convention upstream uses with `kilocode_change`). `git grep -n enterprise_change` lists every one:

| Upstream file | Hook |
|---|---|
| `packages/opencode/src/config/config.ts` | Apply the org policy as the last config layer, above user, project, managed and env config |
| `packages/opencode/src/provider/provider.ts` | Drop models outside the user's effective model access |
| `packages/opencode/src/mcp/index.ts` | Refuse MCP servers outside the allowlist or on the blocklist; every connection path passes here |
| `packages/opencode/src/kilocode/session/prompt.ts` | Add org deny rules to the hard ruleset of every permission ask |
| `packages/opencode/src/plugin/index.ts` | Always load the enterprise plugin, even with `KILO_DISABLE_DEFAULT_PLUGINS` |
| `packages/opencode/src/kilocode/cli/setup.ts` | Startup switches (product analytics, sharing, vendor session sync); register `kilo enterprise` |
| `packages/opencode/src/kilocode/cli/lazy-kilo-commands.ts` | Lazy loader for `kilo enterprise` |
| `packages/opencode/src/kilocode/server/httpapi/handlers/telemetry.ts` | Stop the runtime telemetry toggle from re-enabling analytics the org turned off |
| `packages/opencode/src/kilo-sessions/kilo-sessions.ts` | Keep sessions from syncing to the upstream vendor's cloud unless the org allows sharing |

## How the client enforces policy

| Policy | Enforced at | Notes |
|---|---|---|
| Sign-in required | Before every LLM request | Set by a managed `enterprise.json`; users can't remove it without admin rights on their machine |
| Model access | Model list at load time, and again before every request | A request to a newly blocked model is refused even before the list refreshes |
| MCP allow/block | Every MCP connection | Matched on the server URL or command line, not its name |
| Tool permission denies | Hard ruleset, plus the config layer | No saved approval, session rule or "allow everything" mode overrides them |
| Org agents, org MCP servers, sharing, analytics | Last config layer | Org agents are marked `source: organization` |
| Vendor session sync | Wherever a session would leave the machine for the vendor's cloud | Off unless the org sets `share: allowed`; also off while no policy is loaded |
| Org rules | System prompt of every request | |
| Budgets | Before every request | Spend refreshes after each usage upload |
| Usage | Each LLM call (step) | Batched every 15 s, spooled to disk when offline, de-duplicated by the server |

The policy is fetched at startup (waiting at most 5 s), refreshed every 5 minutes with an ETag, and cached on disk.

- **Offline:** a cached policy keeps applying for up to 7 days. After that it's treated as missing, so cutting off the control plane can't pin a lenient old policy.
- **Revoked tokens and suspended members:** the policy is dropped immediately rather than kept stale.

Client-side enforcement guards against mistakes and drift, not against a user who controls their own machine and runs some other tool. Tamper-proof enforcement needs the gateway in the roadmap below.

### Client configuration

| Source | Example | Precedence |
|---|---|---|
| Managed file (MDM) | `/etc/kilo/enterprise.json` → `{"url": "https://ai.acme.com", "org": "acme", "required": true}` | Highest; can't be overridden |
| Environment | `KILO_ENTERPRISE_URL`, `KILO_ENTERPRISE_ORG`, `KILO_ENTERPRISE_TOKEN` (CI), `KILO_ENTERPRISE_REQUIRED=1` | |
| Stored login | Written by `kilo enterprise login` (mode 0600) | |

With none of these present, every hook is a no-op and the CLI behaves exactly like upstream.

## Keeping up with upstream

Fresh clones need the remote once: `git remote add upstream https://github.com/Kilo-Org/kilocode.git`.

```sh
git fetch upstream --tags
git merge v7.9.0                      # or upstream/main
git grep -n enterprise_change         # check each hook still sits where it should
bun install                           # regenerates bun.lock; on a bun.lock conflict take upstream's, then re-run
(cd packages/enterprise-server && bun test)
(cd packages/opencode && bun run typecheck && bun test ./test/enterprise)
(cd packages/opencode && bun run --conditions=browser src/index.ts generate > /dev/null)  # catches import cycles typecheck can't
```

Because all new code lives in fork-owned directories, merges normally touch only the marked hooks above.

## CI: a decision for you

The import brought upstream's GitHub Actions workflows along, unchanged. Several only make sense inside Kilo's organization:

- **Private runners:** some jobs target Kilo's private `blacksmith-*` runners and will wait for a runner forever. `test.yml`'s change-detection job does this unconditionally.
- **Missing secrets:** release and publish workflows need Kilo's secrets.
- **Scheduled bots:** stale-PR, auto-close, community sweep and beta releases all run on a schedule.

Most are guarded with `github.repository == 'Kilo-Org/kilocode'`, but not all. Scheduled workflows only run from the default branch, so none of this starts until the fork lands on `main`. Before that, either turn off the workflows you don't want in the repository's Actions settings, or move them under `.github/workflows/disabled/` (the pattern upstream uses) and add a small CI for the fork: the test, typecheck and `generate` commands above. Workflows were left untouched pending your decision.

The husky `pre-push` hook runs a full monorepo typecheck, then the JetBrains plugin typecheck. The JetBrains step downloads Kilo's pinned CLI release metadata from the GitHub API. Where that API is unreachable, `./gradlew typecheck -Pkilo.cli.pinned=false` checks the plugin against the CLI in this repository instead; build it first with `bun run script/build.ts --single --skip-install` in `packages/opencode`.

## Roadmap

1. **Enterprise LLM gateway.** An OpenAI- and Anthropic-compatible proxy in the control plane that holds the provider keys (BYOK), enforces model access and budgets server-side, and records usage itself. Clients receive only org tokens, so enforcement no longer depends on the developer's machine. This is how Kilo's hosted enterprise plan enforces model restrictions.
2. **IDE surfaces.** Show the org, sign-in state and blocked reasons in the VS Code and JetBrains UIs, with a sign-in button. Today they appear as session errors and through `kilo enterprise status`.
3. **Rebranding and distribution** (see above).
4. **SAML 2.0** and IdP-initiated sign-in. OIDC covers Okta, Entra ID, Google and most others, but some organizations require SAML.
5. **Operations.** Postgres storage and high availability, container image and Helm chart, rate limiting, backups.
6. **SIEM streaming.** Push audit events to webhooks, OTLP or syslog. Opt-in audit of client-side events such as tool runs.
7. **Analytics.** Adoption dashboards, team and sub-organization comparisons, scheduled reports, an analytics API.
8. **Live policy reload** of the model list in running clients, without a restart.
9. **Spend management.** Group budgets, distributing funds across sub-organizations, seat management.
10. **Provider data filters.** Filter providers by data policy (training on prompts, retention, region), like Kilo's provider filters.
