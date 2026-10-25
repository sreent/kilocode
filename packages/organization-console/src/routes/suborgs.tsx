import { Show, createResource, createSignal } from "solid-js"
import { A } from "@solidjs/router"
import { Button } from "@kilocode/kilo-web-ui/button"
import { call } from "../api"
import { useOrg, useSession } from "../context"
import { count, money } from "../format"
import { attempt } from "../components/feedback"
import { TextInput } from "../components/form"
import { Failure, Loading, Page, Panel } from "../components/page"
import { DataTable } from "../components/table"

const slugify = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63)

export function Suborgs() {
  const scope = useOrg()
  const session = useSession()
  const [suborgs, { refetch }] = createResource(scope.slug, (org) =>
    call((api) => api["organization.org"]["suborgs.list"]({ params: { org } })),
  )
  const [budgets] = createResource(
    () => scope.can("usage.read") && scope.slug(),
    (org) => call((api) => api["organization.governance"]["budgets.get"]({ params: { org } })),
  )
  // The monthly allowance this organization gives a sub-organization, set on the Budgets page.
  const allowance = (id: string) =>
    budgets()?.budgets.find((row) => row.scope === "suborg" && row.target === id && row.period === "month")?.amount
  const [name, setName] = createSignal("")
  const [slug, setSlug] = createSignal("")
  const [edited, setEdited] = createSignal(false)
  const reachable = (slug: string) => session.account()?.orgs.some((org) => org.slug === slug) ?? false

  const create = async (event: SubmitEvent) => {
    event.preventDefault()
    const ok = await attempt(
      () =>
        call((api) =>
          api["organization.org"]["suborgs.create"]({
            params: { org: scope.slug() },
            payload: { name: name().trim(), slug: slug().trim() },
          }),
        ),
      `Sub-organization ${name().trim()} created`,
    )
    if (!ok) return
    setName("")
    setSlug("")
    setEdited(false)
    void refetch()
    // The new org appears in the rail once the account is reloaded.
    void session.refetch()
  }

  return (
    <Page
      title="Sub-organizations"
      description="Each sub-organization has its own members, policy and budgets. Owners, admins and billing managers of this organization manage them without a seat. Give each an allowance on the Budgets page; this organization's own budget covers them all."
    >
      <Show when={scope.can("suborg.write") && !scope.org().parent}>
        <Panel title="New sub-organization">
          <form class="inline-form" onSubmit={create}>
            <TextInput
              label="Name"
              placeholder="Business unit"
              value={name()}
              onValue={(value) => {
                setName(value)
                if (!edited()) setSlug(slugify(value))
              }}
              required
              class="grow"
            />
            <TextInput
              label="Slug"
              placeholder="business-unit"
              pattern="[a-z0-9][a-z0-9-]{1,62}"
              title="Lowercase letters, digits and dashes"
              value={slug()}
              onValue={(value) => {
                setEdited(true)
                setSlug(value)
              }}
              required
            />
            <Button type="submit" variant="primary" disabled={!name().trim() || !slug().trim()}>
              Create
            </Button>
          </form>
        </Panel>
      </Show>
      <Panel flush>
        <Show when={!suborgs.error} fallback={<Failure error={suborgs.error} />}>
          <Show when={suborgs()} fallback={<Loading />}>
            {(data) => (
              <DataTable
                rows={data().suborgs}
                empty="No sub-organizations yet."
                columns={[
                  {
                    label: "Name",
                    cell: (row) => (
                      <Show when={reachable(row.slug)} fallback={row.name}>
                        <A href={`/${row.slug}`} class="link">
                          {row.name}
                        </A>
                      </Show>
                    ),
                  },
                  { label: "Slug", cell: (row) => <span class="mono">{row.slug}</span> },
                  { label: "Members", align: "end", cell: (row) => count(row.members) },
                  { label: "Spend this month", align: "end", cell: (row) => money(row.spent) },
                  {
                    label: "Monthly allowance",
                    align: "end",
                    cell: (row) => {
                      const amount = allowance(row.id)
                      return amount === undefined ? <span class="muted">None</span> : money(amount)
                    },
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
