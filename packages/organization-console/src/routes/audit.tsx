import { For, Show, createResource, createSignal } from "solid-js"
import { Button } from "@kilocode/kilo-web-ui/button"
import type { ToolAudit } from "@organization/protocol/schema"
import { call, download } from "../api"
import { useOrg } from "../context"
import { range, short, when } from "../format"
import { attempt } from "../components/feedback"
import { Choice, TextInput } from "../components/form"
import { Failure, Loading, Page, Panel } from "../components/page"
import { DataTable } from "../components/table"

type Filter = { action: string; actor: string; from: string; to: string }
type Event = Awaited<ReturnType<typeof list>>["events"][number]

const size = 200

const levels: ReadonlyArray<{ value: ToolAudit; label: string }> = [
  { value: "off", label: "Off" },
  { value: "summary", label: "Summary" },
  { value: "inputs", label: "Summary and inputs" },
]

const list = (org: string, filter: Filter, before?: number) =>
  call((api) =>
    api["organization.insight"]["audit.list"]({
      params: { org },
      query: { ...criteria(filter), limit: size, ...(before ? { before } : {}) },
    }),
  )

function criteria(filter: Filter) {
  return {
    ...(filter.action.trim() ? { action: filter.action.trim() } : {}),
    ...(filter.actor.trim() ? { actor: filter.actor.trim() } : {}),
    ...range(filter.from, filter.to),
  }
}

export function Audit() {
  const scope = useOrg()
  const [action, setAction] = createSignal("")
  const [actor, setActor] = createSignal("")
  const [from, setFrom] = createSignal("")
  const [to, setTo] = createSignal("")
  const [filter, setFilter] = createSignal({ action: "", actor: "", from: "", to: "" })
  // Later pages are appended to the first one; a new filter starts over.
  const [more, setMore] = createSignal<{ events: ReadonlyArray<Event>; next: number | null }>()
  const [busy, setBusy] = createSignal(false)
  const [first] = createResource(
    () => ({ org: scope.slug(), filter: filter() }),
    (input) => {
      setMore(undefined)
      return list(input.org, input.filter)
    },
  )
  const events = () => [...(first()?.events ?? []), ...(more()?.events ?? [])]
  const last = () => more() ?? first()
  const done = () => !last() || last()!.events.length < size || last()!.next === null

  const loadMore = async () => {
    const cursor = last()?.next
    if (!cursor) return
    setBusy(true)
    await attempt(async () => {
      const page = await list(scope.slug(), filter(), cursor)
      setMore({ events: [...(more()?.events ?? []), ...page.events], next: page.next })
    }).finally(() => setBusy(false))
  }

  const exportCsv = () =>
    attempt(async () => {
      const text = await call((api) =>
        api["organization.insight"]["audit.export"]({ params: { org: scope.slug() }, query: criteria(filter()) }),
      )
      download(`audit-${scope.slug()}.csv`, text)
    })

  return (
    <Page
      title="Audit log"
      description="Every administrative change and sign-in in this organization, newest first, and the tools agents run when the organization logs them."
      actions={
        <Button variant="secondary" icon="download" onClick={exportCsv}>
          Export CSV
        </Button>
      }
    >
      <ToolRuns />
      <form
        class="config-toolbar"
        onSubmit={(event) => {
          event.preventDefault()
          setFilter({ action: action(), actor: actor(), from: from(), to: to() })
        }}
      >
        <div class="config-toolbar-controls">
          <TextInput
            label="Actions"
            placeholder="user.login, member.change_role"
            value={action()}
            onValue={setAction}
            class="grow"
          />
          <TextInput label="Actor" type="email" placeholder="admin@company.com" value={actor()} onValue={setActor} />
          <TextInput label="From" type="date" value={from()} onValue={setFrom} />
          <TextInput label="To" type="date" value={to()} onValue={setTo} />
          <Button type="submit" variant="primary">
            Filter
          </Button>
        </div>
      </form>
      <Show when={!first.error} fallback={<Failure error={first.error} />}>
        <Show when={first()} fallback={<Loading />}>
          <Panel flush>
            <DataTable
              rows={events()}
              empty="No events match these filters."
              columns={[
                { label: "Time", cell: (row) => <span class="nowrap">{when(row.at)}</span> },
                { label: "Action", cell: (row) => <span class="mono">{row.action}</span> },
                { label: "Actor", cell: (row) => row.email ?? <span class="muted">system</span> },
                {
                  label: "Target",
                  cell: (row) => (
                    <span class="mono nowrap" title={row.target ?? undefined}>
                      {row.target ? short(row.target) : ""}
                    </span>
                  ),
                },
                {
                  label: "Details",
                  cell: (row) => <Details value={row.details} />,
                },
                { label: "IP", cell: (row) => <span class="mono">{row.ip ?? ""}</span> },
              ]}
            />
          </Panel>
          <Show when={!done()}>
            <div class="load-more">
              <Button variant="secondary" onClick={loadMore} disabled={busy()}>
                Load more
              </Button>
            </div>
          </Show>
        </Show>
      </Show>
    </Page>
  )
}

// Whether clients add the tools agents run to this log, as client.tool_run events.
function ToolRuns() {
  const scope = useOrg()
  const [policy, { refetch }] = createResource(scope.slug, (org) =>
    call((api) => api["organization.governance"]["policy.get"]({ params: { org } })),
  )
  const save = (level: ToolAudit) =>
    attempt(
      async () => {
        const current = policy()!.policy
        await call((api) =>
          api["organization.governance"]["policy.update"]({
            params: { org: scope.slug() },
            payload: { ...current, audit: { ...current.audit, tools: level } },
          }),
        )
        void refetch()
      },
      level === "off" ? "Tool runs are no longer logged." : "Clients log tool runs from their next policy refresh.",
    )

  return (
    <Panel
      title="Agent tool runs"
      description="Each tool an agent runs, logged for the person who ran it: the tool, what it acted on (a file, a site, a program), how long it took and whether it failed. With inputs, also what it was given, such as a whole command line or the text written to a file, up to 4,000 characters."
    >
      <Show when={!policy.error} fallback={<Failure error={policy.error} />}>
        <Show when={policy()} fallback={<Loading />}>
          {(current) => (
            <div class="grid-2">
              <Choice
                label="Log"
                value={current().policy.audit.tools}
                options={levels}
                disabled={!scope.can("policy.write")}
                hint={scope.can("policy.write") ? undefined : "Owners decide what is logged."}
                onValue={(level) => void save(level)}
              />
            </div>
          )}
        </Show>
      </Show>
    </Panel>
  )
}

function Details(props: { value: unknown }) {
  const entries = () =>
    props.value && typeof props.value === "object" && !Array.isArray(props.value) ? Object.entries(props.value) : []
  return (
    <Show
      when={entries().length > 0}
      fallback={<span class="mono wrap">{props.value == null ? "" : JSON.stringify(props.value)}</span>}
    >
      <dl class="details">
        <For each={entries()}>
          {([key, value]) => (
            <div>
              <dt>{key}</dt>
              <dd class="mono wrap">{typeof value === "string" ? value : JSON.stringify(value)}</dd>
            </div>
          )}
        </For>
      </dl>
    </Show>
  )
}
