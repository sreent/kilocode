# About this fork

This repository is **TU Code**, a fork of [Kilo Code](https://github.com/Kilo-Org/kilocode), the open-source AI coding agent, which is itself a fork of [OpenCode](https://opencode.ai). On top of upstream it adds **self-hosted organizations**: single sign-on, SCIM, organization policy (model, MCP and tool-permission controls), org-managed agents, an LLM gateway, audit logs and streaming, usage analytics and budgets. They are standard features of TU Code, not a separate enterprise tier. TU Code carries its own name and never connects to Kilo's services (see [TU Code](#tu-code)).

Upstream Kilo offers similar features in its hosted Enterprise plan, on a backend that is not open source. The open-source repository contains only the clients (CLI, VS Code extension, JetBrains plugin), so this fork implements both sides itself:

- **Organization server**: [`packages/organization-server`](packages/organization-server/README.md), a server you run (Postgres, embedded or on a PostgreSQL server for high availability; ships as a single binary with the admin console inside).
- **Admin console**: [`packages/organization-console`](packages/organization-console), the web UI the server hosts at `/admin`.
- **Contract**: [`packages/organization-protocol`](packages/organization-protocol), the API definition, schemas and role model shared by the server, the CLI and the console.
- **Client integration**: [`packages/opencode/src/organization`](packages/opencode/src/organization), which makes the CLI, and therefore the IDE extensions that run it, fetch and enforce the org policy.

## Provenance and license

- Imported from Kilo-Org/kilocode release `v7.8.17` (commit `eb11204e8f`) **with full git history**, so upstream releases can be merged normally (see [Keeping up with upstream](#keeping-up-with-upstream)).
- Upstream is MIT licensed (Copyright (c) 2026 Kilo Code, Copyright (c) 2025 opencode). `LICENSE` is unchanged and must stay with every copy. New code in this fork is also MIT; add your own copyright line to `LICENSE` if you want one.

## TU Code

MIT covers the code, not names or logos. "Kilo" and "Kilo Code" identify Kilo's products, so this fork ships as **TU Code**, with its own command, packages, icons and identities, and claims no Kilo affiliation.

### The brand

[`brand/brand.json`](brand/README.md) holds every name: the product, the `tucode` command, the npm packages, the container image, the VS Code and JetBrains identities, the managed config folder and the repository. `bun brand/apply.ts` rewrites what users see across the tree from it, and `--check` lists what would still change. Run it after every merge from Kilo upstream, because each merge brings new text in Kilo's name.

The values in `brand.json` are placeholders. Replace them with ones you control (npm scope, VS Code publisher, JetBrains plugin ID and vendor, container image, repository) before you publish anything.

What users see is renamed. Internal names stay, which keeps upstream merges small:

- `KILO_*` environment variables
- `kilo.json` and `.kilo` folders
- the `kilo-code.new.*` setting keys and command IDs
- the workspace package `@kilocode/cli`
- code identifiers

Because the setting keys, command IDs and the JetBrains plugin's internal IDs stay Kilo's, TU Code and Kilo Code can't be installed side by side in the same editor.

### Kilo's services

TU Code never talks to Kilo's services:

| Service | What changed |
|---|---|
| Kilo account | No way to sign in: the Kilo auth plugin, the `cloud`, `profile`, `auto`, `remote` and `github` commands, and the IDEs' Kilo account pages are gone |
| Kilo Gateway | Removed from the model catalog, even with `KILO_API_KEY` set; autocomplete runs through Mistral or Inception providers people connect themselves |
| Cloud sessions, sharing, remote control, marketplace | Gone from VS Code and JetBrains. The TUI still lists `/share`, which fails. The CLI code that needs a Kilo sign-in stays, dormant |
| Product analytics | Never start |
| Updates | Come from TU Code's npm package, and install themselves only with `autoupdate: true` |

A guard installed first in every CLI entry point and worker refuses connections to `kilo.ai`, `kilocode.ai`, `kilosessions.ai` and `kiloapps.io`, so a path the rename missed fails instead of reaching Kilo.

TU Code keeps its files under `tucode` (`~/.config/tucode`, `~/.local/share/tucode`), apart from an installed Kilo's, and reads managed settings from `/etc/tucode`.

### Publishing

Builds carry the brand's names: the `@tucode/cli` npm package and its `@tucode/cli-<platform>` binaries, the `tucode` binary, `tucode-<platform>` release archives, the container image and their SBOMs. Kilo's AUR package and Homebrew tap are left alone.

The release workflows are Kilo's and run only in `Kilo-Org/kilocode`. Adapt them, with your own secrets, before you publish. When this repository has no releases yet, the release script reads its next version from Kilo's npm package, so set `KILO_VERSION` for the first one.

The JetBrains plugin builds against the CLI in this repository. A release build of it needs `kilo.cli.pinned=true`, which production builds and `packages/kilo-jetbrains/script/build-version.sh` enforce, and the pinned version's CLI release, with its `tucode-<platform>` archives, published in the repository in `brand.json`.

## What's fork-owned

| Path | Contents |
|---|---|
| `packages/organization-protocol/` | Shared contract: HTTP API groups, schemas, errors, middleware tags, role capabilities, typed client |
| `packages/organization-server/` | Organization server: API, SSO, SCIM, policy, gateway, audit, usage, budgets, tests |
| `packages/organization-console/` | Admin console |
| `packages/opencode/src/organization/` | Client: deployment settings, policy fetch and cache, enforcement, usage reporting, `tucode org` command |
| `packages/opencode/test/organization/` | Contract tests that run the client against the real organization server |
| `brand/` | TU Code's names, logos and the script that applies them (see [TU Code](#tu-code)) |
| `packages/opencode/src/tucode/`, `packages/core/src/tucode/` | The brand as code, and the guard that refuses connections to Kilo's services |
| `packages/opencode/test/tucode/` | Tests for the guard and the missing Kilo Gateway |
| `FORK.md` | This file |

Changes to upstream files are kept to one-line calls into the organization module. They use upstream's own `kilocode_change` markers, which upstream's annotation check (`script/check-opencode-annotations.ts`) requires, tagged `organization` to tell them apart from Kilo's changes: `// kilocode_change - organization`, `// kilocode_change start - organization: <why>` / `// kilocode_change end`, and `// kilocode_change - new file (organization)` atop fork-owned files in shared directories. `git grep -n "kilocode_change.*organization"` lists every one:

| Upstream file | Hook |
|---|---|
| `packages/opencode/src/config/config.ts` | Apply the org policy as the last config layer, above user, project, managed and env config; reload it when the policy changes |
| `packages/opencode/src/provider/provider.ts` | Drop models outside the user's effective model access, rebuild the list when the policy changes, and say why a refused model is missing |
| `packages/tui/src/context/sync.tsx` | Refetch providers and agents on a config update, which a policy change sends |
| `packages/opencode/src/mcp/index.ts` | Refuse MCP servers outside the allowlist or on the blocklist; every connection path passes here |
| `packages/opencode/src/permission/index.ts` | Add org deny rules to the hard ruleset of every permission ask |
| `packages/opencode/src/plugin/index.ts` | Always load the organization plugin, even with `KILO_DISABLE_DEFAULT_PLUGINS` |
| `packages/opencode/src/effect/app-runtime.ts`, `packages/opencode/src/server/routes/instance/httpapi/server.ts` | Register the `Organization` service in the CLI's and the local server's layer graphs |
| `packages/opencode/src/kilocode/cli/setup.ts` | Startup switches (product analytics, sharing, vendor session sync); register `tucode org` |
| `packages/opencode/src/kilocode/cli/bootstrap-runtime.ts` | Load the org policy before the first instance starts |
| `packages/opencode/src/kilocode/cli/lazy-kilo-commands.ts` | Lazy loader for `tucode org` |
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
| Model access | Model list at load time and whenever the policy changes, and again before every request | A request to a newly blocked model is refused even before the list refreshes |
| Data policy | Same as model access | Providers whose recorded terms fall short of the org's filters (training, retention, regions) are refused with the reason; OpenRouter-compatible providers get the filters as routing preferences on every request |
| MCP allow/block | Every MCP connection | Matched on the server URL or command line, not its name |
| Tool permission denies | Hard ruleset, plus the config layer | No saved approval, session rule or "allow everything" mode overrides them |
| Org agents, org MCP servers, sharing, analytics | Last config layer | Org agents are marked `source: organization` |
| Vendor session sync | Wherever a session would leave the machine for the vendor's cloud | Off unless the org sets `share: allowed`; also off while no policy is loaded |
| Org rules | System prompt of every request | |
| Budgets | Before every request | Spend refreshes after each usage upload |
| Usage | Each LLM call (step) | Batched every 15 s, spooled to disk when offline, de-duplicated by the server |
| Tool-run audit | Each finished tool call | Only while the policy's `audit.tools` asks for it; sent to the audit log like usage, recorded once each |
| Gateway providers | Last config layer | Their base URL becomes `<server>/gateway/<id>` and their API key the organization token; a provider clients don't know (LiteLLM, Claude on Bedrock or Vertex) is defined from the name and models the server sends; with `gateway.exclusive`, every other provider is refused |

The policy is fetched at startup (waiting at most 5 s), refreshed every 5 minutes with an ETag, and cached on disk.

- **Live changes:** when a refresh brings a policy that changes what clients see, running clients rebuild their model list, org agents and config without a restart, and the TUI, VS Code and JetBrains refetch them. A session whose model was taken away is told why. MCP servers the org adds or removes connect or disconnect at the next start; the allowlist and blocklist already apply to every new connection.

- **Offline:** a cached policy keeps applying for up to 7 days. After that it's treated as missing, so cutting off the organization server can't pin a lenient old policy.
- **Revoked tokens and suspended members:** the policy is dropped immediately rather than kept stale.

Client-side enforcement guards against mistakes and drift, not against a user who controls their own machine and runs some other tool. For providers routed through the organization server's [LLM gateway](packages/organization-server/README.md#llm-gateway), the server enforces model access, the data policy, budgets and rate limits on every call, meters usage itself and logs each call, because only the server holds the provider credentials. The gateway reaches Anthropic, OpenAI, Azure OpenAI, any OpenAI-compatible server or gateway (LiteLLM among them), and Claude on Amazon Bedrock and Google Vertex AI.

### Client configuration

| Source | Example | Precedence |
|---|---|---|
| Managed file (MDM) | `/etc/tucode/organization.json` → `{"url": "https://ai.acme.com", "org": "acme", "required": true}` | Highest; can't be overridden |
| Environment | `KILO_ORG_URL`, `KILO_ORG`, `KILO_ORG_TOKEN` (CI), `KILO_ORG_REQUIRED=1` | |
| Stored login | Written by `tucode org login` (mode 0600) | |

With none of these present, every hook is a no-op and the CLI behaves exactly like upstream.

Settings from before these features were renamed still apply: a managed `enterprise.json` while no `organization.json` exists, and each `KILO_ENTERPRISE_*` variable while its `KILO_ORG*` counterpart is unset, so devices and CI set up earlier stay enrolled. Stored sign-ins don't carry over: people run `tucode org login` once more. `KILO_ORG_ID` is unrelated: it selects an organization on Kilo's hosted service, which TU Code doesn't use.

### Signing in from the IDEs

People sign in from their IDE's profile: the Profile page in VS Code, and Settings → Tools → TU Code → User Profile in JetBrains IDEs. Both show the organization, who is signed in, the policy version, gateway providers and why the agent is blocked, and sign in with the same device code as `tucode org login`. On a device that isn't enrolled, a small link on the same page connects to an organization. Both drive the CLI's `/kilo/org` routes, and a sign-in or sign-out reloads the providers, models and agents the policy shapes.

JetBrains builds use the CLI in this repository (`kilo.cli.pinned=false` in `packages/kilo-jetbrains/gradle.properties`). Build it first with `./gradlew :backend:buildRepoCli`: a plugin built without it bundles no CLI, and tries to download the CLI release of its version when it starts.

## Keeping up with upstream

Fresh clones need the remote once: `git remote add upstream https://github.com/Kilo-Org/kilocode.git`.

```sh
git fetch upstream --tags
git merge v7.9.0                      # or upstream/main
bun brand/apply.ts                    # rename the Kilo text the merge brought in; review the diff
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

The husky `pre-push` hook runs a full monorepo typecheck, then the JetBrains plugin typecheck. The JetBrains plugin builds against this repository: its API client comes from the SDK's committed OpenAPI spec (`packages/sdk/openapi.json`), so it needs neither the network nor a built CLI. Regenerate that spec with `./script/generate.ts` after changing the CLI's server routes, as for the SDK.

## Roadmap

1. **Publishing.** Replace the placeholders in `brand/brand.json`, adapt the release workflows and their secrets, publish the CLI (npm, GitHub releases, container image) and the VS Code extension, then pin the JetBrains plugin to the published CLI release and publish it.
