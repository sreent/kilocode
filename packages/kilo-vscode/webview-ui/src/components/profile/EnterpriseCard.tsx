import { Component, Match, Show, Switch, createSignal, onCleanup, onMount } from "solid-js"
import { Button } from "@kilocode/kilo-ui/button"
import { Card } from "@kilocode/kilo-ui/card"
import { TextField } from "@kilocode/kilo-ui/text-field"
import { useVSCode } from "../../context/vscode"
import { useLanguage } from "../../context/language"
import DeviceAuthCard from "./DeviceAuthCard"
import type { DeviceAuthStatus, EnterpriseStatus, ExtensionMessage } from "../../types/messages"

// The self-hosted organization this device is enrolled in, if any: who is signed in, the policy
// in force and why the agent is blocked, plus device sign-in and sign-out. The CLI owns all of
// it; this card shows what `kilo serve` reports.

const label = {
  "font-size": "var(--kilo-font-size-11)",
  "text-transform": "uppercase",
  "letter-spacing": "0.5px",
  color: "var(--vscode-descriptionForeground)",
  margin: "0 0 4px 0",
} as const

const detail = {
  "font-size": "var(--kilo-font-size-12)",
  color: "var(--vscode-descriptionForeground)",
  margin: "4px 0 0 0",
} as const

const EnterpriseCard: Component = () => {
  const vscode = useVSCode()
  const language = useLanguage()
  const [status, setStatus] = createSignal<EnterpriseStatus>()
  const [phase, setPhase] = createSignal<DeviceAuthStatus>("idle")
  const [error, setError] = createSignal<string>()
  const [connecting, setConnecting] = createSignal(false)
  const [url, setUrl] = createSignal("")
  const [org, setOrg] = createSignal("")

  onMount(() => {
    const unsubscribe = vscode.onMessage((message: ExtensionMessage) => {
      if (message.type === "enterpriseStatus") {
        setStatus(message.status)
        // The code shows while this card waits for its own sign-in. The CLI keeps reporting one
        // that was cancelled until it expires, and that one stays hidden.
        const waiting = phase() === "initiating" || phase() === "pending"
        if (message.status.signin && waiting) setPhase("pending")
        else if (phase() !== "error") setPhase("idle")
        if (message.status.user) setConnecting(false)
      }
      if (message.type === "enterpriseSigninFailed") {
        setPhase("error")
        setError(message.error)
      }
    })
    onCleanup(unsubscribe)
    vscode.postMessage({ type: "requestEnterpriseStatus" })
  })

  const signin = () => {
    setError(undefined)
    setPhase("initiating")
    const current = status()
    // An enrolled device signs in to its own org; otherwise to the one entered here.
    vscode.postMessage({
      type: "enterpriseSignin",
      ...(current?.enabled ? {} : { url: url(), org: org() }),
    })
  }

  const cancel = () => {
    setPhase("idle")
    setError(undefined)
    vscode.postMessage({ type: "enterpriseCancel" })
  }

  const expires = () => {
    const pending = status()?.signin
    return pending ? Math.max(0, Math.round((pending.expires - Date.now()) / 1000)) : undefined
  }

  const name = () => status()?.org?.name ?? status()?.org?.slug ?? ""

  const flow = () => (
    <DeviceAuthCard
      title={language.t("profile.enterprise.signinTitle", { org: name() || org() })}
      status={phase()}
      code={status()?.signin?.code}
      verificationUrl={status()?.signin?.link}
      expiresIn={expires()}
      error={error()}
      onCancel={cancel}
      onRetry={signin}
    />
  )

  // Nothing renders until the CLI answers, so the profile looks as before without an organization.
  return (
    <Show when={status()}>
      {(current) => (
        <div style={{ "margin-bottom": "12px" }}>
          <Switch>
            {/* Signed in: the org, the person and the policy in force. */}
            <Match when={current().user}>
              {(user) => (
                <Card>
                  <p style={label}>{language.t("profile.enterprise.title")}</p>
                  <p style={{ "font-size": "var(--kilo-font-size-14)", "font-weight": "600", margin: 0 }}>{name()}</p>
                  <p style={detail}>
                    {language.t("profile.enterprise.signedIn", { email: user().email, role: user().role })}
                  </p>
                  <Show when={current().policy}>
                    {(policy) => (
                      <p style={detail}>
                        {language.t("profile.enterprise.policy", {
                          version: String(policy().version),
                          time: new Date(policy().fetched).toLocaleString(),
                        })}
                      </p>
                    )}
                  </Show>
                  <Show when={current().gateway.length > 0}>
                    <p style={detail}>
                      {language.t("profile.enterprise.gateway", { providers: current().gateway.join(", ") })}
                    </p>
                  </Show>
                  <Show when={current().blocked}>
                    {(reason) => <p style={{ ...detail, color: "var(--vscode-errorForeground)" }}>{reason()}</p>}
                  </Show>
                  <Show when={current().error}>
                    {(failure) => <p style={detail}>{language.t("profile.enterprise.error", { error: failure() })}</p>}
                  </Show>
                  <Show when={current().source !== "env"}>
                    <div style={{ display: "flex", "justify-content": "flex-end", "margin-top": "8px" }}>
                      <Button
                        variant="ghost"
                        size="small"
                        onClick={() => vscode.postMessage({ type: "enterpriseSignout" })}
                        style={{ color: "var(--vscode-errorForeground)" }}
                      >
                        {language.t("profile.enterprise.action.signout")}
                      </Button>
                    </div>
                  </Show>
                </Card>
              )}
            </Match>
            {/* Enrolled by IT or a stored setup, but not signed in. */}
            <Match when={current().enabled}>
              <Show when={phase() === "idle"} fallback={flow()}>
                <Card>
                  <p style={label}>{language.t("profile.enterprise.title")}</p>
                  <p style={{ ...detail, margin: "0 0 8px 0" }}>
                    {language.t("profile.enterprise.managed", { org: name() })}
                  </p>
                  <Show when={current().error}>
                    {(failure) => (
                      <p style={{ ...detail, margin: "0 0 8px 0" }}>
                        {language.t("profile.enterprise.error", { error: failure() })}
                      </p>
                    )}
                  </Show>
                  <Button variant="primary" onClick={signin}>
                    {language.t("profile.enterprise.action.signin")}
                  </Button>
                </Card>
              </Show>
            </Match>
            {/* Not enrolled: an optional, unobtrusive way to connect to one. */}
            <Match when={!current().enabled}>
              <Show when={phase() === "idle"} fallback={flow()}>
                <Show
                  when={connecting()}
                  fallback={
                    <Button variant="ghost" size="small" onClick={() => setConnecting(true)}>
                      {language.t("profile.enterprise.connect")}
                    </Button>
                  }
                >
                  <Card style={{ display: "flex", "flex-direction": "column", gap: "8px" }}>
                    <p style={label}>{language.t("profile.enterprise.connect")}</p>
                    <TextField
                      label={language.t("profile.enterprise.url")}
                      placeholder="https://ai.example.com"
                      value={url()}
                      onChange={setUrl}
                    />
                    <TextField
                      label={language.t("profile.enterprise.title")}
                      placeholder="acme"
                      value={org()}
                      onChange={setOrg}
                    />
                    <div style={{ display: "flex", gap: "8px", "justify-content": "flex-end" }}>
                      <Button variant="ghost" size="small" onClick={() => setConnecting(false)}>
                        {language.t("common.cancel")}
                      </Button>
                      <Button variant="primary" size="small" onClick={signin} disabled={!url().trim() || !org().trim()}>
                        {language.t("profile.enterprise.action.signin")}
                      </Button>
                    </div>
                  </Card>
                </Show>
              </Show>
            </Match>
          </Switch>
        </div>
      )}
    </Show>
  )
}

export default EnterpriseCard
