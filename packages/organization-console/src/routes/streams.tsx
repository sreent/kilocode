import { Match, Show, Switch, createResource, createSignal } from "solid-js"
import { Button } from "@kilocode/kilo-web-ui/button"
import { Tag } from "@kilocode/kilo-web-ui/tag"
import type { StreamKind } from "@organization/protocol/schema"
import { call } from "../api"
import { useOrg } from "../context"
import { count, when } from "../format"
import { attempt, confirm } from "../components/feedback"
import { Choice, TextInput, Toggle } from "../components/form"
import { Failure, Loading, Muted, Page, Panel } from "../components/page"
import { Secret } from "../components/secret"
import { DataTable } from "../components/table"

type Row = Awaited<ReturnType<typeof listStreams>>["streams"][number]

const listStreams = (org: string) => call((api) => api["organization.insight"]["streams.list"]({ params: { org } }))

const kinds = [
  { value: "webhook", label: "HTTPS webhook" },
  { value: "syslog", label: "Syslog (RFC 5424)" },
  { value: "otlp", label: "OpenTelemetry logs (OTLP/HTTP)" },
] satisfies ReadonlyArray<{ value: StreamKind; label: string }>

function destination(row: Row) {
  const target = row.target
  return target.kind === "syslog" ? `${target.host}:${target.port}` : target.url
}

export function Streams() {
  const scope = useOrg()
  const [streams, { refetch }] = createResource(scope.slug, listStreams)
  const [created, setCreated] = createSignal<string>()

  const update = (row: Row, enabled: boolean) =>
    attempt(
      async () => {
        await call((api) =>
          api["organization.insight"]["streams.update"]({
            params: { org: scope.slug(), id: row.id },
            payload: { enabled },
          }),
        )
        void refetch()
      },
      enabled ? `${row.name} resumed` : `${row.name} paused. It picks up where it stopped when resumed.`,
    )

  const test = (row: Row) =>
    attempt(async () => {
      const result = await call((api) =>
        api["organization.insight"]["streams.test"]({ params: { org: scope.slug(), id: row.id } }),
      )
      if (!result.ok) throw new Error(`The test event was not accepted: ${result.error}`)
    }, `${row.name} accepted the test event`)

  return (
    <Page
      title="Audit streaming"
      description="Send every new audit event to your SIEM as it happens: as signed HTTPS webhooks, syslog, or OpenTelemetry logs. Delivery is in order and at least once, and resumes where it stopped after an outage."
    >
      <Panel title="Streams" flush>
        <Show when={!streams.error} fallback={<Failure error={streams.error} />}>
          <Show when={streams()} fallback={<Loading />}>
            {(data) => (
              <DataTable
                rows={data().streams}
                empty="No streams yet. Audit events stay here and in CSV exports."
                columns={[
                  { label: "Name", cell: (row) => row.name },
                  {
                    label: "Destination",
                    cell: (row) => (
                      <span class="title-with-tag">
                        <span class="mono truncate" title={destination(row)}>
                          {destination(row)}
                        </span>
                        <Show when={row.target.kind === "syslog" && row.target.tls}>
                          <Tag>TLS</Tag>
                        </Show>
                        <Show when={row.target.kind === "otlp"}>
                          <Tag>OTLP</Tag>
                        </Show>
                      </span>
                    ),
                  },
                  {
                    label: "Status",
                    cell: (row) => (
                      <Switch fallback={<Tag tone="success">Delivering</Tag>}>
                        <Match when={!row.enabled}>
                          <Tag>Paused</Tag>
                        </Match>
                        <Match when={row.error}>
                          <span class="stack">
                            <Tag tone="critical">Failing since {when(row.failing)}</Tag>
                            <small class="mono">{row.error}</small>
                          </span>
                        </Match>
                      </Switch>
                    ),
                  },
                  { label: "Pending", align: "end", cell: (row) => count(row.pending) },
                  {
                    label: "Last delivery",
                    cell: (row) =>
                      row.delivered ? <span class="nowrap">{when(row.delivered)}</span> : <Muted>Never</Muted>,
                  },
                  {
                    label: "",
                    align: "end",
                    cell: (row) => (
                      <Show when={scope.can("audit.stream")}>
                        <div class="row-actions">
                          <Button variant="ghost" size="sm" onClick={() => void test(row)}>
                            Send test
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
                                description: "Events stop going to this destination. The audit log itself is kept.",
                                action: "Remove",
                                run: () =>
                                  attempt(async () => {
                                    await call((api) =>
                                      api["organization.insight"]["streams.remove"]({
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
            title="Webhook signing secret"
            value={secret()}
            hint={
              <>
                Each delivery carries <span class="mono">x-org-signature: t=&lt;unix time&gt;,v1=&lt;hex&gt;</span>,
                where the hex is the HMAC-SHA256 of <span class="mono">&lt;t&gt;.&lt;body&gt;</span> with this secret.
                Reject deliveries whose signature differs or whose time is more than a few minutes old.
              </>
            }
            onDismiss={() => setCreated()}
          />
        )}
      </Show>
      <Show when={scope.can("audit.stream")}>
        <AddStream
          created={(secret) => {
            if (secret) setCreated(secret)
            void refetch()
          }}
        />
      </Show>
    </Page>
  )
}

function AddStream(props: { created: (secret: string | null) => void }) {
  const scope = useOrg()
  const [name, setName] = createSignal("")
  const [kind, setKind] = createSignal<StreamKind>("webhook")
  const [url, setUrl] = createSignal("")
  const [header, setHeader] = createSignal("")
  const [value, setValue] = createSignal("")
  const [host, setHost] = createSignal("")
  const [port, setPort] = createSignal("6514")
  const [secure, setSecure] = createSignal(true)
  const [busy, setBusy] = createSignal(false)

  const save = async (event: SubmitEvent) => {
    event.preventDefault()
    setBusy(true)
    let secret: string | null = null
    const ok = await attempt(async () => {
      const result = await call((api) =>
        api["organization.insight"]["streams.create"]({
          params: { org: scope.slug() },
          payload: {
            name: name().trim(),
            enabled: true,
            ...(kind() === "syslog"
              ? { target: { kind: "syslog" as const, host: host().trim(), port: Number(port()), tls: secure() } }
              : {
                  target:
                    kind() === "otlp"
                      ? { kind: "otlp" as const, url: url().trim() }
                      : { kind: "webhook" as const, url: url().trim() },
                  ...(header().trim() ? { headers: { [header().trim()]: value() } } : {}),
                }),
          },
        }),
      )
      secret = result.secret
    }, `${name().trim()} added. New audit events are sent to it from now on.`).finally(() => setBusy(false))
    if (!ok) return
    setName("")
    setUrl("")
    setHeader("")
    setValue("")
    setHost("")
    props.created(secret)
  }

  return (
    <Panel
      title="Add a stream"
      description="A new stream receives events from now on; download older ones from the audit log as CSV."
    >
      <form class="ui-form" onSubmit={save}>
        <div class="grid-2">
          <TextInput label="Name" placeholder="Splunk" value={name()} onValue={setName} required />
          <Choice label="Destination" value={kind()} options={kinds} onValue={setKind} />
        </div>
        <Show
          when={kind() !== "syslog"}
          fallback={
            <>
              <div class="grid-2">
                <TextInput
                  label="Host"
                  placeholder="siem.example.com"
                  value={host()}
                  onValue={setHost}
                  required
                  autocomplete="off"
                />
                <TextInput label="Port" type="number" min="1" max="65535" value={port()} onValue={setPort} required />
              </div>
              <Toggle
                label="Use TLS"
                description="RFC 5425 syslog over TLS, usually port 6514. Turn it off only for a collector on a trusted network."
                checked={secure()}
                onChange={(next) => {
                  if (port() === (secure() ? "6514" : "514")) setPort(next ? "6514" : "514")
                  setSecure(next)
                }}
              />
            </>
          }
        >
          <TextInput
            label="URL"
            type="url"
            placeholder={
              kind() === "otlp"
                ? "https://otel-collector.example.com:4318/v1/logs"
                : "https://http-inputs.example.splunkcloud.com/services/collector/raw"
            }
            hint={
              kind() === "otlp"
                ? "The collector's OTLP/HTTP logs endpoint, usually ending in /v1/logs. Each event is a log record in JSON encoding."
                : "Receives a JSON POST with the org and a batch of events."
            }
            value={url()}
            onValue={setUrl}
            required
          />
          <div class="grid-2">
            <TextInput
              label="Header name"
              placeholder="Authorization"
              hint="Optional, for collectors that authenticate requests."
              value={header()}
              onValue={setHeader}
              autocomplete="off"
            />
            <TextInput
              label="Header value"
              type="password"
              placeholder={kind() === "otlp" ? "Bearer …" : "Splunk 1234-…"}
              hint="Stored encrypted. It cannot be read back."
              autocomplete="new-password"
              value={value()}
              onValue={setValue}
              required={header().trim() !== ""}
            />
          </div>
        </Show>
        <div class="form-actions">
          <Button type="submit" variant="primary" disabled={busy()}>
            Add stream
          </Button>
        </div>
      </form>
    </Panel>
  )
}
