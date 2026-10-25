import { For, Show, createResource, createSignal } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { Button } from "@kilocode/kilo-web-ui/button"
import { IconButton } from "@kilocode/kilo-web-ui/icon-button"
import { Tag } from "@kilocode/kilo-web-ui/tag"
import { filtering, shortfall } from "@organization/protocol/match"
import type { DataPolicy, DataTerms } from "@organization/protocol/schema"
import { call } from "../api"
import { useOrg } from "../context"
import { attempt } from "../components/feedback"
import { Check, TextInput, Toggle } from "../components/form"
import { Failure, Loading, Muted, Page, Panel } from "../components/page"

type Current = Awaited<ReturnType<typeof getPolicy>>
type Row = { provider: string; training: boolean; retention: string; regions: string; routing: boolean; note: string }

const getPolicy = (org: string) => call((api) => api["organization.governance"]["policy.get"]({ params: { org } }))

// Region codes as typed, "eu, UK" for instance.
const codes = (text: string) => [
  ...new Set(
    text
      .split(/[\s,]+/)
      .map((item) => item.toLowerCase())
      .filter(Boolean),
  ),
]

// Days as typed; blank isn't zero, since zero retention is a claim an admin has to make.
const days = (text: string) => (/^\d+$/.test(text.trim()) ? Number(text) : undefined)

// The aggregators whose APIs take OpenRouter's routing preferences.
const aggregators = new Set(["openrouter"])

const blank = (): Row => ({ provider: "", training: false, retention: "", regions: "", routing: false, note: "" })

export function Data() {
  const scope = useOrg()
  const [policy, { refetch }] = createResource(scope.slug, getPolicy)
  return (
    <Page
      title="Data policy"
      description="Which AI providers may see your organization's code and prompts. Record what each provider does with data under your agreement with it, then choose filters: clients refuse providers that don't meet them, and so does the gateway."
    >
      <Show when={!policy.error} fallback={<Failure error={policy.error} />}>
        <Show when={policy()} keyed fallback={<Loading />}>
          {(current) => <Editor current={current} saved={() => void refetch()} />}
        </Show>
      </Show>
    </Page>
  )
}

function Editor(props: { current: Current; saved: () => void }) {
  const scope = useOrg()
  const locked = () => !scope.can("policy.write")
  const data = props.current.policy.data
  const [training, setTraining] = createSignal(data.training === "denied")
  const [zero, setZero] = createSignal(data.retention === "zero")
  const [regions, setRegions] = createSignal(data.regions.join(", "))
  const [rows, setRows] = createStore<Row[]>(
    // By name: the database keeps an object's keys in an order of its own.
    Object.entries(data.providers)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([provider, terms]) => ({
        provider,
        training: terms.training,
        retention: String(terms.retention),
        regions: terms.regions.join(", "),
        routing: terms.routing,
        note: terms.note ?? "",
      })),
  )

  const filters = (): Pick<DataPolicy, "training" | "retention" | "regions"> => ({
    training: training() ? "denied" : "allowed",
    retention: zero() ? "zero" : "any",
    regions: codes(regions()),
  })
  const terms = (row: Row): DataTerms => ({
    training: row.training,
    retention: days(row.retention) ?? 0,
    regions: codes(row.regions),
    routing: row.routing,
    ...(row.note.trim() ? { note: row.note.trim() } : {}),
  })
  // Judged against the filters as they stand in the form, before they're saved.
  const verdict = (row: Row) => {
    if (!filtering(filters())) return { tone: "neutral" as const, label: "No filter", reason: undefined }
    if (days(row.retention) === undefined) return { tone: "warning" as const, label: "Incomplete", reason: undefined }
    const reason = shortfall(filters(), terms(row))
    return reason
      ? { tone: "critical" as const, label: "Refused", reason }
      : { tone: "success" as const, label: "Allowed", reason: undefined }
  }

  const save = (event: SubmitEvent) => {
    event.preventDefault()
    void attempt(async () => {
      const listed = rows.filter((row) => row.provider.trim())
      const missing = listed.find((row) => days(row.retention) === undefined)
      if (missing) throw new Error(`Enter how many days ${missing.provider.trim()} keeps data, 0 if it keeps none.`)
      const providers = Object.fromEntries(listed.map((row) => [row.provider.trim().toLowerCase(), terms(row)]))
      if (Object.keys(providers).length !== listed.length) throw new Error("Each provider can be listed once.")
      await call((api) =>
        api["organization.governance"]["policy.update"]({
          params: { org: scope.slug() },
          payload: { ...props.current.policy, data: { ...filters(), providers } },
        }),
      )
      props.saved()
    }, "Data policy saved. Clients pick it up at their next refresh.")
  }

  return (
    <form class="ui-form" onSubmit={save}>
      <Panel
        title="Filters"
        description="With any filter on, only providers whose terms below meet every filter can be used. A provider without terms is refused."
      >
        <div class="grid-2">
          <Toggle
            label="Refuse providers that may train on your data"
            description="Only providers that don't use prompts and completions to train models."
            checked={training()}
            disabled={locked()}
            onChange={setTraining}
          />
          <Toggle
            label="Zero data retention only"
            description="Only providers that keep nothing once they've answered."
            checked={zero()}
            disabled={locked()}
            onChange={setZero}
          />
        </div>
        <TextInput
          label="Process data only in these regions"
          placeholder="Any region"
          hint="Region codes as you record them below, such as eu, uk."
          value={regions()}
          disabled={locked()}
          onValue={setRegions}
        />
      </Panel>
      <Panel
        title="Provider terms"
        description="By the provider id clients use: anthropic, openai, openrouter, or the id of a gateway provider. OpenRouter routes each request to one of many companies; with routing on, requests ask for only endpoints that meet the training and retention filters."
        actions={
          <Show when={!locked()}>
            <Button
              variant="secondary"
              size="sm"
              icon="plus"
              type="button"
              onClick={() => setRows(rows.length, blank())}
            >
              Add provider
            </Button>
          </Show>
        }
        footer={
          <Show when={!locked()}>
            <Button type="submit" variant="primary">
              Save data policy
            </Button>
          </Show>
        }
      >
        <div class="edit-rows">
          <For each={rows} fallback={<Muted>No provider terms recorded yet.</Muted>}>
            {(row, index) => (
              <div
                class="edit-row"
                style={{
                  "--columns":
                    "minmax(7rem, 1fr) minmax(5rem, 0.6fr) minmax(6rem, 0.8fr) minmax(8rem, 1.4fr) auto minmax(5.5rem, auto) auto",
                }}
              >
                <TextInput
                  label="Provider"
                  placeholder="anthropic"
                  value={row.provider}
                  disabled={locked()}
                  onValue={(value) => {
                    setRows(index(), "provider", value)
                    if (aggregators.has(value.trim().toLowerCase())) setRows(index(), "routing", true)
                  }}
                />
                <TextInput
                  label="Keeps data (days)"
                  type="number"
                  min="0"
                  placeholder="0 for none"
                  value={row.retention}
                  disabled={locked()}
                  onValue={(value) => setRows(index(), "retention", value)}
                />
                <TextInput
                  label="Regions"
                  placeholder="us"
                  value={row.regions}
                  disabled={locked()}
                  onValue={(value) => setRows(index(), "regions", value)}
                />
                <TextInput
                  label="Note"
                  placeholder="Optional"
                  value={row.note}
                  disabled={locked()}
                  onValue={(value) => setRows(index(), "note", value)}
                />
                <span class="stack">
                  <Check
                    checked={row.training}
                    disabled={locked()}
                    onChange={(value) => setRows(index(), "training", value)}
                  >
                    May train
                  </Check>
                  <Check
                    checked={row.routing}
                    disabled={locked()}
                    onChange={(value) => setRows(index(), "routing", value)}
                  >
                    Routes requests
                  </Check>
                </span>
                <span>
                  <Tag tone={verdict(row).tone}>{verdict(row).label}</Tag>
                </span>
                <Show when={!locked()} fallback={<span />}>
                  <IconButton
                    icon="trash"
                    variant="ghost"
                    aria-label={`Remove ${row.provider || "provider"}`}
                    onClick={() => setRows(produce((list) => void list.splice(index(), 1)))}
                  />
                </Show>
                <Show when={verdict(row).reason}>
                  {(reason) => <small class="row-note">Refused: {reason()}.</small>}
                </Show>
              </div>
            )}
          </For>
        </div>
      </Panel>
    </form>
  )
}
