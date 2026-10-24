import { Show, createResource, createSignal } from "solid-js"
import { Button } from "@kilocode/kilo-web-ui/button"
import { Tag } from "@kilocode/kilo-web-ui/tag"
import { Role } from "@organization/protocol/schema"
import { call } from "../api"
import { useOrg } from "../context"
import { date, label } from "../format"
import { attempt, confirm } from "../components/feedback"
import { Choice, Select, TextInput } from "../components/form"
import { Failure, Loading, Page, Panel } from "../components/page"
import { Secret } from "../components/secret"
import { DataTable } from "../components/table"

const roles = Role.literals.map((role) => ({ value: role, label: label(role) }))

export function Members() {
  const scope = useOrg()
  const params = () => ({ org: scope.slug() })
  const [members, { refetch }] = createResource(scope.slug, (org) =>
    call((api) => api["organization.people"]["members.list"]({ params: { org } })),
  )
  const [invites, invitations] = createResource(
    () => scope.can("invite.write") && scope.slug(),
    (org) => call((api) => api["organization.people"]["invites.list"]({ params: { org } })),
  )
  const [email, setEmail] = createSignal("")
  const [role, setRole] = createSignal<(typeof Role.literals)[number]>("member")
  const [secret, setSecret] = createSignal<{ title: string; value: string; hint?: string }>()

  const invite = async (event: SubmitEvent) => {
    event.preventDefault()
    const address = email().trim()
    await attempt(async () => {
      const created = await call((api) =>
        api["organization.people"]["invites.create"]({ params: params(), payload: { email: address, role: role() } }),
      )
      setSecret({
        title: `Invite for ${address}`,
        value: created.token,
        hint: created.sso
          ? `They can also simply sign in with single sign-on at ${created.sso}.`
          : `They can run: kilo org login --url ${location.origin} --org ${scope.slug()} --invite ${created.token}`,
      })
      setEmail("")
      void invitations.refetch()
    }, `Invite created for ${address}`)
  }

  const changeRole = (row: { id: string; email: string }, next: (typeof Role.literals)[number]) =>
    attempt(
      async () => {
        await call((api) =>
          api["organization.people"]["members.update"]({
            params: { ...params(), user: row.id },
            payload: { role: next },
          }),
        )
      },
      `${row.email} is now ${label(next)}`,
    ).then(() => refetch())

  return (
    <Page title="Members" description="People with access to this organization and the role each one holds.">
      <Show when={scope.can("invite.write")}>
        <Panel
          title="Invite someone"
          description="Invites expire after 7 days. With single sign-on, signing in accepts them."
        >
          <form class="inline-form" onSubmit={invite}>
            <TextInput
              label="Email"
              type="email"
              placeholder="name@company.com"
              value={email()}
              onValue={setEmail}
              required
              class="grow"
            />
            <Choice label="Role" value={role()} options={roles} onValue={setRole} />
            <Button type="submit" variant="primary" disabled={!email().trim()}>
              Send invite
            </Button>
          </form>
        </Panel>
      </Show>
      <Show when={secret()}>
        {(value) => (
          <Secret title={value().title} value={value().value} hint={value().hint} onDismiss={() => setSecret()} />
        )}
      </Show>
      <Show when={(invites()?.invites.length ?? 0) > 0}>
        <Panel title="Pending invites" flush>
          <DataTable
            rows={invites()!.invites}
            columns={[
              { label: "Email", cell: (row) => row.email },
              { label: "Role", cell: (row) => label(row.role) },
              { label: "Expires", cell: (row) => date(row.expires) },
              {
                label: "",
                align: "end",
                cell: (row) => (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      attempt(async () => {
                        await call((api) =>
                          api["organization.people"]["invites.revoke"]({ params: { ...params(), id: row.id } }),
                        )
                        void invitations.refetch()
                      }, `Invite for ${row.email} revoked`)
                    }
                  >
                    Revoke
                  </Button>
                ),
              },
            ]}
          />
        </Panel>
      </Show>
      <Panel title="People" flush>
        <Show when={!members.error} fallback={<Failure error={members.error} />}>
          <Show when={members()} fallback={<Loading />}>
            {(data) => (
              <DataTable
                rows={data().members}
                columns={[
                  {
                    label: "Person",
                    cell: (row) => (
                      <div class="person">
                        <span>{row.email}</span>
                        <Show when={row.name}>
                          <small>{row.name}</small>
                        </Show>
                      </div>
                    ),
                  },
                  {
                    label: "Role",
                    width: "11rem",
                    cell: (row) => (
                      <Show when={scope.can("member.write")} fallback={label(row.role)}>
                        <Select
                          value={row.role}
                          options={roles}
                          aria-label={`Role of ${row.email}`}
                          onValue={(next) => changeRole(row, next)}
                        />
                      </Show>
                    ),
                  },
                  {
                    label: "Groups",
                    cell: (row) => row.groups.join(", ") || <span class="muted">—</span>,
                  },
                  {
                    label: "Status",
                    cell: (row) =>
                      row.active ? <Tag tone="success">Active</Tag> : <Tag tone="warning">Suspended</Tag>,
                  },
                  { label: "Joined", cell: (row) => date(row.joined) },
                  {
                    label: "",
                    align: "end",
                    cell: (row) => (
                      <Show when={scope.can("member.write")}>
                        <div class="row-actions">
                          <Show when={scope.can("token.write")}>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() =>
                                attempt(async () => {
                                  const issued = await call((api) =>
                                    api["organization.people"]["members.token"]({
                                      params: { ...params(), user: row.id },
                                      payload: {},
                                    }),
                                  )
                                  setSecret({
                                    title: `Access token for ${row.email}`,
                                    value: issued.token,
                                    hint: `They can run: kilo org login --url ${location.origin} --org ${scope.slug()} --token <token>`,
                                  })
                                })
                              }
                            >
                              Issue token
                            </Button>
                          </Show>
                          <Button
                            variant="ghost"
                            size="sm"
                            class="danger"
                            onClick={() =>
                              confirm({
                                title: `Remove ${row.email}?`,
                                description: "They lose access to this organization immediately.",
                                action: "Remove",
                                run: () =>
                                  attempt(async () => {
                                    await call((api) =>
                                      api["organization.people"]["members.remove"]({
                                        params: { ...params(), user: row.id },
                                      }),
                                    )
                                    void refetch()
                                  }, `${row.email} removed`),
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
    </Page>
  )
}
