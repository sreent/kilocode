import { Show, createResource, createSignal } from "solid-js"
import { Button } from "@kilocode/kilo-web-ui/button"
import { UsageBy } from "@organization/protocol/schema"
import { call, download } from "../api"
import { useOrg } from "../context"
import { count, money, range } from "../format"
import { attempt } from "../components/feedback"
import { Choice, TextInput } from "../components/form"
import { Failure, Loading, Page, Panel } from "../components/page"
import { DataTable } from "../components/table"

type By = (typeof UsageBy.literals)[number]

const heading: Record<By, string> = {
  user: "Person",
  model: "Model",
  provider: "Provider",
  day: "Day",
  project: "Project",
  source: "Source",
}
// Who measured the usage: the gateway as it relayed the call, or the client after it.
const sources: Record<string, string> = { gateway: "LLM gateway", client: "Reported by clients" }
const dimensions = UsageBy.literals.map((value) => ({ value, label: heading[value] }))

export function Usage() {
  const scope = useOrg()
  const [by, setBy] = createSignal<By>("user")
  const [from, setFrom] = createSignal("")
  const [to, setTo] = createSignal("")
  // Filters apply on submit, so picking a date does not refetch on every change.
  const [filter, setFilter] = createSignal({ by: by(), from: "", to: "" })
  const [usage] = createResource(
    () => ({ org: scope.slug(), ...filter() }),
    (input) =>
      call((api) =>
        api["organization.insight"]["usage.summary"]({
          params: { org: input.org },
          query: { by: input.by, ...range(input.from, input.to) },
        }),
      ),
  )
  const peak = () => Math.max(...(usage()?.rows.map((row) => row.cost) ?? []), 0.000001)
  const total = () => usage()?.rows.reduce((sum, row) => sum + row.cost, 0) ?? 0

  const exportCsv = () =>
    attempt(async () => {
      const text = await call((api) =>
        api["organization.insight"]["usage.export"]({
          params: { org: scope.slug() },
          query: range(filter().from, filter().to),
        }),
      )
      download(`usage-${scope.slug()}.csv`, text)
    })

  return (
    <Page
      title="Usage"
      description={
        scope.can("usage.read")
          ? "Requests, tokens and spend across the organization, metered by the gateway or reported by clients."
          : "Your own requests, tokens and spend in this organization."
      }
      actions={
        <Show when={scope.can("usage.read")}>
          <Button variant="secondary" icon="download" onClick={exportCsv}>
            Export CSV
          </Button>
        </Show>
      }
    >
      <form
        class="config-toolbar"
        onSubmit={(event) => {
          event.preventDefault()
          setFilter({ by: by(), from: from(), to: to() })
        }}
      >
        <div class="config-toolbar-controls">
          <Choice label="Group by" value={by()} options={dimensions} onValue={setBy} />
          <TextInput label="From" type="date" value={from()} onValue={setFrom} />
          <TextInput label="To" type="date" value={to()} onValue={setTo} />
          <Button type="submit" variant="primary">
            Apply
          </Button>
        </div>
      </form>
      <Show when={!usage.error} fallback={<Failure error={usage.error} />}>
        <Show when={usage()} fallback={<Loading />}>
          {(data) => (
            <Panel
              title={`${money(total())} across ${count(data().rows.length)} ${data().rows.length === 1 ? "row" : "rows"}`}
              description={`${new Date(data().from).toLocaleDateString()} to ${new Date(data().to - 1).toLocaleDateString()}`}
              flush
            >
              <DataTable
                rows={data().rows}
                empty="No usage reported in this window."
                columns={[
                  {
                    label: heading[data().by],
                    cell: (row) =>
                      (data().by === "source" ? sources[row.key] : row.key) || <span class="muted">—</span>,
                  },
                  { label: "Requests", align: "end", cell: (row) => count(row.requests) },
                  { label: "People", align: "end", cell: (row) => count(row.users) },
                  { label: "Input tokens", align: "end", cell: (row) => count(row.input) },
                  { label: "Output tokens", align: "end", cell: (row) => count(row.output) },
                  { label: "Cache reads", align: "end", cell: (row) => count(row.cache_read) },
                  {
                    label: "Cost",
                    align: "end",
                    width: "14rem",
                    cell: (row) => (
                      <span class="cost">
                        <span class="bar-track">
                          <span class="bar" style={{ width: `${(row.cost / peak()) * 100}%` }} />
                        </span>
                        <span class="bar-value">{money(row.cost)}</span>
                      </span>
                    ),
                  },
                ]}
              />
            </Panel>
          )}
        </Show>
      </Show>
    </Page>
  )
}
