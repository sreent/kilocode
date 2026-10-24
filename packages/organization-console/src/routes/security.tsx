import { For, Show, createResource, createSignal } from "solid-js"
import { Button } from "@kilocode/kilo-web-ui/button"
import { Tag } from "@kilocode/kilo-web-ui/tag"
import type { SsoProtocol } from "@organization/protocol/schema"
import { call } from "../api"
import { useOrg } from "../context"
import { date, when } from "../format"
import { attempt, confirm } from "../components/feedback"
import { Choice, TextArea, TextInput, Toggle } from "../components/form"
import { Failure, Loading, Page, Panel } from "../components/page"
import { Copyable, Secret } from "../components/secret"
import { DataTable } from "../components/table"

type Sso = Awaited<ReturnType<typeof getSso>>

const day = 24 * 60 * 60 * 1000

const getSso = (org: string) => call((api) => api["organization.identity"]["sso.get"]({ params: { org } }))

export function Security() {
  const scope = useOrg()
  const [sso, { refetch }] = createResource(scope.slug, getSso)
  return (
    <Page
      title="Single sign-on and SCIM"
      description="Connect your identity provider: people sign in with OpenID Connect or SAML 2.0, and SCIM keeps members and groups in sync."
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

const protocols = [
  { value: "oidc", label: "OpenID Connect" },
  { value: "saml", label: "SAML 2.0" },
] satisfies ReadonlyArray<{ value: SsoProtocol; label: string }>

const named = (protocol: SsoProtocol) => (protocol === "saml" ? "SAML 2.0" : "OpenID Connect")

function SingleSignOn(props: { current: Sso; saved: () => void }) {
  const scope = useOrg()
  const [protocol, setProtocol] = createSignal<SsoProtocol>(props.current.protocol ?? "oidc")
  // OpenID Connect
  const [issuer, setIssuer] = createSignal(props.current.issuer ?? "")
  const [client, setClient] = createSignal(props.current.client_id ?? "")
  const [secret, setSecret] = createSignal("")
  const [scopes, setScopes] = createSignal(props.current.scopes ?? "openid email profile")
  // SAML 2.0
  const [metadata, setMetadata] = createSignal("")
  const [entity, setEntity] = createSignal(props.current.saml?.entity_id ?? "")
  const [entry, setEntry] = createSignal(props.current.saml?.sso_url ?? "")
  const [certificate, setCertificate] = createSignal("")
  const [initiated, setInitiated] = createSignal(props.current.saml?.idp_initiated ?? false)
  const [enforce, setEnforce] = createSignal(props.current.enforce)
  const [provision, setProvision] = createSignal(props.current.provision ?? true)
  const [busy, setBusy] = createSignal(false)
  // Whether the protocol shown is the one saved; the other one's secrets and certificates are not kept.
  const saved = () => props.current.configured && props.current.protocol === protocol()

  const saml = () =>
    call((api) =>
      api["organization.identity"]["sso.saml"]({
        params: { org: scope.slug() },
        payload: {
          ...(metadata().trim() ? { metadata: metadata().trim() } : {}),
          ...(entity().trim() ? { entity_id: entity().trim() } : {}),
          ...(entry().trim() ? { sso_url: entry().trim() } : {}),
          ...(certificate().trim() ? { certificate: certificate().trim() } : {}),
          idp_initiated: initiated(),
          enforce: enforce(),
          provision: provision(),
        },
      }),
    )

  const oidc = () =>
    call((api) =>
      api["organization.identity"]["sso.update"]({
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
    )

  const save = async (event: SubmitEvent) => {
    event.preventDefault()
    setBusy(true)
    const ok = await attempt(() => (protocol() === "saml" ? saml() : oidc()), "Single sign-on saved").finally(() =>
      setBusy(false),
    )
    if (!ok) return
    setSecret("")
    setMetadata("")
    setCertificate("")
    props.saved()
  }

  return (
    <Panel
      title={
        <span class="title-with-tag">
          Single sign-on
          <Show when={props.current.protocol} fallback={<Tag>Not configured</Tag>}>
            {(current) => <Tag tone="success">{named(current())}</Tag>}
          </Show>
        </span>
      }
      description="People sign in to the console, the CLI and the IDEs through your identity provider."
    >
      <form class="ui-form" onSubmit={save}>
        <Choice
          label="Protocol"
          value={protocol()}
          options={protocols}
          onValue={setProtocol}
          hint={
            props.current.protocol && !saved()
              ? `Saving replaces the ${named(props.current.protocol)} connection.`
              : undefined
          }
        />
        <Show
          when={protocol() === "saml"}
          fallback={
            <>
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
                  placeholder={saved() ? "Unchanged" : ""}
                  hint={saved() ? "Leave empty to keep the current secret." : undefined}
                  value={secret()}
                  onValue={setSecret}
                  required={!saved()}
                />
              </div>
              <TextInput label="Scopes" hint="Must include openid." value={scopes()} onValue={setScopes} required />
            </>
          }
        >
          <div class="grid-2">
            <Copyable
              label="Entity ID (audience)"
              value={props.current.service_provider.entity_id}
              hint="Okta: Audience URI. Entra ID: Identifier."
            />
            <Copyable
              label="ACS URL"
              value={props.current.service_provider.acs_url}
              hint="Okta: Single sign-on URL. Entra ID: Reply URL."
            />
            <Copyable
              label="Metadata URL"
              value={props.current.service_provider.metadata_url}
              hint="For identity providers that import both from here."
            />
            <Copyable
              label="Sign-in URL"
              value={props.current.login_url}
              hint="Where people start; the console's sign-in page uses it."
            />
          </div>
          <TextArea
            label="Identity provider metadata"
            rows={4}
            class="mono-field"
            placeholder={'<md:EntityDescriptor entityID="…">'}
            hint="Paste the metadata XML from your identity provider. It fills in the settings below; what you type there wins."
            value={metadata()}
            onValue={setMetadata}
          />
          <div class="grid-2">
            <TextInput
              label="Identity provider entity ID"
              placeholder="https://idp.example.com/saml"
              hint="Also called the issuer."
              value={entity()}
              onValue={setEntity}
              autocomplete="off"
            />
            <TextInput
              label="Identity provider sign-in URL"
              type="url"
              placeholder="https://idp.example.com/sso/saml"
              hint="Where sign-in requests go (HTTP-Redirect binding)."
              value={entry()}
              onValue={setEntry}
            />
          </div>
          <TextArea
            label="Signing certificate"
            rows={3}
            class="mono-field"
            placeholder="-----BEGIN CERTIFICATE-----"
            hint={
              saved()
                ? "Leave empty to keep the certificates below. While your identity provider rotates its key, paste both."
                : "PEM. While your identity provider rotates its key, paste both certificates."
            }
            value={certificate()}
            onValue={setCertificate}
          />
          <Show when={saved() && props.current.saml}>
            {(current) => (
              <div class="ui-field stack">
                <span>Certificates in use</span>
                <For each={current().certificates}>
                  {(cert) => (
                    <span class="title-with-tag">
                      <span class="mono truncate" title={cert.fingerprint}>
                        {cert.subject}
                      </span>
                      <Show
                        when={cert.expires > Date.now()}
                        fallback={<Tag tone="critical">Expired {date(cert.expires)}</Tag>}
                      >
                        <Tag tone={cert.expires - Date.now() < 30 * day ? "warning" : "neutral"}>
                          Expires {date(cert.expires)}
                        </Tag>
                      </Show>
                    </span>
                  )}
                </For>
              </div>
            )}
          </Show>
        </Show>
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
          <Show when={protocol() === "saml"}>
            <Toggle
              label="Allow sign-in from the identity provider"
              description="People can also start from your identity provider's app list. Such sign-ins can't be tied to a request from this server, so leave it off unless you need it."
              checked={initiated()}
              onChange={setInitiated}
            />
          </Show>
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
                      await call((api) => api["organization.identity"]["sso.remove"]({ params: { org: scope.slug() } }))
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
    call((api) => api["organization.identity"]["domains.list"]({ params: { org } })),
  )
  const [name, setName] = createSignal("")
  const add = async (event: SubmitEvent) => {
    event.preventDefault()
    const domain = name().trim().toLowerCase()
    const ok = await attempt(
      () =>
        call((api) =>
          api["organization.identity"]["domains.create"]({ params: { org: scope.slug() }, payload: { domain } }),
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
                                api["organization.identity"]["domains.verify"]({
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
                                  api["organization.identity"]["domains.remove"]({
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
    call((api) => api["organization.identity"]["scimTokens.list"]({ params: { org } })),
  )
  const [created, setCreated] = createSignal<{ token: string; base: string }>()
  const create = () =>
    attempt(async () => {
      const token = await call((api) =>
        api["organization.identity"]["scimTokens.create"]({ params: { org: scope.slug() }, payload: { name: "SCIM" } }),
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
                                    api["organization.identity"]["scimTokens.revoke"]({
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
