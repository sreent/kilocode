import { For, Show, createResource } from "solid-js"
import { Card } from "@kilocode/kilo-web-ui/card"
import { call } from "../api"
import { useOrg } from "../context"
import { label, money, when } from "../format"
import { Failure, Loading, Muted, Page, Panel } from "../components/page"
import { Copyable } from "../components/secret"

const day = 24 * 60 * 60 * 1000

export function Overview() {
  const scope = useOrg()
  const [usage] = createResource(scope.slug, (org) =>
    call((api) =>
      api["enterprise.insight"]["usage.summary"]({
        params: { org },
        query: { by: "user", from: String(Date.now() - 30 * day) },
      }),
    ),
  )
  const [policy] = createResource(
    () => scope.can("policy.read") && scope.slug(),
    (org) => call((api) => api["enterprise.governance"]["policy.get"]({ params: { org } })),
  )
  const total = () => usage()?.rows.reduce((sum, row) => sum + row.cost, 0) ?? 0
  const requests = () => usage()?.rows.reduce((sum, row) => sum + row.requests, 0) ?? 0
  const top = () => usage()?.rows.slice(0, 5) ?? []
  const peak = () => Math.max(...top().map((row) => row.cost), 0.000001)
  const managed = () => JSON.stringify({ url: location.origin, org: scope.slug(), required: true }, null, 2)
  const metrics = (): ReadonlyArray<{ label: string; value: string; note?: string }> => [
    {
      label: "Your role",
      value: label(scope.org().role),
      note: scope.org().inherited ? "From the parent organization" : undefined,
    },
    { label: "Spend, last 30 days", value: usage.loading ? "…" : money(total()) },
    { label: "Requests, last 30 days", value: usage.loading ? "…" : requests().toLocaleString() },
    ...(scope.can("policy.read")
      ? [
          {
            label: "Policy",
            value: policy() ? `Version ${policy()!.version}` : "…",
            note: policy()?.updated ? `Updated ${when(policy()!.updated)}` : undefined,
          },
        ]
      : []),
  ]

  return (
    <Page
      title={scope.org().name}
      description={
        <>
          Organization <span class="mono">{scope.slug()}</span>
          {scope.org().inherited ? ", managed from the parent organization." : "."}{" "}
          {scope.can("usage.read") ? "Spend covers everyone in the organization." : "Spend covers your own usage."}
        </>
      }
    >
      <section class="metrics" aria-label="Organization metrics">
        <For each={metrics()}>
          {(metric) => (
            <Card class="metric" padding={12}>
              <span>{metric.label}</span>
              <strong title={metric.value}>{metric.value}</strong>
              <Show when={metric.note}>
                <small>{metric.note}</small>
              </Show>
            </Card>
          )}
        </For>
      </section>

      <Show when={usage.error}>
        <Failure error={usage.error} />
      </Show>
      <Show when={scope.can("usage.read")}>
        <Panel title="Top spenders" description="The five people with the highest spend in the last 30 days.">
          <Show when={!usage.loading} fallback={<Loading />}>
            <Show when={top().length > 0} fallback={<Muted>No usage reported yet.</Muted>}>
              <div class="bars">
                <For each={top()}>
                  {(row) => (
                    <div class="bar-row">
                      <span class="bar-label">{row.key}</span>
                      <span class="bar-track">
                        <span class="bar" style={{ width: `${(row.cost / peak()) * 100}%` }} />
                      </span>
                      <span class="bar-value">{money(row.cost)}</span>
                    </div>
                  )}
                </For>
              </div>
            </Show>
          </Show>
        </Panel>
      </Show>

      <Panel
        title="Connect the CLI and IDE extensions"
        description={
          <>
            Deploy this file with your device management to <span class="mono">/etc/kilo/enterprise.json</span> (macOS:{" "}
            <span class="mono">/Library/Application Support/kilo</span>, Windows:{" "}
            <span class="mono">%ProgramData%\kilo</span>), then have people run{" "}
            <span class="mono">kilo enterprise login</span>.
          </>
        }
      >
        <Copyable label="enterprise.json" value={managed()} block hideLabel />
      </Panel>
    </Page>
  )
}
