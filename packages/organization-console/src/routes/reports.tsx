import { Match, Show, Switch, createResource, createSignal } from "solid-js"
import { Button } from "@kilocode/kilo-web-ui/button"
import { Tag } from "@kilocode/kilo-web-ui/tag"
import { ReportCadence, ReportFormat } from "@organization/protocol/schema"
import { call } from "../api"
import { useOrg } from "../context"
import { when } from "../format"
import { attempt, confirm } from "../components/feedback"
import { Choice, TextInput } from "../components/form"
import { Failure, Loading, Muted, Page, Panel } from "../components/page"
import { Secret } from "../components/secret"
import { DataTable } from "../components/table"

type Cadence = (typeof ReportCadence.literals)[number]
type Format = (typeof ReportFormat.literals)[number]
type Row = Awaited<ReturnType<typeof listReports>>["reports"][number]

const listReports = (org: string) => call((api) => api["organization.insight"]["reports.list"]({ params: { org } }))

const cadences: ReadonlyArray<{ value: Cadence; label: string }> = [
  { value: "weekly", label: "Every Monday, for the week before" },
  { value: "monthly", label: "On the 1st, for the month before" },
]
const formats: ReadonlyArray<{ value: Format; label: string }> = [
  { value: "text", label: "Chat message (Slack, Mattermost, Google Chat)" },
  { value: "json", label: "JSON summary" },
]

export function Reports() {
  const scope = useOrg()
  const [reports, { refetch }] = createResource(scope.slug, listReports)
  const [created, setCreated] = createSignal<string>()
  const editable = () => scope.can("report.write")

  const update = (row: Row, enabled: boolean) =>
    attempt(
      async () => {
        await call((api) =>
          api["organization.insight"]["reports.update"]({
            params: { org: scope.slug(), id: row.id },
            payload: { enabled },
          }),
        )
        void refetch()
      },
      enabled ? `${row.name} resumed` : `${row.name} paused`,
    )

  const send = (row: Row) =>
    attempt(async () => {
      const result = await call((api) =>
        api["organization.insight"]["reports.send"]({ params: { org: scope.slug(), id: row.id } }),
      )
      if (!result.ok) throw new Error(`The report was not accepted: ${result.error}`)
    }, `${row.name} sent for its last whole period`)

  return (
    <Page
      title="Scheduled reports"
      description="A summary of the organization's AI use after each week or month: spend and how it moved, requests, how many members used tucode, the top models and spenders. Posted to a webhook an hour after the period ends, in UTC."
    >
      <Panel title="Reports" flush>
        <Show when={!reports.error} fallback={<Failure error={reports.error} />}>
          <Show when={reports()} fallback={<Loading />}>
            {(data) => (
              <DataTable
                rows={data().reports}
                empty="No reports yet."
                columns={[
                  { label: "Name", cell: (row) => row.name },
                  { label: "Every", cell: (row) => (row.cadence === "weekly" ? "Week" : "Month") },
                  {
                    label: "Destination",
                    cell: (row) => (
                      <span class="mono truncate" title={row.url}>
                        {new URL(row.url).host}
                      </span>
                    ),
                  },
                  {
                    label: "Status",
                    cell: (row) => (
                      <Switch fallback={<Tag tone="success">Scheduled</Tag>}>
                        <Match when={!row.enabled}>
                          <Tag>Paused</Tag>
                        </Match>
                        <Match when={row.error}>
                          <span class="stack">
                            <Tag tone="critical">Failing</Tag>
                            <small class="mono">{row.error}</small>
                          </span>
                        </Match>
                      </Switch>
                    ),
                  },
                  {
                    label: "Next",
                    cell: (row) => (row.enabled ? <span class="nowrap">{when(row.next)}</span> : <Muted>—</Muted>),
                  },
                  {
                    label: "Last sent",
                    cell: (row) => (row.sent ? <span class="nowrap">{when(row.sent)}</span> : <Muted>Never</Muted>),
                  },
                  {
                    label: "",
                    align: "end",
                    cell: (row) => (
                      <Show when={editable()}>
                        <div class="row-actions">
                          <Button variant="ghost" size="sm" onClick={() => void send(row)}>
                            Send now
                          </Button>
                          <Button variant="ghost" size="sm" onClick={() => void update(row, !row.enabled)}>
                            {row.enabled ? "Pause" : "Resume"}
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            class="danger"
                            onClick={() =>
                              confirm({
                                title: `Remove ${row.name}?`,
                                description: "No more reports go to this destination.",
                                action: "Remove",
                                run: () =>
                                  attempt(async () => {
                                    await call((api) =>
                                      api["organization.insight"]["reports.remove"]({
                                        params: { org: scope.slug(), id: row.id },
                                      }),
                                    )
                                    void refetch()
                                  }, `${row.name} removed`),
                              })
                            }
                          >
                            Remove
                          </Button>
                        </div>
                      </Show>
                    ),
                  },
                ]}
              />
            )}
          </Show>
        </Show>
      </Panel>
      <Show when={created()}>
        {(secret) => (
          <Secret
            title="Report signing secret"
            value={secret()}
            hint={
              <>
                Each delivery carries <span class="mono">x-org-signature: t=&lt;unix time&gt;,v1=&lt;hex&gt;</span>,
                where the hex is the HMAC-SHA256 of <span class="mono">&lt;t&gt;.&lt;body&gt;</span> with this secret,
                like audit streams. Chat tools ignore it; your own receivers can check it.
              </>
            }
            onDismiss={() => setCreated()}
          />
        )}
      </Show>
      <Show when={editable()}>
        <AddReport
          created={(secret) => {
            setCreated(secret)
            void refetch()
          }}
        />
      </Show>
    </Page>
  )
}

function AddReport(props: { created: (secret: string) => void }) {
  const scope = useOrg()
  const [name, setName] = createSignal("")
  const [cadence, setCadence] = createSignal<Cadence>("weekly")
  const [format, setFormat] = createSignal<Format>("text")
  const [url, setUrl] = createSignal("")

  const add = async (event: SubmitEvent) => {
    event.preventDefault()
    await attempt(async () => {
      const result = await call((api) =>
        api["organization.insight"]["reports.create"]({
          params: { org: scope.slug() },
          payload: { name: name().trim(), cadence: cadence(), format: format(), url: url().trim(), enabled: true },
        }),
      )
      setName("")
      setUrl("")
      props.created(result.secret)
    }, "Report scheduled")
  }

  return (
    <Panel title="New report">
      <form class="ui-form" onSubmit={add}>
        <div class="grid-2">
          <TextInput label="Name" placeholder="Weekly to #ai-usage" value={name()} onValue={setName} required />
          <TextInput
            label="Webhook URL"
            type="url"
            placeholder="https://hooks.slack.com/services/…"
            value={url()}
            onValue={setUrl}
            required
          />
        </div>
        <div class="grid-2">
          <Choice label="When" value={cadence()} options={cadences} onValue={setCadence} />
          <Choice label="Format" value={format()} options={formats} onValue={setFormat} />
        </div>
        <div class="form-actions">
          <Button type="submit" variant="primary" disabled={!name().trim() || !url().trim()}>
            Schedule report
          </Button>
        </div>
      </form>
    </Panel>
  )
}
