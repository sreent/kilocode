import { createSignal, Show } from "solid-js"
import { Schema } from "effect"
import { Button } from "@kilocode/kilo-web-ui/button"
import { TextArea } from "./form"

// Raw JSON editing for structured settings, validated in the browser against the same schema the
// server enforces, so mistakes are caught before they are sent.
export function JsonEditor<S extends Schema.Decoder<unknown>>(props: {
  label: string
  schema: S
  value: unknown
  disabled?: boolean
  onSave: (value: S["Type"]) => Promise<void>
}) {
  const decode = Schema.decodeUnknownResult(props.schema)
  const [text, setText] = createSignal(JSON.stringify(props.value, null, 2))
  const [error, setError] = createSignal<string>()
  const [busy, setBusy] = createSignal(false)

  const save = async () => {
    const parsed = (() => {
      try {
        return { value: JSON.parse(text()) as unknown }
      } catch (cause) {
        return { error: cause instanceof Error ? cause.message : String(cause) }
      }
    })()
    if ("error" in parsed) {
      setError(`Not valid JSON: ${parsed.error}`)
      return
    }
    const result = decode(parsed.value)
    if (result._tag === "Failure") {
      setError(result.failure.message)
      return
    }
    setError(undefined)
    setBusy(true)
    await props.onSave(result.success).finally(() => setBusy(false))
  }

  return (
    <div class="ui-form">
      <TextArea
        label={props.label}
        hideLabel
        class="json-editor"
        value={text()}
        onValue={setText}
        readOnly={props.disabled}
        spellcheck={false}
        error={error()}
      />
      <Show when={!props.disabled}>
        <div class="form-actions">
          <Button variant="primary" onClick={save} disabled={busy()}>
            Save
          </Button>
        </div>
      </Show>
    </div>
  )
}
