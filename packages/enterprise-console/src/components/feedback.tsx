import { createSignal, createUniqueId, Show } from "solid-js"
import { Button } from "@kilocode/kilo-web-ui/button"
import { Banner } from "@kilocode/kilo-web-ui/console"
import { Icon } from "@kilocode/kilo-web-ui/icon"
import { IconButton } from "@kilocode/kilo-web-ui/icon-button"

// Kilo's web console reports outcomes in a banner above the page and asks before destructive
// changes in an inline alert dialog; the console keeps both in one place for every route.

type Notice = { tone: "success" | "critical"; text: string }

const [notice, setNotice] = createSignal<Notice>()
const timer = { id: undefined as ReturnType<typeof setTimeout> | undefined }

function show(next: Notice | undefined) {
  clearTimeout(timer.id)
  setNotice(next)
  if (next?.tone === "success") timer.id = setTimeout(() => setNotice(undefined), 4000)
}

export const dismiss = () => show(undefined)

export const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

// Runs an action and reports the outcome; failures carry the server's message.
export async function attempt(action: () => Promise<unknown>, success?: string) {
  try {
    await action()
    show(success ? { tone: "success", text: success } : undefined)
    return true
  } catch (error) {
    show({ tone: "critical", text: message(error) })
    return false
  }
}

export function Notices() {
  return (
    <Show when={notice()}>
      {(item) => (
        <div class="notice" aria-live="polite">
          <Banner
            tone={item().tone}
            action={
              <IconButton
                icon="close-small"
                variant="ghost"
                size="small"
                aria-label="Dismiss"
                onClick={() => show(undefined)}
              />
            }
          >
            {item().text}
          </Banner>
        </div>
      )}
    </Show>
  )
}

type Request = { title: string; description: string; action: string; run: () => Promise<unknown> }

const [request, setRequest] = createSignal<Request>()
const [busy, setBusy] = createSignal(false)

export const confirm = (input: Request) => setRequest(input)

export function Confirmation() {
  const id = createUniqueId()
  const close = () => {
    if (!busy()) setRequest(undefined)
  }
  return (
    <Show when={request()}>
      {(item) => (
        <div
          class="confirm-scrim"
          onKeyDown={(event) => event.key === "Escape" && close()}
          onClick={(event) => event.target === event.currentTarget && close()}
        >
          <section
            class="confirm-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby={`${id}-title`}
            aria-describedby={`${id}-message`}
          >
            <div class="confirm-body">
              <div class="confirm-icon" aria-hidden="true">
                <Icon name="warning" />
              </div>
              <div>
                <h2 id={`${id}-title`}>{item().title}</h2>
                <p id={`${id}-message`}>{item().description}</p>
              </div>
            </div>
            <footer class="confirm-actions">
              <Button variant="ghost" disabled={busy()} onClick={close} autofocus>
                Cancel
              </Button>
              <Button
                variant="destructive"
                disabled={busy()}
                onClick={async () => {
                  setBusy(true)
                  await item()
                    .run()
                    .finally(() => setBusy(false))
                  setRequest(undefined)
                }}
              >
                {item().action}
              </Button>
            </footer>
          </section>
        </div>
      )}
    </Show>
  )
}
