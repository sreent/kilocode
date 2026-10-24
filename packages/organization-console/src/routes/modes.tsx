import { Show, createResource, createSignal } from "solid-js"
import { Schema } from "effect"
import { Button } from "@kilocode/kilo-web-ui/button"
import { Tag } from "@kilocode/kilo-web-ui/tag"
import { AgentMode, Mode, Permission } from "@organization/protocol/schema"
import { call } from "../api"
import { useOrg } from "../context"
import { when } from "../format"
import { attempt, confirm } from "../components/feedback"
import { Choice, TextArea, TextInput } from "../components/form"
import { Failure, Loading, Page, Panel } from "../components/page"
import { DataTable } from "../components/table"

type Stored = Awaited<ReturnType<typeof listModes>>["modes"][number]
type Kind = (typeof AgentMode.literals)[number]

const listModes = (org: string) => call((api) => api["organization.governance"]["modes.list"]({ params: { org } }))
const kinds = [
  { value: "primary", label: "Primary agent" },
  { value: "subagent", label: "Subagent" },
  { value: "all", label: "Both" },
] satisfies ReadonlyArray<{ value: Kind; label: string }>
const decodeMode = Schema.decodeUnknownResult(Mode)
const decodePermission = Schema.decodeUnknownResult(Permission)

function rules(text: string) {
  if (!text.trim()) return { ok: true as const, value: undefined }
  try {
    const parsed = decodePermission(JSON.parse(text))
    if (parsed._tag === "Success") return { ok: true as const, value: parsed.success }
    return { ok: false as const, error: parsed.failure.message }
  } catch (cause) {
    return {
      ok: false as const,
      error: `Permissions are not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
    }
  }
}

export function Modes() {
  const scope = useOrg()
  const [modes, { refetch }] = createResource(scope.slug, listModes)
  const [editing, setEditing] = createSignal<Stored>()
  const [slug, setSlug] = createSignal("")
  const [name, setName] = createSignal("")
  const [description, setDescription] = createSignal("")
  const [kind, setKind] = createSignal<Kind>("subagent")
  const [model, setModel] = createSignal("")
  const [prompt, setPrompt] = createSignal("")
  const [permission, setPermission] = createSignal("")
  const [error, setError] = createSignal<string>()

  const edit = (mode?: Stored) => {
    setEditing(mode)
    setSlug(mode?.slug ?? "")
    setName(mode?.name ?? "")
    setDescription(mode?.description ?? "")
    setKind(mode?.mode ?? "subagent")
    setModel(mode?.model ?? "")
    setPrompt(mode?.prompt ?? "")
    setPermission(mode?.permission ? JSON.stringify(mode.permission, null, 2) : "")
    setError(undefined)
  }

  const save = async (event: SubmitEvent) => {
    event.preventDefault()
    const checked = rules(permission())
    if (!checked.ok) {
      setError(checked.error)
      return
    }
    const input = decodeMode({
      slug: slug().trim(),
      name: name().trim(),
      description: description().trim(),
      mode: kind(),
      prompt: prompt(),
      ...(model().trim() ? { model: model().trim() } : {}),
      ...(checked.value ? { permission: checked.value } : {}),
    })
    if (input._tag === "Failure") {
      setError(input.failure.message)
      return
    }
    setError(undefined)
    const current = editing()
    const ok = await attempt(
      () =>
        call((api) =>
          current
            ? api["organization.governance"]["modes.update"]({
                params: { org: scope.slug(), id: current.id },
                payload: input.success,
              })
            : api["organization.governance"]["modes.create"]({ params: { org: scope.slug() }, payload: input.success }),
        ),
      current ? `Mode ${input.success.name} updated` : `Mode ${input.success.name} created`,
    )
    if (!ok) return
    edit(undefined)
    void refetch()
  }

  return (
    <Page
      title="Modes"
      description="Organization agents, delivered to every CLI and IDE client as locked modes people cannot edit."
    >
      <Panel flush>
        <Show when={!modes.error} fallback={<Failure error={modes.error} />}>
          <Show when={modes()} fallback={<Loading />}>
            {(data) => (
              <DataTable
                rows={data().modes}
                empty="No organization modes yet."
                columns={[
                  { label: "Slug", cell: (row) => <span class="mono">{row.slug}</span> },
                  { label: "Name", cell: (row) => row.name },
                  { label: "Kind", cell: (row) => <Tag>{kinds.find((item) => item.value === row.mode)?.label}</Tag> },
                  { label: "Model", cell: (row) => row.model ?? <span class="muted">Default</span> },
                  { label: "Updated", cell: (row) => when(row.updated) },
                  {
                    label: "",
                    align: "end",
                    cell: (row) => (
                      <Show when={scope.can("mode.write")}>
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
                                title: `Delete ${row.name}?`,
                                description: "Clients drop the mode at their next policy refresh.",
                                action: "Delete mode",
                                run: () =>
                                  attempt(async () => {
                                    await call((api) =>
                                      api["organization.governance"]["modes.remove"]({
                                        params: { org: scope.slug(), id: row.id },
                                      }),
                                    )
                                    if (editing()?.id === row.id) edit(undefined)
                                    void refetch()
                                  }, `Mode ${row.name} deleted`),
                              })
                            }
                          >
                            Delete
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
      <Show when={scope.can("mode.write")}>
        <Panel
          title={editing() ? `Edit ${editing()!.name}` : "New mode"}
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
              <TextInput label="Slug" placeholder="security-reviewer" value={slug()} onValue={setSlug} required />
              <TextInput label="Name" placeholder="Security Reviewer" value={name()} onValue={setName} required />
            </div>
            <TextInput label="Description" value={description()} onValue={setDescription} />
            <div class="grid-2">
              <Choice label="Kind" value={kind()} options={kinds} onValue={setKind} />
              <TextInput
                label="Model"
                hint="Optional, e.g. anthropic/claude-sonnet-4"
                value={model()}
                onValue={setModel}
              />
            </div>
            <TextArea label="Prompt" value={prompt()} onValue={setPrompt} required class="mono-field" rows={8} />
            <TextArea
              label="Permissions"
              hint='Optional JSON, e.g. { "edit": "deny" }'
              value={permission()}
              onValue={setPermission}
              class="mono-field"
              rows={4}
              spellcheck={false}
            />
            <Show when={error()}>
              <p class="field-error">{error()}</p>
            </Show>
            <div class="form-actions">
              <Button type="submit" variant="primary">
                {editing() ? "Save mode" : "Create mode"}
              </Button>
            </div>
          </form>
        </Panel>
      </Show>
    </Page>
  )
}
