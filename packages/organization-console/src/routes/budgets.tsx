import { For, Show, createResource, createSignal } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { Button } from "@kilocode/kilo-web-ui/button"
import { IconButton } from "@kilocode/kilo-web-ui/icon-button"
import { BudgetScope, Period } from "@organization/protocol/schema"
import { call } from "../api"
import { useOrg } from "../context"
import { money } from "../format"
import { attempt } from "../components/feedback"
import { Choice, TextInput } from "../components/form"
import { Failure, Loading, Muted, Page, Panel } from "../components/page"
import { DataTable } from "../components/table"

type Scope = (typeof BudgetScope.literals)[number]
type Cadence = (typeof Period.literals)[number]
type Budget = { scope: Scope; target: string; period: Cadence; amount: number }
type Row = Omit<Budget, "amount"> & { amount: string }

const applies: Record<Scope, string> = {
  org: "Whole organization",
  member: "Each person (default)",
  user: "One person",
}
const cadence: Record<Cadence, string> = { day: "Per day", month: "Per month" }
const scopes = BudgetScope.literals.map((value) => ({ value, label: applies[value] }))
const periods = Period.literals.map((value) => ({ value, label: cadence[value] }))

export function Budgets() {
  const scope = useOrg()
  const [budgets, { refetch }] = createResource(scope.slug, (org) =>
    call((api) => api["organization.governance"]["budgets.get"]({ params: { org } })),
  )
  const [members] = createResource(scope.slug, (org) =>
    call((api) => api["organization.people"]["members.list"]({ params: { org } })),
  )
  const email = (id: string) => members()?.members.find((member) => member.id === id)?.email ?? id

  return (
    <Page
      title="Budgets"
      description="Spend limits in US dollars over UTC days or months. Clients refuse new requests once a budget that binds them is reached."
    >
      <Show when={!budgets.error} fallback={<Failure error={budgets.error} />}>
        <Show when={budgets()} keyed fallback={<Loading />}>
          {(data) => (
            <Show
              when={scope.can("budget.write")}
              fallback={
                <Panel flush>
                  <DataTable
                    rows={data.budgets}
                    empty="No budgets set. Spend is unlimited."
                    columns={[
                      { label: "Applies to", cell: (row) => applies[row.scope] },
                      { label: "Person", cell: (row) => (row.scope === "user" ? email(row.target) : "—") },
                      { label: "Period", cell: (row) => cadence[row.period] },
                      { label: "Limit", align: "end", cell: (row) => money(row.amount) },
                    ]}
                  />
                </Panel>
              }
            >
              <Editor budgets={data.budgets} members={members()?.members ?? []} saved={() => void refetch()} />
            </Show>
          )}
        </Show>
      </Show>
    </Page>
  )
}

function Editor(props: {
  budgets: ReadonlyArray<Budget>
  members: ReadonlyArray<{ id: string; email: string }>
  saved: () => void
}) {
  const scope = useOrg()
  const [rows, setRows] = createStore<Row[]>(props.budgets.map((row) => ({ ...row, amount: String(row.amount) })))
  const [error, setError] = createSignal<string>()
  const people = () => props.members.map((member) => ({ value: member.id, label: member.email }))

  const problem = () => {
    if (rows.some((row) => !row.amount.trim() || !Number.isFinite(Number(row.amount)) || Number(row.amount) < 0))
      return "Every limit must be a dollar amount of zero or more."
    if (rows.some((row) => row.scope === "user" && !row.target)) return "Choose the person for every one-person budget."
    const keys = rows.map((row) => `${row.scope}/${row.scope === "user" ? row.target : ""}/${row.period}`)
    if (new Set(keys).size !== keys.length)
      return "Two budgets apply to the same people over the same period. Remove one of them."
    return undefined
  }

  const save = async () => {
    setError(problem())
    if (error()) return
    const parsed = rows.map((row) => ({
      scope: row.scope,
      target: row.scope === "user" ? row.target : "",
      period: row.period,
      amount: Number(row.amount),
    }))
    await attempt(async () => {
      await call((api) =>
        api["organization.governance"]["budgets.update"]({
          params: { org: scope.slug() },
          payload: { budgets: parsed },
        }),
      )
      props.saved()
    }, "Budgets saved")
  }

  return (
    <Panel
      title="Limits"
      description="“Each person” is the default cap for every member; a one-person budget replaces it for that person."
      actions={
        <Button
          variant="secondary"
          size="sm"
          icon="plus"
          onClick={() => setRows(rows.length, { scope: "member", target: "", period: "month", amount: "" })}
        >
          Add budget
        </Button>
      }
      footer={
        <Button variant="primary" onClick={save}>
          Save budgets
        </Button>
      }
    >
      <div class="budgets">
        <For each={rows} fallback={<Muted>No budgets set. Spend is unlimited.</Muted>}>
          {(row, index) => (
            <div class="budget-row">
              <Choice
                label="Applies to"
                value={row.scope}
                options={scopes}
                onValue={(next) => setRows(index(), "scope", next)}
              />
              <Show when={row.scope === "user"} fallback={<span />}>
                <Choice
                  label="Person"
                  value={row.target}
                  options={people()}
                  placeholder="Choose a person"
                  onValue={(next) => setRows(index(), "target", next)}
                />
              </Show>
              <Choice
                label="Period"
                value={row.period}
                options={periods}
                onValue={(next) => setRows(index(), "period", next)}
              />
              <TextInput
                label="Limit in dollars"
                type="number"
                min="0"
                step="0.01"
                placeholder="100"
                value={row.amount}
                onValue={(value) => setRows(index(), "amount", value)}
              />
              <IconButton
                icon="trash"
                variant="ghost"
                aria-label="Remove budget"
                onClick={() => setRows(produce((list) => void list.splice(index(), 1)))}
              />
            </div>
          )}
        </For>
      </div>
      <Show when={error()}>
        <p class="field-error">{error()}</p>
      </Show>
    </Panel>
  )
}
