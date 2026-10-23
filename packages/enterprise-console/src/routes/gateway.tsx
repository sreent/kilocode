import { Show, createResource, createSignal } from "solid-js"
import { Button } from "@kilocode/kilo-web-ui/button"
import { Tag } from "@kilocode/kilo-web-ui/tag"
import type { GatewayKind } from "@enterprise/protocol/schema"
import { call } from "../api"
import { useOrg } from "../context"
import { when } from "../format"
import { attempt, confirm } from "../components/feedback"
import { Choice, TextInput, Toggle } from "../components/form"
import { Failure, Loading, Muted, Page, Panel } from "../components/page"
import { Copyable } from "../components/secret"
import { DataTable } from "../components/table"

type Provider = Awaited<ReturnType<typeof getGateway>>["providers"][number]

const getGateway = (org: string) => call((api) => api["enterprise.gateway"]["gateway.get"]({ params: { org } }))
const getPolicy = (org: string) => call((api) => api["enterprise.governance"]["policy.get"]({ params: { org } }))

const kinds = [
  { value: "anthropic", label: "Anthropic Messages" },
  { value: "openai", label: "OpenAI Responses and Chat Completions" },
  { value: "openai-compatible", label: "OpenAI-compatible Chat Completions" },
] satisfies ReadonlyArray<{ value: GatewayKind; label: string }>

// Where each API usually lives, offered as the upstream until an admin types their own.
const defaults: Record<GatewayKind, string> = {
  anthropic: "https://api.anthropic.com/v1",
  openai: "https://api.openai.com/v1",
  "openai-compatible": "https://openrouter.ai/api/v1",
}

export function Gateway() {
  const scope = useOrg()
  const [gateway, { refetch }] = createResource(scope.slug, getGateway)
  const [editing, setEditing] = createSignal<Provider>()
  const [id, setId] = createSignal("")
  const [kind, setKind] = createSignal<GatewayKind>("anthropic")
  const [base, setBase] = createSignal(defaults.anthropic)
  const [key, setKey] = createSignal("")
  const [busy, setBusy] = createSignal(false)

  const edit = (provider?: Provider) => {
    setEditing(provider)
    setId(provider?.id ?? "")
    setKind(provider?.kind ?? "anthropic")
    setBase(provider?.base ?? defaults.anthropic)
    setKey("")
  }

  const pick = (next: GatewayKind) => {
    // Swap the suggested upstream along with the API, but never an address someone typed.
    if (!base().trim() || Object.values(defaults).includes(base().trim())) setBase(defaults[next])
    setKind(next)
  }

  const save = async (event: SubmitEvent) => {
    event.preventDefault()
    const target = id().trim().toLowerCase()
    setBusy(true)
    const ok = await attempt(
      () =>
        call((api) =>
          api["enterprise.gateway"]["gateway.set"]({
            params: { org: scope.slug(), id: target },
            payload: { kind: kind(), base: base().trim(), ...(key() ? { key: key() } : {}) },
          }),
        ),
      editing() ? `${target} updated` : `${target} now goes through the gateway`,
    ).finally(() => setBusy(false))
    if (!ok) return
    edit(undefined)
    void refetch()
  }

  return (
    <Page
      title="LLM gateway"
      description="Route model providers through this server. It holds the organization's API keys, enforces model policy and budgets on every call, and meters usage itself."
    >
      <Show when={!gateway.error} fallback={<Failure error={gateway.error} />}>
        <Show when={gateway()} fallback={<Loading />}>
          {(data) => (
            <>
              <Routing url={data().url} />
              <Panel
                title="Providers"
                description="Clients send these providers' requests to the gateway, with their enterprise sign-in as the API key. People never see the keys."
                flush
              >
                <DataTable
                  rows={data().providers}
                  empty="No providers go through the gateway yet. Clients call providers directly with their own keys."
                  columns={[
                    { label: "Provider", cell: (row) => <span class="mono">{row.id}</span> },
                    { label: "API", cell: (row) => <Tag>{kinds.find((item) => item.value === row.kind)?.label}</Tag> },
                    { label: "Upstream", cell: (row) => <span class="mono">{row.base}</span> },
                    {
                      label: "Key",
                      cell: (row) => (row.hint ? <span class="mono nowrap">…{row.hint}</span> : <Muted>Set</Muted>),
                    },
                    { label: "Updated", cell: (row) => when(row.updated) },
                    {
                      label: "",
                      align: "end",
                      cell: (row) => (
                        <Show when={scope.can("gateway.write")}>
                          <div class="row-actions">
                            <Button variant="ghost" size="sm" onClick={() => edit(row)}>
                              Edit
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              class="danger"
                              onClick={() =>
                                confirm({
                                  title: `Stop routing ${row.id}?`,
                                  description:
                                    "The organization's key is deleted. Clients call the provider directly again at their next policy refresh, with keys of their own.",
                                  action: "Remove",
                                  run: () =>
                                    attempt(async () => {
                                      await call((api) =>
                                        api["enterprise.gateway"]["gateway.remove"]({
                                          params: { org: scope.slug(), id: row.id },
                                        }),
                                      )
                                      if (editing()?.id === row.id) edit(undefined)
                                      void refetch()
                                    }, `${row.id} removed from the gateway`),
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
              </Panel>
            </>
          )}
        </Show>
      </Show>
      <Show when={scope.can("gateway.write")}>
        <Panel
          title={editing() ? `Edit ${editing()!.id}` : "Add a provider"}
          description="Use the client's provider id, such as anthropic, openai or openrouter. Its models and prices come from the models.dev catalog."
          actions={
            <Show when={editing()}>
              <Button variant="ghost" size="sm" onClick={() => edit(undefined)}>
                Cancel
              </Button>
            </Show>
          }
        >
          <form class="ui-form" onSubmit={save}>
            <div class="grid-2">
              <TextInput
                label="Provider id"
                placeholder="anthropic"
                value={id()}
                onValue={setId}
                disabled={editing() !== undefined}
                required
                autocomplete="off"
                spellcheck={false}
              />
              <Choice label="API" value={kind()} options={kinds} onValue={pick} />
            </div>
            <TextInput
              label="Upstream base URL"
              type="url"
              hint="Including the API version path. Requests go to this URL plus the endpoint, e.g. /messages."
              value={base()}
              onValue={setBase}
              required
            />
            <TextInput
              label="API key"
              type="password"
              autocomplete="new-password"
              placeholder={editing() ? "Unchanged" : ""}
              hint={
                editing()
                  ? "Leave empty to keep the current key."
                  : "Stored encrypted with ENTERPRISE_SECRET. It cannot be read back."
              }
              value={key()}
              onValue={setKey}
              required={!editing()}
            />
            <div class="form-actions">
              <Button type="submit" variant="primary" disabled={busy()}>
                {editing() ? "Save provider" : "Add provider"}
              </Button>
            </div>
          </form>
        </Panel>
      </Show>
    </Page>
  )
}

// The exclusive switch is part of the policy, so changing it takes policy.write.
function Routing(props: { url: string }) {
  const scope = useOrg()
  const [policy, { refetch }] = createResource(scope.slug, getPolicy)
  const toggle = (exclusive: boolean) =>
    attempt(
      async () => {
        const current = policy()!.policy
        await call((api) =>
          api["enterprise.governance"]["policy.update"]({
            params: { org: scope.slug() },
            payload: { ...current, gateway: { ...current.gateway, exclusive } },
          }),
        )
        void refetch()
      },
      exclusive
        ? "Only gateway providers can be used. Clients pick this up at their next refresh."
        : "Clients may use other providers again.",
    )
  return (
    <Panel title="Routing">
      <div class="ui-form">
        <Copyable label="Gateway URL" value={props.url} />
        <Show when={!policy.error} fallback={<Failure error={policy.error} />}>
          <Show when={policy()} fallback={<Loading />}>
            {(current) => (
              <Toggle
                label="Only allow gateway providers"
                description="Clients refuse every provider that does not go through the gateway, so all model traffic uses organization keys and is metered here."
                checked={current().policy.gateway.exclusive}
                disabled={!scope.can("policy.write")}
                onChange={(value) => void toggle(value)}
              />
            )}
          </Show>
        </Show>
      </div>
    </Panel>
  )
}
