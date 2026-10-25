import { For, Show, createResource, createSignal } from "solid-js"
import { Button } from "@kilocode/kilo-web-ui/button"
import { Card } from "@kilocode/kilo-web-ui/card"
import { CompareBy, Interval } from "@organization/protocol/schema"
import { call } from "../api"
import { useOrg } from "../context"
import { count, date, money } from "../format"
import { ColumnChart } from "../components/chart"
import { Choice } from "../components/form"
import { Failure, Loading, Muted, Page, Panel } from "../components/page"
import { DataTable } from "../components/table"

type Span = "7" | "30" | "90" | "365"
type Every = (typeof Interval.literals)[number] | "auto"
type By = (typeof CompareBy.literals)[number]

const day = 24 * 60 * 60 * 1000

const spans: ReadonlyArray<{ value: Span; label: string }> = [
  { value: "7", label: "Last 7 days" },
  { value: "30", label: "Last 30 days" },
  { value: "90", label: "Last 90 days" },
  { value: "365", label: "Last 12 months" },
]
const intervals: ReadonlyArray<{ value: Every; label: string }> = [
  { value: "auto", label: "Automatic" },
  { value: "day", label: "Days" },
  { value: "week", label: "Weeks" },
  { value: "month", label: "Months" },
]
const comparisons: Record<By, string> = { group: "Groups", suborg: "Sub-organizations", model: "Models" }

const compact = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 })
const percent = (part: number, whole: number) => (whole > 0 ? `${Math.round((part / whole) * 100)}%` : "—")

// How a figure moved against the range before, as a signed percentage.
function change(now: number, before: number) {
  if (before === 0) return now === 0 ? "—" : "New"
  const delta = Math.round(((now - before) / before) * 100)
  return `${delta > 0 ? "+" : ""}${delta}%`
}

// Interval labels in UTC, where the intervals are.
function caption(interval: string, start: number) {
  const options: Intl.DateTimeFormatOptions =
    interval === "month" ? { month: "short", year: "numeric" } : { month: "short", day: "numeric" }
  const text = new Intl.DateTimeFormat(undefined, { ...options, timeZone: "UTC" }).format(start)
  return interval === "week" ? `Week of ${text}` : text
}

export function Analytics() {
  const scope = useOrg()
  const [span, setSpan] = createSignal<Span>("30")
  const [every, setEvery] = createSignal<Every>("auto")
  const [by, setBy] = createSignal<By>("group")
  const [table, setTable] = createSignal(false)
  // Whole UTC days, ending with today.
  const bounds = () => {
    const today = Math.floor(Date.now() / day) * day
    return { from: today - (Number(span()) - 1) * day, to: today + day }
  }
  const query = () => ({
    from: String(bounds().from),
    to: String(bounds().to),
  })
  const [adoption] = createResource(
    () => ({ org: scope.slug(), query: query(), every: every() }),
    (input) =>
      call((api) =>
        api["organization.insight"]["analytics.adoption"]({
          params: { org: input.org },
          query: { ...input.query, ...(input.every === "auto" ? {} : { interval: input.every }) },
        }),
      ),
  )
  const [comparison] = createResource(
    () => ({ org: scope.slug(), query: query(), by: by() }),
    (input) =>
      call((api) =>
        api["organization.insight"]["analytics.compare"]({
          params: { org: input.org },
          query: { ...input.query, by: input.by },
        }),
      ),
  )

  return (
    <Page
      title="Analytics"
      description="Who in this organization uses tucode, how much, and how its groups, sub-organizations and models compare with the period before. The same figures are in the analytics API."
    >
      <div class="config-toolbar">
        <div class="config-toolbar-controls">
          <Choice label="Range" value={span()} options={spans} onValue={setSpan} />
          <Choice label="Intervals" value={every()} options={intervals} onValue={setEvery} />
        </div>
      </div>
      <Show when={!adoption.error} fallback={<Failure error={adoption.error} />}>
        <Show when={adoption()} fallback={<Loading />}>
          {(data) => (
            <div class="panels" classList={{ refreshing: adoption.loading }}>
              <section class="metrics" aria-label="Adoption">
                <For
                  each={[
                    {
                      label: "Active people",
                      value: count(data().active),
                      note: `${percent(data().active, data().members)} of ${count(data().members)} members`,
                    },
                    { label: "New people", value: count(data().new), note: "First request in this range" },
                    { label: "Sessions", value: count(data().sessions) },
                    { label: "Requests", value: count(data().requests) },
                    {
                      label: "Spend",
                      value: money(data().cost),
                      note: data().active > 0 ? `${money(data().cost / data().active)} per active person` : undefined,
                    },
                  ]}
                >
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

              <Panel
                flush
                title="People active"
                description="People who made at least one request, interval by interval, in UTC."
                actions={
                  <Button variant="ghost" size="sm" onClick={() => setTable(!table())}>
                    {table() ? "Show charts" : "Show as table"}
                  </Button>
                }
              >
                <Show
                  when={!table()}
                  fallback={
                    <DataTable
                      rows={data().series}
                      empty="No intervals in this range."
                      columns={[
                        { label: "Interval", cell: (row) => caption(data().interval, row.start) },
                        { label: "Active people", align: "end", cell: (row) => count(row.active) },
                        { label: "New", align: "end", cell: (row) => count(row.new) },
                        { label: "Sessions", align: "end", cell: (row) => count(row.sessions) },
                        { label: "Requests", align: "end", cell: (row) => count(row.requests) },
                        { label: "Spend", align: "end", cell: (row) => money(row.cost) },
                      ]}
                    />
                  }
                >
                  <ColumnChart
                    title="People active"
                    whole
                    format={(value) => `${count(value)} active`}
                    tick={(value) => compact.format(value)}
                    columns={data().series.map((point) => ({
                      label: caption(data().interval, point.start),
                      value: point.active,
                      detail: point.new > 0 ? `${count(point.new)} new` : undefined,
                    }))}
                  />
                </Show>
              </Panel>

              <Show when={!table()}>
                <Panel flush title="Spend" description="What those requests cost, interval by interval.">
                  <ColumnChart
                    title="Spend"
                    format={money}
                    tick={(value) => `$${compact.format(value)}`}
                    columns={data().series.map((point) => ({
                      label: caption(data().interval, point.start),
                      value: point.cost,
                      detail: `${count(point.requests)} requests`,
                    }))}
                  />
                </Panel>
              </Show>

              <Panel
                flush
                title="Comparison"
                description={`Against the ${span() === "365" ? "12 months" : `${span()} days`} before.`}
                actions={
                  <Choice
                    label="Compare"
                    hideLabel
                    value={by()}
                    options={CompareBy.literals.map((value) => ({ value, label: comparisons[value] }))}
                    onValue={setBy}
                  />
                }
              >
                <Show when={!comparison.error} fallback={<Failure error={comparison.error} />}>
                  <Show when={comparison()} fallback={<Loading />}>
                    {(result) => (
                      <DataTable
                        rows={result().rows}
                        empty={
                          by() === "group"
                            ? "No groups yet. Groups come from SCIM or the Groups page."
                            : "Nothing to compare in these ranges."
                        }
                        columns={[
                          { label: comparisons[by()].replace(/s$/, ""), cell: (row) => row.key },
                          {
                            label: "Members",
                            align: "end",
                            cell: (row) => (row.members === null ? "—" : count(row.members)),
                          },
                          {
                            label: "Active people",
                            align: "end",
                            cell: (row) => (
                              <span class="nowrap">
                                {count(row.current.active)} <span class="muted">was {count(row.previous.active)}</span>
                              </span>
                            ),
                          },
                          { label: "Requests", align: "end", cell: (row) => count(row.current.requests) },
                          { label: "Tokens", align: "end", cell: (row) => compact.format(row.current.tokens) },
                          { label: "Spend", align: "end", cell: (row) => money(row.current.cost) },
                          {
                            label: "Spend change",
                            align: "end",
                            cell: (row) => <span class="muted">{change(row.current.cost, row.previous.cost)}</span>,
                          },
                        ]}
                      />
                    )}
                  </Show>
                </Show>
              </Panel>

              <Panel
                flush
                title="Not using tucode"
                description="Members who made no request in this range, and when they last made one. Their seats might serve someone else."
              >
                <Show
                  when={data().idle.length > 0}
                  fallback={<Muted>Every member made a request in this range.</Muted>}
                >
                  <DataTable
                    rows={data().idle}
                    columns={[
                      {
                        label: "Person",
                        cell: (row) => (
                          <span class="stack">
                            {row.email}
                            <Show when={row.name}>
                              <small class="muted">{row.name}</small>
                            </Show>
                          </span>
                        ),
                      },
                      { label: "Last request", cell: (row) => (row.last === null ? "Never" : date(row.last)) },
                    ]}
                  />
                </Show>
              </Panel>
            </div>
          )}
        </Show>
      </Show>
    </Page>
  )
}
