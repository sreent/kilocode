import { createEffect, For, Match, on, Show, Switch, type JSX, type ParentProps } from "solid-js"
import { A, useLocation } from "@solidjs/router"
import { Tag } from "@kilocode/kilo-web-ui/tag"
import { useTheme } from "@kilocode/kilo-web-ui/theme"
import type { Capability } from "@organization/protocol/roles"
import { OrgProvider, useOrg, useSession, type Me, type OrgAccess } from "../context"
import { label } from "../format"
import { Confirmation, dismiss, Notices } from "./feedback"
import { Splash } from "./page"
import { SignIn } from "../routes/signin"

// The layout of Kilo's web console: app header, a rail (here, one mark per organization, like the
// console's recent projects), and a settings sidebar beside the scrolling content.

type Item = { path: string; label: string; requires?: Capability }
type Group = { label: string; items: ReadonlyArray<Item> }

// Mirrors the server's role model: an entry is shown only when the role may use it.
const groups: ReadonlyArray<Group> = [
  {
    label: "People",
    items: [
      { path: "/members", label: "Members", requires: "member.read" },
      { path: "/groups", label: "Groups" },
    ],
  },
  {
    label: "Governance",
    items: [
      { path: "/policy", label: "Policy", requires: "policy.read" },
      { path: "/data", label: "Data policy", requires: "policy.read" },
      { path: "/modes", label: "Modes" },
      { path: "/budgets", label: "Budgets", requires: "usage.read" },
      { path: "/gateway", label: "LLM gateway", requires: "gateway.read" },
    ],
  },
  {
    label: "Insight",
    items: [
      { path: "/usage", label: "Usage" },
      { path: "/analytics", label: "Analytics", requires: "usage.read" },
      { path: "/reports", label: "Scheduled reports", requires: "usage.read" },
      { path: "/gateway/calls", label: "Gateway call log", requires: "gateway.read" },
      { path: "/audit", label: "Audit log", requires: "audit.read" },
      { path: "/streams", label: "Audit streaming", requires: "audit.read" },
    ],
  },
  { label: "Identity", items: [{ path: "/security", label: "Single sign-on and SCIM", requires: "sso.write" }] },
  { label: "Structure", items: [{ path: "/suborgs", label: "Sub-organizations", requires: "suborg.read" }] },
]

const schemes = ["system", "light", "dark"] as const

function mark(org: OrgAccess) {
  const parts = org.name.split(/[\s._/-]+/).filter(Boolean)
  return (
    `${parts[0]?.[0] ?? ""}${parts[1]?.[0] ?? parts[0]?.[1] ?? ""}`.toUpperCase() || org.slug.slice(0, 2)
  ).toUpperCase()
}

function Glyph(props: { name: "system" | "light" | "dark" | "logout" }) {
  return (
    <svg class="rail-glyph" viewBox="0 0 24 24" aria-hidden="true" fill="none">
      <Switch>
        <Match when={props.name === "light"}>
          <path d="M12 8a4 4 0 1 0 0 8a4 4 0 0 0 0 -8" />
          <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
        </Match>
        <Match when={props.name === "dark"}>
          <path d="M12 3a6 6 0 0 0 9 9a9 9 0 1 1 -9 -9" />
        </Match>
        <Match when={props.name === "system"}>
          <path d="M4 5h16a1 1 0 0 1 1 1v10a1 1 0 0 1 -1 1h-16a1 1 0 0 1 -1 -1v-10a1 1 0 0 1 1 -1" />
          <path d="M8 21h8M12 17v4" />
        </Match>
        <Match when={props.name === "logout"}>
          <path d="M14 8v-2a2 2 0 0 0 -2 -2h-7a2 2 0 0 0 -2 2v12a2 2 0 0 0 2 2h7a2 2 0 0 0 2 -2v-2" />
          <path d="M9 12h12l-3 -3M18 15l3 -3" />
        </Match>
      </Switch>
    </svg>
  )
}

function Header(props: { account: Me }) {
  const scope = useOrg()
  return (
    <header class="app-header">
      <A class="header-brand" href={`/${scope.slug()}`} end aria-label="tucode Organization home">
        <img
          class="header-mark header-mark-logo"
          src={`${import.meta.env.BASE_URL}tucode-logo.svg`}
          alt=""
          width="28"
          height="28"
        />
        <span class="header-title">
          <span>Organization</span>
        </span>
      </A>
      <nav class="notification-zone" aria-label="Account">
        <span class="header-account">
          <span class="header-email">{props.account.user.email}</span>
          <Tag tone={scope.org().role === "owner" ? "brand" : "neutral"}>{label(scope.org().role)}</Tag>
        </span>
      </nav>
    </header>
  )
}

function Rail(props: { account: Me }) {
  const session = useSession()
  const theme = useTheme()
  const next = () => schemes[(schemes.indexOf(theme.colorScheme()) + 1) % schemes.length]
  return (
    <aside class="rail" aria-label="Organizations">
      <nav class="rail-favorites" aria-label="Organizations">
        <For each={props.account.orgs}>
          {(org) => (
            <A
              class="favorite-project"
              classList={{ managed: org.inherited }}
              href={`/${org.slug}`}
              aria-label={org.name}
              title={org.inherited ? `${org.name} (managed from the parent organization)` : org.name}
            >
              {mark(org)}
            </A>
          )}
        </For>
      </nav>
      <nav class="rail-bottom" aria-label="Appearance and account">
        <button
          type="button"
          class="rail-action"
          aria-label={`Theme: ${theme.colorScheme()}. Switch to ${next()}.`}
          title={`Theme: ${theme.colorScheme()}`}
          onClick={() => theme.setColorScheme(next())}
        >
          <Glyph name={theme.colorScheme()} />
        </button>
        <button type="button" class="rail-action" aria-label="Sign out" title="Sign out" onClick={session.signOut}>
          <Glyph name="logout" />
        </button>
      </nav>
    </aside>
  )
}

function Sidebar() {
  const scope = useOrg()
  const visible = () =>
    groups
      .map((group) => ({ ...group, items: group.items.filter((item) => !item.requires || scope.can(item.requires)) }))
      .filter((group) => group.items.length > 0)
  return (
    <aside class="config-sidebar" aria-label="Organization sections">
      <div class="config-sidebar-title">
        <span>{scope.org().inherited ? "Managed organization" : "Organization"}</span>
        <span class="config-sidebar-scope">
          <span>{scope.org().name}</span>
        </span>
      </div>
      <nav class="config-options">
        <A class="config-top-option" href={`/${scope.slug()}`} end>
          <span>Overview</span>
        </A>
        <For each={visible()}>
          {(group) => (
            <section class="config-group">
              <div class="config-group-title">
                <span>{group.label}</span>
              </div>
              <div class="config-group-items">
                <For each={group.items}>
                  {(item) => (
                    <A class="config-option" href={`/${scope.slug()}${item.path}`}>
                      <span>{item.label}</span>
                    </A>
                  )}
                </For>
              </div>
            </section>
          )}
        </For>
      </nav>
    </aside>
  )
}

// Pages remount when the organization changes, so no form state or revealed secret carries over.
function Content(props: ParentProps) {
  const scope = useOrg()
  const location = useLocation()
  // An outcome belongs to the page it happened on.
  createEffect(on(() => location.pathname, dismiss, { defer: true }))
  return (
    <section class="content">
      <Notices />
      <Show when={scope.org().id} keyed>
        {(org) => <div data-org={org}>{props.children}</div>}
      </Show>
    </section>
  )
}

// Everything themed lives under .kilo-console, as in Kilo's web console; the class follows the
// resolved color scheme so the shell, its dialogs and the html-level tokens always agree.
export function Frame(props: ParentProps<{ class?: string }>) {
  const theme = useTheme()
  return (
    <div class={`kilo-console ${props.class ?? ""}`} classList={{ dark: theme.mode() === "dark" }}>
      {props.children}
    </div>
  )
}

export function Shell(props: ParentProps): JSX.Element {
  const session = useSession()
  return (
    <Switch fallback={<Splash />}>
      <Match when={session.account.error}>
        <SignIn />
      </Match>
      <Match when={session.account()?.orgs.length === 0}>
        <SignIn reason="This account has no organization access." />
      </Match>
      <Match when={session.account()}>
        {(account) => (
          <OrgProvider orgs={account().orgs}>
            <Frame class="console-shell">
              <Header account={account()} />
              <div class="console-body">
                <Rail account={account()} />
                <main class="console-main">
                  <section class="config-shell">
                    <Sidebar />
                    <Content>{props.children}</Content>
                  </section>
                </main>
              </div>
              <Confirmation />
            </Frame>
          </OrgProvider>
        )}
      </Match>
    </Switch>
  )
}
