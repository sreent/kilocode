import { For, Show, createResource, createSignal } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { Button } from "@kilocode/kilo-web-ui/button"
import { IconButton } from "@kilocode/kilo-web-ui/icon-button"
import { Tag } from "@kilocode/kilo-web-ui/tag"
import { BudgetScope, Period, type Budget, type BudgetSpend } from "@organization/protocol/schema"
import { call } from "../api"
import { useOrg } from "../context"
import { money } from "../format"
import { attempt } from "../components/feedback"
import { Choice, TextInput } from "../components/form"
import { Failure, Loading, Muted, Page, Panel } from "../components/page"
import { DataTable } from "../components/table"

type Scope = (typeof BudgetScope.literals)[number]
type Cadence = (typeof Period.literals)[number]
type Row = { scope: Scope; target: string; period: Cadence; amount: string }
type Option = { value: string; label: string }

const applies: Record<Scope, string> = {
  org: "Whole organization",
  member: "Each person (default)",
  user: "One person",
  group: "A group, combined",
  suborg: "A sub-organization's allowance",
}
const cadence: Record<Cadence, string> = { day: "Per day", month: "Per month" }
const periods = Period.literals.map((value) => ({ value, label: cadence[value] }))
// Budgets that name who they cover.
const targeted = (scope: Scope) => scope === "user" || scope === "group" || scope === "suborg"

export function Budgets() {
  const scope = useOrg()
  const [budgets, { refetch }] = createResource(scope.slug, (org) =>
    call((api) => api["organization.governance"]["budgets.get"]({ params: { org } })),
  )
  const [members] = createResource(scope.slug, (org) =>
    call((api) => api["organization.people"]["members.list"]({ params: { org } })),
  )
  const [groups] = createResource(scope.slug, (org) =>
    call((api) => api["organization.people"]["groups.list"]({ params: { org } })),
  )
  const [suborgs] = createResource(
    () => !scope.org().parent && scope.slug(),
    (org) => call((api) => api["organization.org"]["suborgs.list"]({ params: { org } })),
  )
  const targets = (): Record<Scope, ReadonlyArray<Option>> => ({
    org: [],
    member: [],
    user: (members()?.members ?? []).map((member) => ({ value: member.id, label: member.email })),
    group: (groups()?.groups ?? []).map((group) => ({ value: group.id, label: group.name })),
    suborg: (suborgs()?.suborgs ?? []).map((org) => ({ value: org.id, label: org.name })),
  })
  // A sub-organization can't hand out allowances, and one without sub-organizations has none to give.
  const scopes = () =>
    BudgetScope.literals
      .filter((value) => value !== "suborg" || targets().suborg.length > 0)
      .map((value) => ({ value, label: applies[value] }))
  const name = (row: Pick<Budget, "scope" | "target">) =>
    targeted(row.scope) ? (targets()[row.scope].find((item) => item.value === row.target)?.label ?? row.target) : "—"

  return (
    <Page
      title="Budgets"
      description="Spend limits in US dollars over UTC days or months. Clients refuse new requests once a budget that binds them is reached, and so does the gateway."
    >
      <Show when={!budgets.error} fallback={<Failure error={budgets.error} />}>
        <Show when={budgets()} keyed fallback={<Loading />}>
          {(data) => (
            <>
              <Spend rows={data.spend} name={name} />
              <Show when={scope.can("budget.write")}>
                <Editor budgets={data.budgets} scopes={scopes()} targets={targets()} saved={() => void refetch()} />
              </Show>
            </>
          )}
        </Show>
      </Show>
    </Page>
  )
}

// Every budget that binds this organization and how much of it this period has used.
function Spend(props: { rows: ReadonlyArray<BudgetSpend>; name: (row: Pick<Budget, "scope" | "target">) => string }) {
  return (
    <Panel
      flush
      title="This period"
      description="What each budget has used so far this UTC day or month. Budgets a parent organization sets bind this one too."
    >
      <DataTable
        rows={props.rows}
        empty="No budgets set. Spend is unlimited."
        columns={[
          {
            label: "Applies to",
            // Seen from a sub-organization, a parent's budgets cover it from above.
            cell: (row) =>
              !row.from
                ? applies[row.scope]
                : row.scope === "suborg"
                  ? "This organization's allowance"
                  : `All of ${row.from}`,
          },
          { label: "Who", cell: (row) => (row.from ? "—" : props.name(row)) },
          { label: "Period", cell: (row) => cadence[row.period] },
          { label: "Limit", align: "end", cell: (row) => money(row.amount) },
          {
            label: "Spent",
            align: "end",
            cell: (row) =>
              row.spent === null ? (
                <span class="muted">Each person's own</span>
              ) : (
                <span class="nowrap">
                  {money(row.spent)}
                  <Show when={row.spent >= row.amount}>
                    {" "}
                    <Tag tone="critical">Reached</Tag>
                  </Show>
                </span>
              ),
          },
          { label: "Set by", cell: (row) => row.from ?? <span class="muted">This organization</span> },
        ]}
      />
    </Panel>
  )
}

function Editor(props: {
  budgets: ReadonlyArray<Budget>
  scopes: ReadonlyArray<{ value: Scope; label: string }>
  targets: Record<Scope, ReadonlyArray<Option>>
  saved: () => void
}) {
  const scope = useOrg()
  const [rows, setRows] = createStore<Row[]>(props.budgets.map((row) => ({ ...row, amount: String(row.amount) })))
  const [error, setError] = createSignal<string>()

  const problem = () => {
    if (rows.some((row) => !row.amount.trim() || !Number.isFinite(Number(row.amount)) || Number(row.amount) < 0))
      return "Every limit must be a dollar amount of zero or more."
    if (rows.some((row) => targeted(row.scope) && !row.target))
      return "Choose who each one-person, group or sub-organization budget is for."
    const keys = rows.map((row) => `${row.scope}/${targeted(row.scope) ? row.target : ""}/${row.period}`)
    if (new Set(keys).size !== keys.length)
      return "Two budgets apply to the same people over the same period. Remove one of them."
    return undefined
  }

  const save = async () => {
    setError(problem())
    if (error()) return
    const parsed = rows.map((row) => ({
      scope: row.scope,
      target: targeted(row.scope) ? row.target : "",
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
      description="“Each person” is the default cap for every member; a one-person budget replaces it for that person. A group budget caps what its members spend together. The whole organization's budget counts its sub-organizations' spend too, and an allowance caps one sub-organization, whose own admins can't change it."
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
                options={props.scopes}
                onValue={(next) => {
                  setRows(index(), "scope", next)
                  setRows(index(), "target", "")
                }}
              />
              <Show when={targeted(row.scope)} fallback={<span />}>
                <Choice
                  label={row.scope === "user" ? "Person" : row.scope === "group" ? "Group" : "Sub-organization"}
                  value={row.target}
                  options={props.targets[row.scope]}
                  placeholder="Choose"
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
