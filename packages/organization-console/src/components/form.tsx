import { For, Show, splitProps, type ComponentProps, type JSX } from "solid-js"
import { Input } from "@kilocode/kilo-web-ui/input"
import { Tag } from "@kilocode/kilo-web-ui/tag"
import { Textarea } from "@kilocode/kilo-web-ui/textarea"

// Form controls in the idiom of Kilo's web console: a label wrapping a native control, with
// optional help text underneath (.ui-field), and settings toggles as buttons (.ui-toggle).

type Common = { label: string; hint?: JSX.Element; error?: string; hideLabel?: boolean; class?: string }

function Frame(props: Common & { children: JSX.Element }) {
  return (
    <label
      class="ui-field"
      classList={{ [props.class ?? ""]: !!props.class, invalid: !!props.error, bare: !!props.hideLabel }}
    >
      <span classList={{ "sr-only": props.hideLabel }}>{props.label}</span>
      {props.children}
      <Show when={props.error} fallback={<Show when={props.hint}>{(hint) => <small>{hint()}</small>}</Show>}>
        <small class="field-error">{props.error}</small>
      </Show>
    </label>
  )
}

export function TextInput(
  props: Common &
    Omit<ComponentProps<"input">, "onInput" | "value"> & { value: string; onValue: (value: string) => void },
) {
  const [local, rest] = splitProps(props, ["label", "hint", "error", "hideLabel", "class", "value", "onValue"])
  return (
    <Frame label={local.label} hint={local.hint} error={local.error} hideLabel={local.hideLabel} class={local.class}>
      <Input
        {...rest}
        value={local.value}
        aria-invalid={local.error ? true : undefined}
        onInput={(event) => local.onValue(event.currentTarget.value)}
      />
    </Frame>
  )
}

export function TextArea(
  props: Common &
    Omit<ComponentProps<"textarea">, "onInput" | "value"> & { value: string; onValue: (value: string) => void },
) {
  const [local, rest] = splitProps(props, ["label", "hint", "error", "hideLabel", "class", "value", "onValue"])
  return (
    <Frame label={local.label} hint={local.hint} error={local.error} hideLabel={local.hideLabel} class={local.class}>
      <Textarea
        {...rest}
        value={local.value}
        aria-invalid={local.error ? true : undefined}
        onInput={(event) => local.onValue(event.currentTarget.value)}
      />
    </Frame>
  )
}

// A native select, as kilo-web-ui's SimpleSelect, styled like the console's other selects. Each
// option carries `selected`, so the current value shows however the options were rendered.
export function Select<T extends string>(
  props: Omit<ComponentProps<"select">, "value" | "onChange"> & {
    value: T | ""
    options: ReadonlyArray<{ value: T; label: string }>
    placeholder?: string
    onValue: (value: T) => void
  },
) {
  const [local, rest] = splitProps(props, ["value", "options", "placeholder", "onValue"])
  return (
    <select
      {...rest}
      onChange={(event) => {
        const picked = local.options.find((option) => option.value === event.currentTarget.value)
        if (picked) local.onValue(picked.value)
      }}
    >
      <Show when={local.placeholder}>
        <option value="" disabled selected={local.value === ""}>
          {local.placeholder}
        </option>
      </Show>
      <For each={local.options}>
        {(option) => (
          <option value={option.value} selected={option.value === local.value}>
            {option.label}
          </option>
        )}
      </For>
    </select>
  )
}

export function Choice<T extends string>(
  props: Common & {
    value: T | ""
    options: ReadonlyArray<{ value: T; label: string }>
    placeholder?: string
    disabled?: boolean
    onValue: (value: T) => void
  },
) {
  return (
    <Frame label={props.label} hint={props.hint} error={props.error} hideLabel={props.hideLabel} class={props.class}>
      <Select
        value={props.value}
        options={props.options}
        placeholder={props.placeholder}
        disabled={props.disabled}
        onValue={props.onValue}
      />
    </Frame>
  )
}

export function Toggle(props: {
  label: string
  description: string
  checked: boolean
  disabled?: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <button
      class="ui-toggle"
      classList={{ selected: props.checked }}
      type="button"
      aria-pressed={props.checked}
      disabled={props.disabled}
      onClick={() => props.onChange(!props.checked)}
    >
      <span>
        <strong>{props.label}</strong>
        <small>{props.description}</small>
      </span>
      <Tag tone={props.checked ? "success" : "neutral"}>{props.checked ? "On" : "Off"}</Tag>
    </button>
  )
}

export function Check(props: {
  checked: boolean
  disabled?: boolean
  onChange: (checked: boolean) => void
  children: JSX.Element
}) {
  return (
    <label class="check">
      <input
        type="checkbox"
        checked={props.checked}
        disabled={props.disabled}
        onChange={(event) => props.onChange(event.currentTarget.checked)}
      />
      <span>{props.children}</span>
    </label>
  )
}
