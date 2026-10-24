// kilocode_change - new file (organization)
import path from "path"
import { Effect } from "effect"
import type { Hooks, PluginInput } from "@kilocode/plugin"
import { preferences } from "@organization/protocol/match"
import { Organization } from "./organization"

// At most max UTF-16 units and well formed, never ending in half a surrogate pair, so the server
// can keep it as JSON.
function clip(text: string, max: number) {
  const whole = text.toWellFormed()
  if (whole.length <= max) return whole
  const cut = whole.slice(0, max - 1)
  return `${/[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut}…`
}

// A path inside the project as relative to it; anything else as is.
function relative(root: string, file: string) {
  if (root === path.parse(root).root) return file
  const inside = path.relative(root, path.resolve(root, file))
  if (inside === ".." || inside.startsWith(`..${path.sep}`) || path.isAbsolute(inside)) return file
  return inside || "."
}

// What a tool acted on, for audit summaries that leave its input out: a file or folder, the site a
// URL is on, or the program a command runs. Never text someone wrote, such as a search, or the
// variables set before a command, which can hold secrets.
function subject(input: Record<string, unknown>, root: string) {
  const field = (key: string) => {
    const value = input[key]
    return typeof value === "string" && value.trim() ? value.trim() : undefined
  }
  const file = field("filePath") ?? field("path")
  if (file) return relative(root, file)
  const url = field("url")
  if (url) return URL.canParse(url) ? `${new URL(url).protocol}//${new URL(url).host}` : undefined
  return field("command")
    ?.split(/\s+/)
    .find((word) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word))
}

// Internal plugin that applies the org policy at request time. Unlike other internal plugins it
// is loaded even when default plugins are disabled, so it cannot be switched off from the shell.
// The Plugin service builds it with its own Organization service, so every hook runs a fully
// provided Effect.
export function OrganizationPlugin(organization: Organization.Interface) {
  const run = <A>(effect: Effect.Effect<A>) => Effect.runPromise(effect)

  return async function OrganizationPlugin(context: PluginInput): Promise<Hooks> {
    if (!(await run(organization.settings()))) return {}
    await run(Effect.all([organization.ready(), organization.usage.start()]))

    // Step-finish parts carry per-call tokens and cost but not the model; remember it per message.
    const messages = new Map<string, { provider: string; model: string; root: string }>()
    // Finished tool parts already reported, so later updates to one don't report it again.
    const reported = new Set<string>()
    // The gateway meters calls to the providers it routes; reporting them too would count them twice.
    const routed = (provider: string) =>
      run(organization.current()).then(
        (policy) => policy?.gateway.providers.some((item) => item.id === provider) === true,
      )

    return {
      "chat.params": async (input, output) => {
        const verdict = await run(
          Effect.gen(function* () {
            yield* organization.ready()
            const blocked = yield* organization.blocked()
            if (blocked) return { reason: blocked }
            const policy = yield* organization.current()
            if (!policy) return {}
            return {
              reason: yield* organization.explain(input.model.providerID, input.model.id),
              routing: preferences(policy, input.model.providerID),
            }
          }),
        )
        if (verdict.reason) throw new Organization.PolicyError(verdict.reason)
        // OpenRouter-compatible SDKs send this as the request's provider routing preferences.
        if (verdict.routing) {
          const current = output.options.provider
          output.options.provider = {
            ...(current && typeof current === "object" && !Array.isArray(current) ? current : {}),
            ...verdict.routing,
          }
        }
      },
      // Lets the gateway attribute its metered usage to the session and project, like client reports.
      "chat.headers": async (input, output) => {
        if (!(await routed(input.model.providerID))) return
        output.headers["x-org-session"] = input.sessionID
        output.headers["x-org-project"] = path.basename(context.worktree || context.directory)
      },
      "experimental.chat.system.transform": async (_input, output) => {
        const text = await run(organization.instructions())
        if (text)
          output.system.push(
            `# Organization rules\n\nThese rules come from your organization and always apply.\n\n${text}`,
          )
      },
      event: async ({ event }) => {
        if (event.type === "message.updated" && event.properties.info.role === "assistant") {
          const info = event.properties.info
          messages.delete(info.id)
          messages.set(info.id, { provider: info.providerID, model: info.modelID, root: info.path.root })
          if (messages.size > 1_000) messages.delete(messages.keys().next().value!)
          return
        }
        if (event.type === "message.part.updated" && event.properties.part.type === "tool") {
          const part = event.properties.part
          const state = part.state
          // Compaction rewrites finished parts long after they were reported.
          if (state.status !== "error" && (state.status !== "completed" || state.time.compacted)) return
          if (reported.has(part.id)) return
          const level = (await run(organization.current()))?.audit.tools
          if (!level || level === "off") return
          reported.add(part.id)
          if (reported.size > 1_000) reported.delete(reported.values().next().value!)
          const root = messages.get(part.messageID)?.root ?? (context.worktree || context.directory)
          const about = subject(state.input, root)
          await run(
            organization.tools.push({
              id: part.id,
              at: state.time.start,
              duration: Math.max(0, state.time.end - state.time.start),
              session: part.sessionID,
              project: clip(path.basename(root), 500),
              tool: clip(part.tool, 200),
              outcome: state.status,
              ...(about ? { subject: clip(about, 1_000) } : {}),
              ...(level === "inputs" ? { input: clip(JSON.stringify(state.input), 4_000) } : {}),
              ...(state.status === "error" ? { error: clip(state.error, 1_000) } : {}),
            }),
          )
          return
        }
        if (event.type !== "message.part.updated" || event.properties.part.type !== "step-finish") return
        const part = event.properties.part
        const meta = messages.get(part.messageID)
        if (meta && (await routed(meta.provider))) return
        await run(
          organization.usage.push({
            id: part.id,
            at: Date.now(),
            session: part.sessionID,
            project: meta ? path.basename(meta.root) : undefined,
            provider: meta?.provider ?? "unknown",
            model: meta?.model ?? "unknown",
            tokens: part.tokens,
            cost: part.cost,
          }),
        )
      },
      dispose: async () => {
        await run(organization.usage.stop())
      },
    }
  }
}
