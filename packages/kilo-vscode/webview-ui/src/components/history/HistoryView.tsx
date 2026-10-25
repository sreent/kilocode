/**
 * HistoryView component
 * Unified panel for local and optional worktree session history. tucode has no Kilo cloud
 * sessions, so there is no cloud tab or cloud import.
 */

import { Component, Show, createEffect, createSignal, onCleanup, type Accessor, type JSX } from "solid-js"
import { Button } from "@kilocode/kilo-ui/button"
import { useLanguage } from "../../context/language"
import SessionList from "./SessionList"
import type { SessionInfo } from "../../types/messages"

interface HistoryViewProps {
  onSelectSession: (id: string) => void
  onBack?: () => void
  worktreeSessionIds?: Accessor<ReadonlySet<string> | undefined>
  /** Filter the Local tab to these session ids. */
  sessionIds?: Accessor<ReadonlySet<string> | undefined>
  /** Extra per-row actions rendered in the Local tab. */
  rowActions?: (session: SessionInfo) => JSX.Element
}

type Source = "local" | "worktree"

const EMPTY_SESSION_IDS = new Set<string>()

const HistoryView: Component<HistoryViewProps> = (props) => {
  const language = useLanguage()
  const worktreeIds = () => props.worktreeSessionIds?.()
  const [tab, setTab] = createSignal<Source>(worktreeIds() ? "worktree" : "local")
  let local: HTMLButtonElement | undefined
  let worktree: HTMLButtonElement | undefined
  let localPanel: HTMLDivElement | undefined
  let worktreePanel: HTMLDivElement | undefined

  createEffect(() => {
    if (tab() === "worktree" && !worktreeIds()) setTab("local")
  })

  createEffect(() => {
    const panel = tab() === "local" ? localPanel : worktreePanel

    const frame = requestAnimationFrame(() => {
      panel
        ?.querySelector<
          HTMLInputElement | HTMLTextAreaElement
        >('[data-slot="list-search"] input, [data-slot="list-search"] textarea')
        ?.focus()
    })

    onCleanup(() => cancelAnimationFrame(frame))
  })

  function move(event: KeyboardEvent, current: Source) {
    const sources: Source[] = worktreeIds() ? ["local", "worktree"] : ["local"]
    const index = sources.indexOf(current)
    const source =
      event.key === "Home"
        ? sources[0]
        : event.key === "End"
          ? sources.at(-1)
          : event.key === "ArrowLeft"
            ? sources[(index - 1 + sources.length) % sources.length]
            : event.key === "ArrowRight"
              ? sources[(index + 1) % sources.length]
              : undefined
    const next = source === "local" ? local : source === "worktree" ? worktree : undefined
    if (!next) return
    event.preventDefault()
    next.focus()
  }

  return (
    <div class="history-view">
      <div class="history-view-header">
        <Button variant="ghost" size="small" icon="arrow-left" onClick={() => props.onBack?.()}>
          {language.t("common.goBack")}
        </Button>
        <div class="history-view-tabs" role="tablist" aria-label={language.t("session.history.sources")}>
          <button
            ref={local}
            id="history-tab-local"
            class="history-tab-btn"
            classList={{ "history-tab-btn--active": tab() === "local" }}
            type="button"
            role="tab"
            aria-selected={tab() === "local"}
            aria-controls="history-panel-local"
            tabIndex={tab() === "local" ? 0 : -1}
            onClick={() => setTab("local")}
            onKeyDown={(event) => move(event, "local")}
          >
            {language.t("session.tab.local")}
          </button>
          <Show when={worktreeIds()}>
            <button
              ref={worktree}
              id="history-tab-worktree"
              class="history-tab-btn"
              classList={{ "history-tab-btn--active": tab() === "worktree" }}
              type="button"
              role="tab"
              aria-selected={tab() === "worktree"}
              aria-controls="history-panel-worktree"
              tabIndex={tab() === "worktree" ? 0 : -1}
              onClick={() => setTab("worktree")}
              onKeyDown={(event) => move(event, "worktree")}
            >
              {language.t("session.tab.worktree")}
            </button>
          </Show>
        </div>
      </div>

      <div
        class="history-view-content"
        ref={localPanel}
        id="history-panel-local"
        role="tabpanel"
        aria-labelledby="history-tab-local"
        hidden={tab() !== "local"}
      >
        {tab() === "local" && (
          <SessionList
            onSelectSession={props.onSelectSession}
            sessionIds={props.sessionIds}
            rowActions={props.rowActions}
          />
        )}
      </div>
      <Show when={worktreeIds()}>
        <div
          class="history-view-content"
          ref={worktreePanel}
          id="history-panel-worktree"
          role="tabpanel"
          aria-labelledby="history-tab-worktree"
          hidden={tab() !== "worktree"}
        >
          {tab() === "worktree" && (
            <SessionList
              onSelectSession={props.onSelectSession}
              sessionIds={() => worktreeIds() ?? EMPTY_SESSION_IDS}
            />
          )}
        </div>
      </Show>
    </div>
  )
}

export default HistoryView
