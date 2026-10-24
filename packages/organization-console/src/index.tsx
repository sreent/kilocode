import "@kilocode/kilo-web-ui/styles"
import "./styles.css"
import { Match, Show, Switch, type Component, type ParentProps } from "solid-js"
import { render } from "solid-js/web"
import { Navigate, Route, Router } from "@solidjs/router"
import { Banner } from "@kilocode/kilo-web-ui/console"
import { ThemeProvider } from "@kilocode/kilo-web-ui/theme"
import type { Capability } from "@organization/protocol/roles"
import { SessionProvider, useOrg, useSession } from "./context"
import { label } from "./format"
import { Page, Splash } from "./components/page"
import { Shell } from "./components/shell"
import { Audit } from "./routes/audit"
import { Budgets } from "./routes/budgets"
import { Calls } from "./routes/calls"
import { Data } from "./routes/data"
import { Gateway } from "./routes/gateway"
import { Groups } from "./routes/groups"
import { Members } from "./routes/members"
import { Modes } from "./routes/modes"
import { Overview } from "./routes/overview"
import { Policy } from "./routes/policy"
import { Security } from "./routes/security"
import { Streams } from "./routes/streams"
import { SignIn } from "./routes/signin"
import { Suborgs } from "./routes/suborgs"
import { Usage } from "./routes/usage"

function App(props: ParentProps) {
  return (
    <ThemeProvider defaultTheme="kilo">
      <SessionProvider>{props.children}</SessionProvider>
    </ThemeProvider>
  )
}

// The landing page sends a signed-in account to its first organization.
function Home() {
  const session = useSession()
  return (
    <Switch fallback={<Splash />}>
      <Match when={session.account.error}>
        <SignIn />
      </Match>
      <Match when={session.account()?.orgs.length === 0}>
        <SignIn reason="This account has no organization access." />
      </Match>
      <Match when={session.account()?.orgs[0]}>{(org) => <Navigate href={`/${org().slug}`} />}</Match>
    </Switch>
  )
}

// Pages the role cannot use are hidden from the sidebar; a typed URL explains why instead of
// surfacing the server's 403.
function requires(capability: Capability, View: Component): Component {
  return () => {
    const scope = useOrg()
    return (
      <Show when={scope.can(capability)} fallback={<Forbidden />}>
        <View />
      </Show>
    )
  }
}

function Forbidden() {
  const scope = useOrg()
  return (
    <Page title="Not available">
      <Banner tone="warning" title="Your role cannot open this page">
        Your role in {scope.org().name} is {label(scope.org().role)}. Ask an owner if you need access.
      </Banner>
    </Page>
  )
}

function NotFound() {
  return (
    <Page title="Page not found">
      <Banner tone="info">This page does not exist. Pick a section from the sidebar.</Banner>
    </Page>
  )
}

const root = document.getElementById("root")
if (!root) throw new Error("Missing root element")

const base = import.meta.env.BASE_URL.replace(/\/$/, "")

render(
  () => (
    <Router root={App} base={base || undefined}>
      <Route path="/" component={Home} />
      <Route path="/:org" component={Shell}>
        <Route path="/" component={Overview} />
        <Route path="/members" component={requires("member.read", Members)} />
        <Route path="/groups" component={Groups} />
        <Route path="/policy" component={requires("policy.read", Policy)} />
        <Route path="/data" component={requires("policy.read", Data)} />
        <Route path="/modes" component={Modes} />
        <Route path="/budgets" component={requires("usage.read", Budgets)} />
        <Route path="/gateway" component={requires("gateway.read", Gateway)} />
        <Route path="/gateway/calls" component={requires("gateway.read", Calls)} />
        <Route path="/usage" component={Usage} />
        <Route path="/audit" component={requires("audit.read", Audit)} />
        <Route path="/streams" component={requires("audit.read", Streams)} />
        <Route path="/security" component={requires("sso.write", Security)} />
        <Route path="/suborgs" component={requires("suborg.read", Suborgs)} />
        <Route path="*" component={NotFound} />
      </Route>
    </Router>
  ),
  root,
)
