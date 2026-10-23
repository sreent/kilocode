import { Show, type JSX, type ParentProps } from "solid-js"
import { Card } from "@kilocode/kilo-web-ui/card"
import { Banner } from "@kilocode/kilo-web-ui/console"
import { Spinner } from "@kilocode/kilo-web-ui/spinner"

// The same page anatomy as Kilo's web console: a settings page with a header, then cards.

export function Page(props: ParentProps<{ title: JSX.Element; description?: JSX.Element; actions?: JSX.Element }>) {
  return (
    <main class="config-page">
      <section class="config-page-header">
        <div>
          <h1>{props.title}</h1>
          <Show when={props.description}>{(description) => <p>{description()}</p>}</Show>
        </div>
        <Show when={props.actions}>{(actions) => <div class="config-page-actions">{actions()}</div>}</Show>
      </section>
      {props.children}
    </main>
  )
}

export function Panel(
  props: ParentProps<{
    title?: JSX.Element
    description?: JSX.Element
    actions?: JSX.Element
    footer?: JSX.Element
    flush?: boolean
  }>,
) {
  return (
    <Card class="ui-card" padding={0}>
      <Show when={props.title || props.actions}>
        <header class="ui-card-header">
          <div>
            <Show when={props.title}>{(title) => <h2>{title()}</h2>}</Show>
            <Show when={props.description}>{(description) => <p>{description()}</p>}</Show>
          </div>
          <Show when={props.actions}>{(actions) => <div class="ui-card-actions">{actions()}</div>}</Show>
        </header>
      </Show>
      <div classList={{ "ui-card-body": !props.flush }}>{props.children}</div>
      <Show when={props.footer}>{(footer) => <footer class="ui-card-footer">{footer()}</footer>}</Show>
    </Card>
  )
}

export function Loading() {
  return (
    <div class="inline-loading" role="status" aria-label="Loading">
      <Spinner />
    </div>
  )
}

export function Splash() {
  return (
    <section class="console-loading console-loading-fullscreen" role="status" aria-label="Loading Kilo Enterprise">
      <img src={`${import.meta.env.BASE_URL}kilo-logo.svg`} class="console-loading-logo" alt="" />
    </section>
  )
}

export function Failure(props: { error: unknown }) {
  return (
    <Banner tone="critical" title="Something went wrong">
      {props.error instanceof Error ? props.error.message : String(props.error)}
    </Banner>
  )
}

export function Muted(props: ParentProps) {
  return <p class="empty">{props.children}</p>
}
