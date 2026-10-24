import { createSignal, Show, type JSX } from "solid-js"
import { Card } from "@kilocode/kilo-web-ui/card"
import { IconButton } from "@kilocode/kilo-web-ui/icon-button"
import { Input } from "@kilocode/kilo-web-ui/input"

// The clipboard API needs a secure context; plain-HTTP deployments fall back to a selection copy.
async function write(text: string) {
  if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text)
  const area = document.createElement("textarea")
  area.value = text
  area.style.position = "fixed"
  area.style.opacity = "0"
  document.body.append(area)
  area.select()
  document.execCommand("copy")
  area.remove()
}

export function Copyable(props: {
  label: string
  value: string
  hint?: JSX.Element
  block?: boolean
  hideLabel?: boolean
}) {
  const [copied, setCopied] = createSignal(false)
  const copy = async () => {
    await write(props.value)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }
  return (
    <div class="ui-field" classList={{ bare: props.hideLabel }}>
      <span classList={{ "sr-only": props.hideLabel }}>{props.label}</span>
      <div class="copyable" classList={{ block: props.block }}>
        <Show
          when={props.block}
          fallback={
            <Input
              class="mono"
              readOnly
              value={props.value}
              aria-label={props.label}
              onFocus={(event) => event.currentTarget.select()}
            />
          }
        >
          <pre class="code-block">{props.value}</pre>
        </Show>
        <IconButton
          icon={copied() ? "check" : "copy"}
          variant="ghost"
          size="small"
          aria-label={copied() ? "Copied" : `Copy ${props.label}`}
          onClick={copy}
        />
      </div>
      <Show when={props.hint}>{(hint) => <small>{hint()}</small>}</Show>
    </div>
  )
}

// A credential the server returns exactly once, at creation.
export function Secret(props: { title: string; value: string; hint?: JSX.Element; onDismiss: () => void }) {
  return (
    <Card variant="warning" class="secret" size="sm">
      <div class="secret-head">
        <div>
          <strong>{props.title}</strong>
          <span>Shown only once. Copy it now and deliver it privately.</span>
        </div>
        <IconButton icon="close-small" variant="ghost" size="small" aria-label="Dismiss" onClick={props.onDismiss} />
      </div>
      <Copyable label={props.title} value={props.value} hint={props.hint} hideLabel />
    </Card>
  )
}
