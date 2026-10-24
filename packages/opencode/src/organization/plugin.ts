// kilocode_change - new file (organization)
import path from "path"
import { Effect } from "effect"
import type { Hooks, PluginInput } from "@kilocode/plugin"
import { allows, preferences, withheld } from "@organization/protocol/match"
import { Organization } from "./organization"

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
            const provider = input.model.providerID
            const reason =
              withheld(policy, provider) ??
              (allows(policy, provider, input.model.id)
                ? undefined
                : `The model ${provider}/${input.model.id} is not allowed by your organization's policy.`)
            return { reason, routing: preferences(policy, provider) }
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
