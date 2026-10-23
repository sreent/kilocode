import { Show, createResource } from "solid-js"
import { Policy as PolicySchema } from "@enterprise/protocol/schema"
import { call } from "../api"
import { useOrg } from "../context"
import { when } from "../format"
import { attempt } from "../components/feedback"
import { JsonEditor } from "../components/json-editor"
import { Failure, Loading, Page, Panel } from "../components/page"

export function Policy() {
  const scope = useOrg()
  const [policy, { refetch }] = createResource(scope.slug, (org) =>
    call((api) => api["enterprise.governance"]["policy.get"]({ params: { org } })),
  )
  const [effective, effect] = createResource(scope.slug, (org) =>
    call((api) => api["enterprise.governance"]["policy.effective"]({ params: { org }, headers: {} })),
  )
  return (
    <Page
      title="Policy"
      description="What every CLI and IDE client in this organization enforces: model access, MCP servers, permissions, instructions, sharing and telemetry."
    >
      <Show when={!policy.error} fallback={<Failure error={policy.error} />}>
        <Show when={policy()} keyed fallback={<Loading />}>
          {(current) => (
            <Panel
              title={`Organization policy, version ${current.version}`}
              description={
                <>
                  Last updated {when(current.updated)}. <span class="mono">models.blocked</span> is the org-wide ceiling
                  (a bare provider blocks all its models); <span class="mono">models.default</span> applies to everyone
                  before group grants. With <span class="mono">mcp.mode</span> set to{" "}
                  <span class="mono">allowlist</span>, only servers whose URL or command matches{" "}
                  <span class="mono">mcp.allow</span> may run. Permission <span class="mono">deny</span> rules cannot be
                  overridden by users.
                </>
              }
            >
              <JsonEditor
                label="Policy"
                schema={PolicySchema}
                value={current.policy}
                disabled={!scope.can("policy.write")}
                onSave={async (value) => {
                  const ok = await attempt(
                    () =>
                      call((api) =>
                        api["enterprise.governance"]["policy.update"]({
                          params: { org: scope.slug() },
                          payload: value,
                        }),
                      ),
                    "Policy saved. Clients pick it up at their next refresh.",
                  )
                  if (!ok) return
                  void refetch()
                  void effect.refetch()
                }}
              />
            </Panel>
          )}
        </Show>
      </Show>
      <Panel
        title="Effective policy for you"
        description="The policy as a client receives it, after groups and budgets apply."
      >
        <Show when={!effective.error} fallback={<Failure error={effective.error} />}>
          <Show when={effective()} fallback={<Loading />}>
            {(value) => <pre class="code-block">{JSON.stringify(value(), null, 2)}</pre>}
          </Show>
        </Show>
      </Panel>
    </Page>
  )
}
