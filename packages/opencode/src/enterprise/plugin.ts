// kilocode_change - new file (enterprise)
import path from "path"
import { Effect } from "effect"
import type { Hooks, PluginInput } from "@kilocode/plugin"
import { allows } from "@enterprise/protocol/match"
import { Enterprise } from "./enterprise"

// Internal plugin that applies the org policy at request time. Unlike other internal plugins it
// is loaded even when default plugins are disabled, so it cannot be switched off from the shell.
// The Plugin service builds it with its own Enterprise service, so every hook runs a fully
// provided Effect.
export function EnterprisePlugin(enterprise: Enterprise.Interface) {
  const run = <A>(effect: Effect.Effect<A>) => Effect.runPromise(effect)

  return async function EnterprisePlugin(_input: PluginInput): Promise<Hooks> {
    if (!(await run(enterprise.settings()))) return {}
    await run(Effect.all([enterprise.ready(), enterprise.usage.start()]))

    // Step-finish parts carry per-call tokens and cost but not the model; remember it per message.
    const messages = new Map<string, { provider: string; model: string; root: string }>()

    return {
      "chat.params": async (input) => {
        const reason = await run(
          Effect.gen(function* () {
            yield* enterprise.ready()
            const blocked = yield* enterprise.blocked()
            if (blocked) return blocked
            const policy = yield* enterprise.current()
            if (policy && !allows(policy, input.model.providerID, input.model.id))
              return `The model ${input.model.providerID}/${input.model.id} is not allowed by your organization's policy.`
            return undefined
          }),
        )
        if (reason) throw new Enterprise.PolicyError(reason)
      },
      "experimental.chat.system.transform": async (_input, output) => {
        const text = await run(enterprise.instructions())
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
        await run(
          enterprise.usage.push({
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
        await run(enterprise.usage.stop())
      },
    }
  }
}
