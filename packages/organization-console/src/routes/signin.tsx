import { createSignal, Show } from "solid-js"
import { Button } from "@kilocode/kilo-web-ui/button"
import { Card } from "@kilocode/kilo-web-ui/card"
import { token } from "../api"
import { TextInput } from "../components/form"
import { Frame } from "../components/shell"

export function SignIn(props: { reason?: string }) {
  const [org, setOrg] = createSignal("")
  const [secret, setSecret] = createSignal("")
  return (
    <Frame class="signin">
      <Card class="signin-card" padding={0}>
        <header class="signin-head">
          <img src={`${import.meta.env.BASE_URL}tucode-logo.svg`} alt="" width="40" height="40" />
          <h1>Sign in to TU Code Organization</h1>
          <p>Use your organization's single sign-on.</p>
        </header>
        <form
          class="ui-form"
          onSubmit={(event) => {
            event.preventDefault()
            location.assign(`/sso/${encodeURIComponent(org().trim())}/start`)
          }}
        >
          <TextInput label="Organization" placeholder="acme" value={org()} onValue={setOrg} required autofocus />
          <Button type="submit" variant="primary" size="lg" disabled={!org().trim()}>
            Continue with single sign-on
          </Button>
        </form>
        <div class="divider">
          <span>or</span>
        </div>
        <form
          class="ui-form"
          onSubmit={(event) => {
            event.preventDefault()
            token.set(secret().trim())
            location.reload()
          }}
        >
          <TextInput
            label="Access token"
            hint="For example the bootstrap owner token. Kept for this tab only."
            type="password"
            placeholder="korg_…"
            autocomplete="off"
            value={secret()}
            onValue={setSecret}
            required
          />
          <Button type="submit" variant="secondary" disabled={!secret().trim()}>
            Use access token
          </Button>
        </form>
        <Show when={props.reason}>
          <p class="signin-reason">{props.reason}</p>
        </Show>
      </Card>
    </Frame>
  )
}
