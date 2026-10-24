import { For, Show, createResource, createSignal } from "solid-js"
import { createStore, produce, reconcile } from "solid-js/store"
import { A } from "@solidjs/router"
import { Button } from "@kilocode/kilo-web-ui/button"
import { IconButton } from "@kilocode/kilo-web-ui/icon-button"
import { Tag } from "@kilocode/kilo-web-ui/tag"
import type { GatewayAuth, GatewayKind, GatewayModel, Price } from "@organization/protocol/schema"
import { call } from "../api"
import { useOrg } from "../context"
import { date } from "../format"
import { attempt, confirm } from "../components/feedback"
import { Check, Choice, TextArea, TextInput, Toggle } from "../components/form"
import { Failure, Loading, Muted, Page, Panel } from "../components/page"
import { Copyable } from "../components/secret"
import { DataTable } from "../components/table"

type Provider = Awaited<ReturnType<typeof getGateway>>["providers"][number]
type AuthType = GatewayAuth["type"]

const getGateway = (org: string) => call((api) => api["organization.gateway"]["gateway.get"]({ params: { org } }))
const getPolicy = (org: string) => call((api) => api["organization.governance"]["policy.get"]({ params: { org } }))
const getPrices = (org: string) => call((api) => api["organization.governance"]["prices.get"]({ params: { org } }))

// Each upstream, where it usually lives, and what to put there.
const kinds: ReadonlyArray<{ value: GatewayKind; label: string; base: string; hint: string }> = [
  {
    value: "anthropic",
    label: "Anthropic API",
    base: "https://api.anthropic.com/v1",
    hint: "Including the API version path. Requests go to this URL plus the endpoint, such as /messages.",
  },
  {
    value: "openai",
    label: "OpenAI API",
    base: "https://api.openai.com/v1",
    hint: "Azure OpenAI too: https://<resource>.openai.azure.com/openai/v1, with the key in the api-key header.",
  },
  {
    value: "openai-compatible",
    label: "OpenAI-compatible: LiteLLM, vLLM, Ollama, OpenRouter, other gateways",
    base: "https://openrouter.ai/api/v1",
    hint: "The URL clients would use as the base URL, such as https://litellm.example.com/v1 for LiteLLM.",
  },
  {
    value: "bedrock",
    label: "Claude on Amazon Bedrock",
    base: "https://bedrock-runtime.us-east-1.amazonaws.com",
    hint: "The Bedrock runtime endpoint of your region. Clients use Anthropic's API; the gateway calls Bedrock.",
  },
  {
    value: "vertex",
    label: "Claude on Google Vertex AI",
    base: "https://us-east5-aiplatform.googleapis.com/v1/projects/PROJECT/locations/us-east5",
    hint: "Your project and the location of the Claude models. Clients use Anthropic's API; the gateway calls Vertex.",
  },
]

const kind = (value: GatewayKind) => kinds.find((item) => item.value === value)!

const methods: Record<AuthType, string> = {
  bearer: "API key as a bearer token",
  header: "API key in a header",
  none: "No credential",
  aws: "AWS access key",
  google: "Google Cloud service account",
}

// A credential in a table cell.
const brief = (auth: GatewayAuth) =>
  auth.type === "header"
    ? `Key in ${auth.name}`
    : auth.type === "bearer"
      ? "Bearer key"
      : auth.type === "aws"
        ? `AWS key, ${auth.region}`
        : auth.type === "google"
          ? "Service account"
          : "None"

// The credentials each upstream takes; the first is its default.
const accepted: Record<GatewayKind, ReadonlyArray<AuthType>> = {
  anthropic: ["header", "bearer", "none"],
  openai: ["bearer", "header", "none"],
  "openai-compatible": ["bearer", "header", "none", "google", "aws"],
  bedrock: ["aws", "bearer"],
  vertex: ["google"],
}

type ModelRow = {
  id: string
  name: string
  context: string
  output: string
  input: string
  price: string
  reasoning: boolean
  attachments: boolean
}

type Form = {
  id: string
  kind: GatewayKind
  base: string
  auth: AuthType
  header: string
  region: string
  access: string
  key: string
  // New extra headers. Values can't be read back, so they replace the current ones when given.
  headers: Array<{ name: string; value: string }>
  clear: boolean
  query: Array<{ name: string; value: string }>
  name: string
  models: ModelRow[]
}

const blank = (): Form => ({
  id: "",
  kind: "anthropic",
  base: kind("anthropic").base,
  auth: "header",
  header: "x-api-key",
  region: "us-east-1",
  access: "",
  key: "",
  headers: [],
  clear: false,
  query: [],
  name: "",
  models: [],
})

const row = (model: GatewayModel): ModelRow => ({
  id: model.id,
  name: model.name ?? "",
  context: model.context ? String(model.context) : "",
  output: model.output ? String(model.output) : "",
  input: model.cost ? String(model.cost.input) : "",
  price: model.cost ? String(model.cost.output) : "",
  reasoning: model.reasoning ?? false,
  attachments: model.attachments ?? false,
})

const whole = (text: string) => (text.trim() && Number(text) > 0 ? Math.round(Number(text)) : undefined)

const model = (item: ModelRow): GatewayModel => ({
  id: item.id.trim(),
  ...(item.name.trim() ? { name: item.name.trim() } : {}),
  ...(whole(item.context) ? { context: whole(item.context) } : {}),
  ...(whole(item.output) ? { output: whole(item.output) } : {}),
  ...(item.reasoning ? { reasoning: true } : {}),
  ...(item.attachments ? { attachments: true } : {}),
  ...(item.input.trim() || item.price.trim()
    ? { cost: { input: Number(item.input) || 0, output: Number(item.price) || 0 } }
    : {}),
})

function credential(form: Form): GatewayAuth {
  if (form.auth === "header") return { type: "header", name: form.header.trim() }
  if (form.auth === "aws") return { type: "aws", region: form.region.trim(), access_key: form.access.trim() }
  return { type: form.auth } as GatewayAuth
}

export function Gateway() {
  const scope = useOrg()
  const [gateway, { refetch }] = createResource(scope.slug, getGateway)
  const [editing, setEditing] = createSignal<Provider>()
  const [form, setForm] = createStore<Form>(blank())
  const [busy, setBusy] = createSignal(false)

  const edit = (provider?: Provider) => {
    setEditing(provider)
    if (!provider) return setForm(reconcile(blank()))
    const auth = provider.auth
    setForm(
      reconcile({
        ...blank(),
        id: provider.id,
        kind: provider.kind,
        base: provider.base,
        auth: auth.type,
        header: auth.type === "header" ? auth.name : "x-api-key",
        region: auth.type === "aws" ? auth.region : "us-east-1",
        access: auth.type === "aws" ? auth.access_key : "",
        query: Object.entries(provider.query).map(([name, value]) => ({ name, value })),
        name: provider.name ?? "",
        models: provider.models.map(row),
      }),
    )
  }

  const pick = (next: GatewayKind) => {
    // Swap the suggested upstream along with the kind, but never an address someone typed.
    if (!form.base.trim() || kinds.some((item) => item.base === form.base.trim())) setForm("base", kind(next).base)
    if (!accepted[next].includes(form.auth)) setForm("auth", accepted[next][0]!)
    setForm("kind", next)
  }

  const save = async (event: SubmitEvent) => {
    event.preventDefault()
    const target = form.id.trim().toLowerCase()
    const headers = form.headers.filter((item) => item.name.trim())
    setBusy(true)
    const ok = await attempt(
      () =>
        call((api) =>
          api["organization.gateway"]["gateway.set"]({
            params: { org: scope.slug(), id: target },
            payload: {
              kind: form.kind,
              base: form.base.trim(),
              auth: credential(form),
              ...(form.key ? { key: form.key } : {}),
              ...(headers.length > 0 || form.clear
                ? { headers: Object.fromEntries(headers.map((item) => [item.name.trim(), item.value])) }
                : {}),
              query: Object.fromEntries(
                form.query.filter((item) => item.name.trim()).map((item) => [item.name.trim(), item.value]),
              ),
              name: form.name.trim() || null,
              models: form.models.filter((item) => item.id.trim()).map(model),
            },
          }),
        ),
      editing() ? `${target} updated` : `${target} now goes through the gateway`,
    ).finally(() => setBusy(false))
    if (!ok) return
    edit(undefined)
    void refetch()
  }

  const discover = () =>
    attempt(async () => {
      const found = await call((api) =>
        api["organization.gateway"]["gateway.discover"]({ params: { org: scope.slug(), id: editing()!.id } }),
      )
      const known = new Set(form.models.map((item) => item.id))
      const added = found.models.filter((item) => !known.has(item.id))
      setForm("models", (models) => [...models, ...added.map((item) => row({ id: item.id, name: item.name }))])
    }, "Imported the upstream's models. Remove the ones people shouldn't use, then save.")

  return (
    <Page
      title="LLM gateway"
      description="Route model providers through this server. It holds the organization's credentials, enforces model policy, budgets and rate limits on every call, meters usage itself and logs each call."
      actions={
        <A href={`/${scope.slug()}/gateway/calls`}>
          <Button variant="secondary">Call log</Button>
        </A>
      }
    >
      <Show when={!gateway.error} fallback={<Failure error={gateway.error} />}>
        <Show when={gateway()} fallback={<Loading />}>
          {(data) => (
            <>
              <Settings url={data().url} />
              <Panel
                title="Providers"
                description="Clients send these providers' requests to the gateway, with their organization sign-in as the API key. People never see the credentials."
                flush
              >
                <DataTable
                  rows={data().providers}
                  empty="No providers go through the gateway yet. Clients call providers directly with their own keys."
                  columns={[
                    { label: "Provider", cell: (row) => <span class="mono">{row.id}</span> },
                    { label: "Upstream", cell: (row) => <Tag>{kind(row.kind).label.split(":")[0]}</Tag> },
                    {
                      label: "URL",
                      cell: (row) => (
                        <span class="mono truncate narrow" title={row.base}>
                          {row.base}
                        </span>
                      ),
                    },
                    {
                      label: "Credential",
                      cell: (row) => (
                        <span class="stack nowrap">
                          <span>{brief(row.auth)}</span>
                          <Show when={row.hint}>
                            <span class="mono muted truncate narrow" title={row.hint}>
                              {row.auth.type === "google" ? row.hint : `…${row.hint}`}
                            </span>
                          </Show>
                        </span>
                      ),
                    },
                    {
                      label: "Models",
                      cell: (row) => (row.models.length > 0 ? String(row.models.length) : <Muted>Catalog</Muted>),
                    },
                    { label: "Updated", cell: (row) => <span class="nowrap">{date(row.updated)}</span> },
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
                                    "The organization's credentials are deleted. Clients call the provider directly again at their next policy refresh, with keys of their own.",
                                  action: "Remove",
                                  run: () =>
                                    attempt(async () => {
                                      await call((api) =>
                                        api["organization.gateway"]["gateway.remove"]({
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
          description="Use the client's provider id, such as anthropic or openrouter, to route a provider clients know; their models and prices come from the models.dev catalog. Any other id, such as litellm or bedrock-claude, defines a provider of its own from the models listed below."
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
                placeholder="litellm"
                value={form.id}
                onValue={(value) => setForm("id", value)}
                disabled={editing() !== undefined}
                required
                autocomplete="off"
                spellcheck={false}
              />
              <Choice
                label="Upstream"
                value={form.kind}
                options={kinds.map((item) => ({ value: item.value, label: item.label }))}
                onValue={pick}
              />
            </div>
            <TextInput
              label="Upstream URL"
              type="url"
              hint={kind(form.kind).hint}
              value={form.base}
              onValue={(value) => setForm("base", value)}
              required
            />
            <Credential form={form} set={setForm} editing={editing()} />
            <Pairs
              title="Extra headers"
              description={
                editing()?.headers.length
                  ? `Sent now: ${editing()!.headers.join(", ")}. Values can't be shown; headers entered here replace them.`
                  : "Sent with every call, such as a gateway's own key (x-portkey-api-key, cf-aig-authorization). Values are stored encrypted."
              }
              rows={form.headers}
              secret
              onChange={(rows) => setForm("headers", rows)}
            />
            <Show when={editing()?.headers.length}>
              <Check checked={form.clear} onChange={(value) => setForm("clear", value)}>
                Remove the current extra headers
              </Check>
            </Show>
            <Pairs
              title="Query parameters"
              description="Added to every call, such as Azure's api-version."
              rows={form.query}
              onChange={(rows) => setForm("query", rows)}
            />
            <Models
              form={form}
              set={setForm}
              discover={editing() && form.kind !== "bedrock" && form.kind !== "vertex" ? discover : undefined}
            />
            <div class="form-actions">
              <Button type="submit" variant="primary" disabled={busy()}>
                {editing() ? "Save provider" : "Add provider"}
              </Button>
            </div>
          </form>
        </Panel>
      </Show>
      <Show when={scope.can("usage.read")}>
        <Prices />
      </Show>
    </Page>
  )
}

function Credential(props: {
  form: Form
  set: ReturnType<typeof createStore<Form>>[1]
  editing: Provider | undefined
}) {
  const keep = () => (props.editing ? "Leave empty to keep the current one." : "")
  return (
    <>
      <Choice
        label="Credential"
        value={props.form.auth}
        options={accepted[props.form.kind].map((value) => ({ value, label: methods[value] }))}
        onValue={(value) => props.set("auth", value)}
      />
      <Show when={props.form.auth === "header"}>
        <TextInput
          label="Header"
          hint="x-api-key for Anthropic, api-key for Azure OpenAI."
          value={props.form.header}
          onValue={(value) => props.set("header", value)}
          required
          spellcheck={false}
        />
      </Show>
      <Show when={props.form.auth === "aws"}>
        <div class="grid-2">
          <TextInput
            label="AWS region"
            value={props.form.region}
            onValue={(value) => props.set("region", value)}
            required
          />
          <TextInput
            label="Access key id"
            value={props.form.access}
            onValue={(value) => props.set("access", value)}
            required
            spellcheck={false}
          />
        </div>
      </Show>
      <Show
        when={props.form.auth === "google"}
        fallback={
          <Show when={props.form.auth !== "none"}>
            <TextInput
              label={props.form.auth === "aws" ? "Secret access key" : "API key"}
              type="password"
              autocomplete="new-password"
              placeholder={props.editing ? "Unchanged" : ""}
              hint={keep() || "Stored encrypted with ORGANIZATION_SECRET. It cannot be read back."}
              value={props.form.key}
              onValue={(value) => props.set("key", value)}
            />
          </Show>
        }
      >
        <TextArea
          label="Service account key (JSON)"
          class="mono-field"
          rows={6}
          placeholder={props.editing ? "Unchanged" : '{"type": "service_account", ...}'}
          hint={
            keep() ||
            "A key for a service account with the Vertex AI User role. Stored encrypted; only its email is shown afterwards."
          }
          value={props.form.key}
          onValue={(value) => props.set("key", value)}
        />
      </Show>
    </>
  )
}

function Pairs(props: {
  title: string
  description: string
  rows: ReadonlyArray<{ name: string; value: string }>
  secret?: boolean
  onChange: (rows: Array<{ name: string; value: string }>) => void
}) {
  const update = (index: number, key: "name" | "value", value: string) =>
    props.onChange(props.rows.map((item, at) => (at === index ? { ...item, [key]: value } : item)))
  return (
    <fieldset class="edit-group">
      <legend>{props.title}</legend>
      <p class="hint">{props.description}</p>
      <div class="edit-rows">
        <For each={props.rows}>
          {(item, index) => (
            <div class="edit-row" style={{ "--columns": "minmax(8rem, 1fr) minmax(10rem, 1.5fr) auto" }}>
              <TextInput
                label="Name"
                value={item.name}
                onValue={(value) => update(index(), "name", value)}
                spellcheck={false}
              />
              <TextInput
                label="Value"
                type={props.secret ? "password" : "text"}
                autocomplete="off"
                value={item.value}
                onValue={(value) => update(index(), "value", value)}
              />
              <IconButton
                icon="trash"
                variant="ghost"
                aria-label={`Remove ${item.name || "row"}`}
                onClick={() => props.onChange(props.rows.filter((_, at) => at !== index()))}
              />
            </div>
          )}
        </For>
      </div>
      <div>
        <Button
          variant="ghost"
          size="sm"
          icon="plus"
          type="button"
          onClick={() => props.onChange([...props.rows, { name: "", value: "" }])}
        >
          Add
        </Button>
      </div>
    </fieldset>
  )
}

function Models(props: { form: Form; set: ReturnType<typeof createStore<Form>>[1]; discover?: () => unknown }) {
  const custom = () => props.form.kind === "bedrock" || props.form.kind === "vertex"
  return (
    <fieldset class="edit-group">
      <legend>Models</legend>
      <p class="hint">
        {custom()
          ? "The model ids clients may use: Bedrock model or inference profile ids, Vertex model ids. Prices are per million tokens."
          : "For a provider clients don't know, such as LiteLLM or Azure deployments: the models they list, under the name below. Leave empty for a provider whose models come from the catalog."}
      </p>
      <TextInput
        label="Name shown in clients"
        placeholder={props.form.id || "LiteLLM"}
        value={props.form.name}
        onValue={(value) => props.set("name", value)}
      />
      <div class="edit-rows">
        <For each={props.form.models}>
          {(item, index) => (
            <div
              class="edit-row"
              style={{
                "--columns":
                  "minmax(9rem, 1.6fr) minmax(7rem, 1fr) minmax(5rem, 0.7fr) minmax(5rem, 0.7fr) minmax(4.5rem, 0.6fr) minmax(4.5rem, 0.6fr) auto auto",
              }}
            >
              <TextInput
                label="Model id"
                value={item.id}
                onValue={(value) => props.set("models", index(), "id", value)}
              />
              <TextInput
                label="Name"
                value={item.name}
                onValue={(value) => props.set("models", index(), "name", value)}
              />
              <TextInput
                label="Context"
                type="number"
                min="1"
                value={item.context}
                onValue={(value) => props.set("models", index(), "context", value)}
              />
              <TextInput
                label="Max output"
                type="number"
                min="1"
                value={item.output}
                onValue={(value) => props.set("models", index(), "output", value)}
              />
              <TextInput
                label="$ in / M"
                type="number"
                min="0"
                step="any"
                value={item.input}
                onValue={(value) => props.set("models", index(), "input", value)}
              />
              <TextInput
                label="$ out / M"
                type="number"
                min="0"
                step="any"
                value={item.price}
                onValue={(value) => props.set("models", index(), "price", value)}
              />
              <span class="stack">
                <Check checked={item.reasoning} onChange={(value) => props.set("models", index(), "reasoning", value)}>
                  Reasoning
                </Check>
                <Check
                  checked={item.attachments}
                  onChange={(value) => props.set("models", index(), "attachments", value)}
                >
                  Images
                </Check>
              </span>
              <IconButton
                icon="trash"
                variant="ghost"
                aria-label={`Remove ${item.id || "model"}`}
                onClick={() =>
                  props.set(
                    "models",
                    produce((list) => void list.splice(index(), 1)),
                  )
                }
              />
            </div>
          )}
        </For>
      </div>
      <div class="row-actions start">
        <Button
          variant="ghost"
          size="sm"
          icon="plus"
          type="button"
          onClick={() => props.set("models", props.form.models.length, row({ id: "" }))}
        >
          Add model
        </Button>
        <Show when={props.discover}>
          {(discover) => (
            <Button variant="ghost" size="sm" icon="download" type="button" onClick={() => void discover()()}>
              Import from upstream
            </Button>
          )}
        </Show>
      </div>
    </fieldset>
  )
}

// Routing, rate limits and the call log are policy settings, so changing them takes policy.write.
function Settings(props: { url: string }) {
  const scope = useOrg()
  const [policy, { refetch }] = createResource(scope.slug, getPolicy)
  const [requests, setRequests] = createSignal("")
  const [tokens, setTokens] = createSignal("")
  const [bodies, setBodies] = createSignal(false)
  const [retention, setRetention] = createSignal("30")
  const [loaded, setLoaded] = createSignal(false)
  const fill = () => {
    const gateway = policy()?.policy.gateway
    if (!gateway || loaded()) return
    setRequests(gateway.limits.requests ? String(gateway.limits.requests) : "")
    setTokens(gateway.limits.tokens ? String(gateway.limits.tokens) : "")
    setBodies(gateway.log.bodies)
    setRetention(String(gateway.log.retention))
    setLoaded(true)
  }
  const update = (gateway: Record<string, unknown>, success: string) =>
    attempt(async () => {
      const current = policy()!.policy
      await call((api) =>
        api["organization.governance"]["policy.update"]({
          params: { org: scope.slug() },
          payload: { ...current, gateway: { ...current.gateway, ...gateway } },
        }),
      )
      void refetch()
    }, success)
  const save = (event: SubmitEvent) => {
    event.preventDefault()
    const days = whole(retention()) ?? 30
    void update(
      {
        limits: {
          ...(whole(requests()) ? { requests: whole(requests()) } : {}),
          ...(whole(tokens()) ? { tokens: whole(tokens()) } : {}),
        },
        log: { bodies: bodies(), retention: Math.min(days, 3650) },
      },
      "Gateway limits and logging saved",
    )
  }
  return (
    <Panel title="Routing, limits and logging">
      <Show when={!policy.error} fallback={<Failure error={policy.error} />}>
        <Show when={policy()} fallback={<Loading />}>
          {(current) => {
            fill()
            const locked = () => !scope.can("policy.write")
            return (
              <form class="ui-form" onSubmit={save}>
                <Copyable label="Gateway URL" value={props.url} />
                <Toggle
                  label="Only allow gateway providers"
                  description="Clients refuse every provider that does not go through the gateway, so all model traffic uses organization credentials and is metered here."
                  checked={current().policy.gateway.exclusive}
                  disabled={locked()}
                  onChange={(exclusive) =>
                    void update(
                      { exclusive },
                      exclusive
                        ? "Only gateway providers can be used. Clients pick this up at their next refresh."
                        : "Clients may use other providers again.",
                    )
                  }
                />
                <div class="grid-2">
                  <TextInput
                    label="Requests per minute, per person"
                    type="number"
                    min="1"
                    placeholder="Unlimited"
                    value={requests()}
                    onValue={setRequests}
                    disabled={locked()}
                  />
                  <TextInput
                    label="Tokens per minute, per person"
                    type="number"
                    min="1"
                    placeholder="Unlimited"
                    hint="Input and output, cache and reasoning included."
                    value={tokens()}
                    onValue={setTokens}
                    disabled={locked()}
                  />
                </div>
                <div class="grid-2">
                  <Toggle
                    label="Keep request and response bodies"
                    description="Admins can then read prompts and answers in the call log. Off, only who, what model, tokens, cost and outcome are kept."
                    checked={bodies()}
                    disabled={locked()}
                    onChange={setBodies}
                  />
                  <TextInput
                    label="Keep the call log for (days)"
                    type="number"
                    min="1"
                    max="3650"
                    value={retention()}
                    onValue={setRetention}
                    disabled={locked()}
                  />
                </div>
                <Show when={!locked()}>
                  <div class="form-actions">
                    <Button type="submit" variant="primary">
                      Save limits and logging
                    </Button>
                  </div>
                </Show>
              </form>
            )
          }}
        </Show>
      </Show>
    </Panel>
  )
}

type PriceRow = {
  provider: string
  model: string
  mode: "rates" | "discount"
  input: string
  output: string
  read: string
  write: string
  discount: string
}

const price = (item: PriceRow): Price =>
  item.mode === "discount"
    ? { provider: item.provider.trim(), model: item.model.trim() || "*", discount: Number(item.discount) || 0 }
    : {
        provider: item.provider.trim(),
        model: item.model.trim() || "*",
        rates: {
          input: Number(item.input) || 0,
          output: Number(item.output) || 0,
          ...(item.read.trim() ? { cache_read: Number(item.read) } : {}),
          ...(item.write.trim() ? { cache_write: Number(item.write) } : {}),
        },
      }

function Prices() {
  const scope = useOrg()
  const [prices, { refetch }] = createResource(scope.slug, getPrices)
  return (
    <Show when={!prices.error} fallback={<Failure error={prices.error} />}>
      <Show when={prices()} keyed fallback={<Loading />}>
        {(data) => <PriceEditor prices={data.prices} saved={() => void refetch()} />}
      </Show>
    </Show>
  )
}

function PriceEditor(props: { prices: ReadonlyArray<Price>; saved: () => void }) {
  const scope = useOrg()
  const locked = () => !scope.can("budget.write")
  const [rows, setRows] = createStore<PriceRow[]>(
    props.prices.map((item) => ({
      provider: item.provider,
      model: item.model,
      mode: item.discount !== undefined ? "discount" : "rates",
      input: item.rates ? String(item.rates.input) : "",
      output: item.rates ? String(item.rates.output) : "",
      read: item.rates?.cache_read !== undefined ? String(item.rates.cache_read) : "",
      write: item.rates?.cache_write !== undefined ? String(item.rates.cache_write) : "",
      discount: item.discount !== undefined ? String(item.discount) : "",
    })),
  )
  const save = () =>
    attempt(async () => {
      await call((api) =>
        api["organization.governance"]["prices.update"]({
          params: { org: scope.slug() },
          payload: { prices: rows.filter((item) => item.provider.trim()).map(price) },
        }),
      )
      props.saved()
    }, "Prices saved. They apply to usage recorded from now on.")
  return (
    <Panel
      title="Prices"
      description="The organization's own rates, for negotiated prices or models the catalog doesn't price. They replace catalog prices for gateway calls and client reports alike; model * covers all of a provider's models."
      actions={
        <Show when={!locked()}>
          <Button
            variant="secondary"
            size="sm"
            icon="plus"
            onClick={() =>
              setRows(rows.length, {
                provider: "",
                model: "*",
                mode: "discount",
                input: "",
                output: "",
                read: "",
                write: "",
                discount: "",
              })
            }
          >
            Add price
          </Button>
        </Show>
      }
      footer={
        <Show when={!locked()}>
          <Button variant="primary" onClick={save}>
            Save prices
          </Button>
        </Show>
      }
    >
      <div class="edit-rows">
        <For each={rows} fallback={<Muted>No prices of your own. Usage is priced from the models.dev catalog.</Muted>}>
          {(item, index) => (
            <div
              class="edit-row"
              style={{ "--columns": "minmax(7rem, 1fr) minmax(8rem, 1.3fr) minmax(8rem, 1fr) minmax(0, 2.4fr) auto" }}
            >
              <TextInput
                label="Provider"
                value={item.provider}
                disabled={locked()}
                onValue={(value) => setRows(index(), "provider", value)}
              />
              <TextInput
                label="Model"
                value={item.model}
                disabled={locked()}
                onValue={(value) => setRows(index(), "model", value)}
              />
              <Choice
                label="Price"
                value={item.mode}
                disabled={locked()}
                options={[
                  { value: "discount", label: "Discount" },
                  { value: "rates", label: "Own rates" },
                ]}
                onValue={(value) => setRows(index(), "mode", value)}
              />
              <Show
                when={item.mode === "rates"}
                fallback={
                  <TextInput
                    label="Off the catalog price (%)"
                    type="number"
                    min="0"
                    max="100"
                    step="any"
                    value={item.discount}
                    disabled={locked()}
                    onValue={(value) => setRows(index(), "discount", value)}
                  />
                }
              >
                <div class="edit-row inner" style={{ "--columns": "repeat(4, minmax(0, 1fr))" }}>
                  <For
                    each={
                      [
                        ["input", "$ in / M"],
                        ["output", "$ out / M"],
                        ["read", "Cache read"],
                        ["write", "Cache write"],
                      ] as const
                    }
                  >
                    {([key, label]) => (
                      <TextInput
                        label={label}
                        type="number"
                        min="0"
                        step="any"
                        value={item[key]}
                        disabled={locked()}
                        onValue={(value) => setRows(index(), key, value)}
                      />
                    )}
                  </For>
                </div>
              </Show>
              <Show when={!locked()} fallback={<span />}>
                <IconButton
                  icon="trash"
                  variant="ghost"
                  aria-label="Remove price"
                  onClick={() => setRows(produce((list) => void list.splice(index(), 1)))}
                />
              </Show>
            </div>
          )}
        </For>
      </div>
    </Panel>
  )
}
