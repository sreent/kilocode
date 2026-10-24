import { Show, createResource, createSignal } from "solid-js"
import { Button } from "@kilocode/kilo-web-ui/button"
import { Tag } from "@kilocode/kilo-web-ui/tag"
import { call } from "../api"
import { useOrg } from "../context"
import { count, money, range, when } from "../format"
import { attempt } from "../components/feedback"
import { Check, TextInput } from "../components/form"
import { Failure, Loading, Muted, Page, Panel } from "../components/page"
import { DataTable } from "../components/table"

type Filter = { provider: string; failed: boolean; from: string; to: string }
type Row = Awaited<ReturnType<typeof list>>["calls"][number]

const size = 200

const list = (org: string, filter: Filter, before?: number) =>
  call((api) =>
    api["organization.gateway"]["gateway.calls"]({
      params: { org },
      query: {
        ...(filter.provider.trim() ? { provider: filter.provider.trim() } : {}),
        ...(filter.failed ? { failed: "true" as const } : {}),
        ...range(filter.from, filter.to),
        limit: size,
        ...(before ? { before } : {}),
      },
    }),
  )

// What the gateway or the upstream said, as one tag.
function Outcome(props: { row: Row }) {
  const ok = () => props.row.status < 400 && !props.row.code
  return (
    <Tag tone={ok() ? "success" : props.row.status === 429 || props.row.status === 402 ? "warning" : "critical"}>
      {props.row.code ? `${props.row.status} ${props.row.code}` : String(props.row.status)}
    </Tag>
  )
}

export function Calls() {
  const scope = useOrg()
  const [provider, setProvider] = createSignal("")
  const [failed, setFailed] = createSignal(false)
  const [from, setFrom] = createSignal("")
  const [to, setTo] = createSignal("")
  const [filter, setFilter] = createSignal<Filter>({ provider: "", failed: false, from: "", to: "" })
  const [more, setMore] = createSignal<{ calls: ReadonlyArray<Row>; next: number | null }>()
  const [busy, setBusy] = createSignal(false)
  const [open, setOpen] = createSignal<number>()
  const [first] = createResource(
    () => ({ org: scope.slug(), filter: filter() }),
    (input) => {
      setMore(undefined)
      return list(input.org, input.filter)
    },
  )
  const [detail] = createResource(
    () => (open() === undefined ? undefined : { org: scope.slug(), id: open()! }),
    (input) => call((api) => api["organization.gateway"]["gateway.call"]({ params: { org: input.org, id: input.id } })),
  )
  const rows = () => [...(first()?.calls ?? []), ...(more()?.calls ?? [])]
  const last = () => more() ?? first()
  const done = () => !last() || last()!.calls.length < size || last()!.next === null

  const loadMore = async () => {
    const cursor = last()?.next
    if (!cursor) return
    setBusy(true)
    await attempt(async () => {
      const page = await list(scope.slug(), filter(), cursor)
      setMore({ calls: [...(more()?.calls ?? []), ...page.calls], next: page.next })
    }).finally(() => setBusy(false))
  }

  return (
    <Page
      title="Gateway call log"
      description="Every call through the LLM gateway, newest first: who made it, the model, the outcome, tokens and cost. Refused calls are here too, with the reason."
    >
      <form
        class="config-toolbar"
        onSubmit={(event) => {
          event.preventDefault()
          setFilter({ provider: provider(), failed: failed(), from: from(), to: to() })
        }}
      >
        <div class="config-toolbar-controls">
          <TextInput label="Provider" placeholder="litellm" value={provider()} onValue={setProvider} />
          <TextInput label="From" type="date" value={from()} onValue={setFrom} />
          <TextInput label="To" type="date" value={to()} onValue={setTo} />
          <Check checked={failed()} onChange={setFailed}>
            Refused or failed only
          </Check>
          <Button type="submit" variant="primary">
            Filter
          </Button>
        </div>
      </form>
      <Show when={open() !== undefined}>
        <Panel
          title={`Call ${open()}`}
          actions={
            <Button variant="ghost" size="sm" onClick={() => setOpen(undefined)}>
              Close
            </Button>
          }
        >
          <Show when={!detail.error} fallback={<Failure error={detail.error} />}>
            <Show when={detail()} fallback={<Loading />}>
              {(item) => (
                <div class="ui-form">
                  <p>
                    {item().method} <span class="mono">{item().path}</span> by{" "}
                    {item().user?.email ?? "a removed person"} from{" "}
                    <span class="mono">{item().ip ?? "unknown address"}</span>, session{" "}
                    <span class="mono">{item().session ?? "—"}</span>, project{" "}
                    <span class="mono">{item().project ?? "—"}</span>.
                  </p>
                  <Show
                    when={item().request !== null || item().response !== null}
                    fallback={
                      <Muted>
                        Bodies aren't kept for this call. Turn on "Keep request and response bodies" on the gateway page
                        to keep them for new calls.
                      </Muted>
                    }
                  >
                    <h3>Request</h3>
                    <Show
                      when={item().request !== null}
                      fallback={<Muted>Not read: the call was refused first.</Muted>}
                    >
                      <pre class="code-block">{item().request}</pre>
                    </Show>
                    <h3>Response</h3>
                    <Show when={item().response !== null} fallback={<Muted>None.</Muted>}>
                      <pre class="code-block">{item().response}</pre>
                    </Show>
                  </Show>
                </div>
              )}
            </Show>
          </Show>
        </Panel>
      </Show>
      <Show when={!first.error} fallback={<Failure error={first.error} />}>
        <Show when={first()} fallback={<Loading />}>
          <Panel flush>
            <DataTable
              rows={rows()}
              empty="No calls match these filters."
              columns={[
                { label: "Time", cell: (row) => <span class="nowrap">{when(row.at)}</span> },
                { label: "Person", cell: (row) => row.user?.email ?? <span class="muted">removed</span> },
                {
                  label: "Model",
                  cell: (row) => (
                    <span class="mono">
                      {row.provider}
                      {row.model ? `/${row.model}` : ""}
                    </span>
                  ),
                },
                { label: "Outcome", cell: (row) => <Outcome row={row} /> },
                {
                  label: "Tokens",
                  align: "end",
                  cell: (row) => (
                    <span class="nowrap" title={`${count(row.tokens.read)} cached`}>
                      {count(row.tokens.input + row.tokens.read + row.tokens.write)} →{" "}
                      {count(row.tokens.output + row.tokens.reasoning)}
                    </span>
                  ),
                },
                { label: "Cost", align: "end", cell: (row) => money(row.cost) },
                {
                  label: "Time taken",
                  align: "end",
                  cell: (row) => (row.latency < 1000 ? `${row.latency} ms` : `${(row.latency / 1000).toFixed(1)} s`),
                },
                {
                  label: "",
                  align: "end",
                  cell: (row) => (
                    <Button variant="ghost" size="sm" onClick={() => setOpen(row.id)}>
                      {row.bodies ? "Open" : "Details"}
                    </Button>
                  ),
                },
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
