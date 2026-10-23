import { Show, createResource, createSignal } from "solid-js"
import { Button } from "@kilocode/kilo-web-ui/button"
import { Tag } from "@kilocode/kilo-web-ui/tag"
import { call } from "../api"
import { useOrg } from "../context"
import { when } from "../format"
import { attempt, confirm } from "../components/feedback"
import { TextInput, Toggle } from "../components/form"
import { Failure, Loading, Page, Panel } from "../components/page"
import { Copyable, Secret } from "../components/secret"
import { DataTable } from "../components/table"

type Sso = Awaited<ReturnType<typeof getSso>>

const getSso = (org: string) => call((api) => api["enterprise.identity"]["sso.get"]({ params: { org } }))

export function Security() {
  const scope = useOrg()
  const [sso, { refetch }] = createResource(scope.slug, getSso)
  return (
    <Page
      title="Single sign-on and SCIM"
      description="Connect your identity provider: people sign in with OpenID Connect, and SCIM keeps members and groups in sync."
    >
      <Show when={!sso.error} fallback={<Failure error={sso.error} />}>
        <Show when={sso()} keyed fallback={<Loading />}>
          {(current) => <SingleSignOn current={current} saved={() => void refetch()} />}
        </Show>
      </Show>
      <Show when={scope.can("domain.write")}>
        <Domains />
      </Show>
      <Show when={scope.can("scim.write")}>
        <Provisioning />
      </Show>
    </Page>
  )
}

function SingleSignOn(props: { current: Sso; saved: () => void }) {
  const scope = useOrg()
  const [issuer, setIssuer] = createSignal(props.current.issuer ?? "")
  const [client, setClient] = createSignal(props.current.client_id ?? "")
  const [secret, setSecret] = createSignal("")
  const [scopes, setScopes] = createSignal(props.current.scopes ?? "openid email profile")
  const [enforce, setEnforce] = createSignal(props.current.enforce)
  const [provision, setProvision] = createSignal(props.current.provision ?? true)
  const [busy, setBusy] = createSignal(false)

  const save = async (event: SubmitEvent) => {
    event.preventDefault()
    setBusy(true)
    const ok = await attempt(
      () =>
        call((api) =>
          api["enterprise.identity"]["sso.update"]({
            params: { org: scope.slug() },
            payload: {
              issuer: issuer().trim(),
              client_id: client().trim(),
              ...(secret() ? { client_secret: secret() } : {}),
              scopes: scopes().trim(),
              enforce: enforce(),
              provision: provision(),
            },
          }),
        ),
      "Single sign-on saved",
    ).finally(() => setBusy(false))
    if (!ok) return
    setSecret("")
    props.saved()
  }

  return (
    <Panel
      title={
        <span class="title-with-tag">
          OpenID Connect
          <Show when={props.current.configured} fallback={<Tag>Not configured</Tag>}>
            <Tag tone="success">Configured</Tag>
          </Show>
        </span>
      }
      description="Register the redirect URI with your identity provider, then enter the issuer and client it gives you."
    >
      <form class="ui-form" onSubmit={save}>
        <div class="grid-2">
          <Copyable label="Redirect URI" value={props.current.redirect_uri} />
          <Copyable label="Sign-in URL" value={props.current.login_url} />
        </div>
        <TextInput
          label="Issuer"
          type="url"
          placeholder="https://login.example.com"
          value={issuer()}
          onValue={setIssuer}
          required
        />
        <div class="grid-2">
          <TextInput label="Client ID" value={client()} onValue={setClient} required autocomplete="off" />
          <TextInput
            label="Client secret"
            type="password"
            autocomplete="new-password"
            placeholder={props.current.configured ? "Unchanged" : ""}
            hint={props.current.configured ? "Leave empty to keep the current secret." : undefined}
            value={secret()}
            onValue={setSecret}
            required={!props.current.configured}
          />
        </div>
        <TextInput label="Scopes" hint="Must include openid." value={scopes()} onValue={setScopes} required />
        <div class="grid-2">
          <Toggle
            label="Require single sign-on"
            description="Invites and admin-issued tokens stop working; everyone signs in through your identity provider."
            checked={enforce()}
            onChange={setEnforce}
          />
          <Toggle
            label="Join from verified domains"
            description="People with an email at a verified domain become members the first time they sign in."
            checked={provision()}
            onChange={setProvision}
          />
        </div>
        <div class="form-actions">
          <Show when={props.current.configured}>
            <Button
              variant="ghost"
              class="danger"
              type="button"
              onClick={() =>
                confirm({
                  title: "Remove single sign-on?",
                  description: "People can no longer sign in through your identity provider until it is set up again.",
                  action: "Remove",
                  run: () =>
                    attempt(async () => {
                      await call((api) => api["enterprise.identity"]["sso.remove"]({ params: { org: scope.slug() } }))
                      props.saved()
                    }, "Single sign-on removed"),
                })
              }
            >
              Remove
            </Button>
          </Show>
          <Button type="submit" variant="primary" disabled={busy()}>
            Save
          </Button>
        </div>
      </form>
    </Panel>
  )
}

function Domains() {
  const scope = useOrg()
  const [domains, { refetch }] = createResource(scope.slug, (org) =>
    call((api) => api["enterprise.identity"]["domains.list"]({ params: { org } })),
  )
  const [name, setName] = createSignal("")
  const add = async (event: SubmitEvent) => {
    event.preventDefault()
    const domain = name().trim().toLowerCase()
    const ok = await attempt(
      () =>
        call((api) =>
          api["enterprise.identity"]["domains.create"]({ params: { org: scope.slug() }, payload: { domain } }),
        ),
      `Added ${domain}. Publish its TXT record, then verify it.`,
    )
    if (!ok) return
    setName("")
    void refetch()
  }
  return (
    <Panel
      title="Verified domains"
      description="Prove you own a domain with a DNS TXT record. People with a verified email domain can then join automatically."
      flush
    >
      <form class="inline-form padded" onSubmit={add}>
        <TextInput
          label="Domain"
          hideLabel
          placeholder="example.com"
          value={name()}
          onValue={setName}
          required
          class="grow"
        />
        <Button type="submit" variant="secondary" disabled={!name().trim()}>
          Add domain
        </Button>
      </form>
      <Show when={!domains.error} fallback={<Failure error={domains.error} />}>
        <Show when={domains()} fallback={<Loading />}>
          {(data) => (
            <DataTable
              rows={data().domains}
              empty="No domains yet."
              columns={[
                { label: "Domain", cell: (row) => <span class="mono">{row.name}</span> },
                {
                  label: "Status",
                  cell: (row) =>
                    row.verified ? (
                      <Tag tone="success">Verified {new Date(row.verified).toLocaleDateString()}</Tag>
                    ) : (
                      <Tag tone="warning">Pending</Tag>
                    ),
                },
                {
                  label: "TXT record",
                  cell: (row) => (
                    <Show when={!row.verified} fallback={<span class="muted">—</span>}>
                      <Copyable label={`TXT value for ${row.name}`} value={row.record.value} hideLabel />
                    </Show>
                  ),
                },
                {
                  label: "",
                  align: "end",
                  cell: (row) => (
                    <div class="row-actions">
                      <Show when={!row.verified}>
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() =>
                            attempt(async () => {
                              await call((api) =>
                                api["enterprise.identity"]["domains.verify"]({
                                  params: { org: scope.slug(), name: row.name },
                                }),
                              )
                              void refetch()
                            }, `${row.name} verified`)
                          }
                        >
                          Verify
                        </Button>
                      </Show>
                      <Button
                        variant="ghost"
                        size="sm"
                        class="danger"
                        onClick={() =>
                          confirm({
                            title: `Remove ${row.name}?`,
                            description: "People at this domain no longer join automatically. Existing members stay.",
                            action: "Remove",
                            run: () =>
                              attempt(async () => {
                                await call((api) =>
                                  api["enterprise.identity"]["domains.remove"]({
                                    params: { org: scope.slug(), name: row.name },
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
                  ),
                },
              ]}
            />
          )}
        </Show>
      </Show>
    </Panel>
  )
}

function Provisioning() {
  const scope = useOrg()
  const [tokens, { refetch }] = createResource(scope.slug, (org) =>
    call((api) => api["enterprise.identity"]["scimTokens.list"]({ params: { org } })),
  )
  const [created, setCreated] = createSignal<{ token: string; base: string }>()
  const create = () =>
    attempt(async () => {
      const token = await call((api) =>
        api["enterprise.identity"]["scimTokens.create"]({ params: { org: scope.slug() }, payload: { name: "SCIM" } }),
      )
      setCreated({ token: token.token, base: token.base })
      void refetch()
    }, "SCIM token created")
  return (
    <>
      <Panel
        title="SCIM provisioning"
        description={
          <>
            Point your identity provider's SCIM 2.0 connector at <span class="mono">{location.origin}/scim/v2</span>{" "}
            with a bearer token. Deactivating a person there removes their access here.
          </>
        }
        actions={
          <Button variant="secondary" size="sm" icon="plus" onClick={create}>
            Create token
          </Button>
        }
        flush
      >
        <Show when={!tokens.error} fallback={<Failure error={tokens.error} />}>
          <Show when={tokens()} fallback={<Loading />}>
            {(data) => (
              <DataTable
                rows={data().tokens}
                empty="No SCIM tokens yet."
                columns={[
                  { label: "Name", cell: (row) => row.name },
                  { label: "Created", cell: (row) => when(row.created) },
                  { label: "Last used", cell: (row) => when(row.used) },
                  {
                    label: "",
                    align: "end",
                    cell: (row) => (
                      <Show when={!row.revoked} fallback={<Tag>Revoked</Tag>}>
                        <Button
                          variant="ghost"
                          size="sm"
                          class="danger"
                          onClick={() =>
                            confirm({
                              title: "Revoke this SCIM token?",
                              description: "Your identity provider can no longer provision people with it.",
                              action: "Revoke",
                              run: () =>
                                attempt(async () => {
                                  await call((api) =>
                                    api["enterprise.identity"]["scimTokens.revoke"]({
                                      params: { org: scope.slug(), id: row.id },
                                    }),
                                  )
                                  void refetch()
                                }, "SCIM token revoked"),
                            })
                          }
                        >
                          Revoke
                        </Button>
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
        {(value) => (
          <Secret
            title="SCIM bearer token"
            value={value().token}
            hint={<>Base URL: {value().base}</>}
            onDismiss={() => setCreated()}
          />
        )}
      </Show>
    </>
  )
}
