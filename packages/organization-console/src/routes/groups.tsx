import { For, Show, createResource, createSignal } from "solid-js"
import { Button } from "@kilocode/kilo-web-ui/button"
import { Tag } from "@kilocode/kilo-web-ui/tag"
import type { ModelAccess } from "@organization/protocol/schema"
import { call } from "../api"
import { useOrg } from "../context"
import { attempt, confirm } from "../components/feedback"
import { Check, Choice, TextInput } from "../components/form"
import { Failure, Loading, Muted, Page, Panel } from "../components/page"
import { DataTable } from "../components/table"

type Group = Awaited<ReturnType<typeof listGroups>>["groups"][number]
type Member = { id: string; email: string }
type Access = "inherit" | ModelAccess["mode"]

const listGroups = (org: string) => call((api) => api["organization.people"]["groups.list"]({ params: { org } }))
const describe: Record<Access, string> = {
  inherit: "No model policy",
  all: "All models",
  selected: "Selected models",
  none: "No models",
}
const options = (["inherit", "all", "selected", "none"] as const).map((value) => ({ value, label: describe[value] }))

export function Groups() {
  const scope = useOrg()
  return (
    <Show when={scope.can("group.read")} fallback={<Mine />}>
      <Manage />
    </Show>
  )
}

function Mine() {
  const scope = useOrg()
  const [groups] = createResource(scope.slug, (org) =>
    call((api) => api["organization.people"]["groups.mine"]({ params: { org } })),
  )
  return (
    <Page
      title="Your groups"
      description="Groups grant access to additional models on top of the organization default."
    >
      <Panel flush>
        <Show when={!groups.error} fallback={<Failure error={groups.error} />}>
          <Show when={groups()} fallback={<Loading />}>
            {(data) => (
              <DataTable
                rows={data().groups}
                columns={[{ label: "Group", cell: (row) => row.name }]}
                empty="You are not in any group."
              />
            )}
          </Show>
        </Show>
      </Panel>
    </Page>
  )
}

function Manage() {
  const scope = useOrg()
  const [groups, { refetch }] = createResource(scope.slug, listGroups)
  const [members] = createResource(
    () => scope.can("group.write") && scope.slug(),
    (org) => call((api) => api["organization.people"]["members.list"]({ params: { org } })),
  )
  const [name, setName] = createSignal("")
  const create = async (event: SubmitEvent) => {
    event.preventDefault()
    const ok = await attempt(
      () =>
        call((api) =>
          api["organization.people"]["groups.create"]({
            params: { org: scope.slug() },
            payload: { name: name().trim() },
          }),
        ),
      `Group ${name().trim()} created`,
    )
    if (!ok) return
    setName("")
    void refetch()
  }
  return (
    <Page
      title="Groups"
      description="Effective model access is the organization ceiling ∩ (the default policy ∪ the grants of every group a person is in)."
    >
      <Show when={scope.can("group.write")}>
        <Panel title="New group">
          <form class="inline-form" onSubmit={create}>
            <TextInput label="Name" placeholder="Research" value={name()} onValue={setName} required class="grow" />
            <Button type="submit" variant="primary" disabled={!name().trim()}>
              Create group
            </Button>
          </form>
        </Panel>
      </Show>
      <Show when={!groups.error} fallback={<Failure error={groups.error} />}>
        <Show when={groups()} fallback={<Loading />}>
          {(data) => (
            <Show
              when={scope.can("group.write")}
              fallback={
                <Panel flush>
                  <DataTable
                    rows={data().groups}
                    empty="No groups yet."
                    columns={[
                      { label: "Group", cell: (row) => row.name },
                      { label: "Model access", cell: (row) => describe[row.models?.mode ?? "inherit"] },
                      { label: "Members", align: "end", cell: (row) => String(row.members.length) },
                    ]}
                  />
                </Panel>
              }
            >
              <For each={data().groups} fallback={<Muted>No groups yet.</Muted>}>
                {(group) => <Editor group={group} members={members()?.members ?? []} saved={() => void refetch()} />}
              </For>
            </Show>
          )}
        </Show>
      </Show>
    </Page>
  )
}

function Editor(props: { group: Group; members: ReadonlyArray<Member>; saved: () => void }) {
  const scope = useOrg()
  const [mode, setMode] = createSignal<Access>(props.group.models?.mode ?? "inherit")
  const [items, setItems] = createSignal((props.group.models?.items ?? []).join(", "))
  const [chosen, setChosen] = createSignal(new Set(props.group.members.map((member) => member.id)))
  const params = () => ({ org: scope.slug(), id: props.group.id })

  const save = () =>
    attempt(async () => {
      const current = mode()
      const models: ModelAccess | null =
        current === "inherit"
          ? null
          : {
              mode: current,
              items: items()
                .split(",")
                .map((item) => item.trim())
                .filter(Boolean),
            }
      await call((api) => api["organization.people"]["groups.update"]({ params: params(), payload: { models } }))
      await call((api) =>
        api["organization.people"]["groups.members"]({ params: params(), payload: { users: [...chosen()] } }),
      )
      props.saved()
    }, `Saved ${props.group.name}`)

  const toggle = (id: string, checked: boolean) => {
    const next = new Set(chosen())
    if (checked) next.add(id)
    if (!checked) next.delete(id)
    setChosen(next)
  }

  return (
    <Panel
      title={
        <span class="title-with-tag">
          {props.group.name}
          <Tag>{chosen().size === 1 ? "1 member" : `${chosen().size} members`}</Tag>
          <Show when={props.group.external}>
            <Tag tone="info">SCIM</Tag>
          </Show>
        </span>
      }
      description={props.group.external ? "Managed by your identity provider." : undefined}
      footer={
        <>
          <Button
            variant="ghost"
            class="danger"
            onClick={() =>
              confirm({
                title: `Delete ${props.group.name}?`,
                description: "Its members keep their organization access but lose the group's model grants.",
                action: "Delete group",
                run: () =>
                  attempt(async () => {
                    await call((api) => api["organization.people"]["groups.remove"]({ params: params() }))
                    props.saved()
                  }, `Deleted ${props.group.name}`),
              })
            }
          >
            Delete
          </Button>
          <Button variant="primary" onClick={save}>
            Save
          </Button>
        </>
      }
    >
      <div class="split">
        <div class="ui-form">
          <Choice label="Model access" value={mode()} options={options} onValue={setMode} />
          <Show when={mode() === "selected"}>
            <TextInput
              label="Models"
              hint="Comma-separated. A bare provider (anthropic) means all of its models; otherwise a glob over provider/model."
              placeholder="anthropic, openrouter/*:free"
              value={items()}
              onValue={setItems}
            />
          </Show>
        </div>
        <div class="ui-field">
          <span>Members</span>
          <div class="checklist">
            <For each={props.members} fallback={<span class="muted">No members to add.</span>}>
              {(member) => (
                <Check checked={chosen().has(member.id)} onChange={(checked) => toggle(member.id, checked)}>
                  {member.email}
                </Check>
              )}
            </For>
          </div>
        </div>
      </div>
    </Panel>
  )
}
