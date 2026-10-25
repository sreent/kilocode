import { For, Show, createSignal, onCleanup, onMount } from "solid-js"

// A single-series column chart: one column per interval, growing from a shared baseline, with a
// recessive hairline grid. Its title names the series, so it has no legend. Each column's band is its
// hover and focus target, and the tooltip leads with the value; the page's table view holds every
// value too.

export type Column = { label: string; value: number; detail?: string }

const height = 168
const axis = 22
const left = 44
const top = 8

// The top tick: 1, 2 or 5 times a power of ten, or for counts an even whole number, so the middle
// tick is whole too.
function ceiling(value: number, whole: boolean) {
  if (value <= 0) return whole ? 2 : 1
  if (whole && value <= 10) return Math.max(2, Math.ceil(value / 2) * 2)
  const power = 10 ** Math.floor(Math.log10(value))
  return ([1, 2, 5, 10].find((step) => step * power >= value) ?? 10) * power
}

// A column with a 4px rounded top and a square foot on the baseline.
function shape(x: number, y: number, w: number, h: number) {
  const r = Math.min(4, w / 2, h)
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`
}

export function ColumnChart(props: {
  title: string
  columns: ReadonlyArray<Column>
  format: (value: number) => string
  // Compact axis ticks: 0, 1K, 2K.
  tick?: (value: number) => string
  // Counts of people or things, ticked at whole numbers.
  whole?: boolean
}) {
  const [hover, setHover] = createSignal<number>()
  // Laid out at the width it is shown at, so ticks and labels keep their size.
  const [width, setWidth] = createSignal(720)
  const box = { figure: undefined as HTMLElement | undefined }
  onMount(() => {
    const observer = new ResizeObserver((entries) => setWidth(Math.max(240, entries[0]?.contentRect.width ?? 720)))
    observer.observe(box.figure!)
    onCleanup(() => observer.disconnect())
  })
  const plot = { width: () => width() - left, height: height - top - axis }
  const max = () => ceiling(Math.max(...props.columns.map((column) => column.value), 0), props.whole === true)
  const band = () => plot.width() / Math.max(props.columns.length, 1)
  // At most 24px wide, with at least 2px of surface between neighbors.
  const thick = () => Math.max(1, Math.min(24, band() - 2))
  const y = (value: number) => top + plot.height - (value / max()) * plot.height
  const ticks = () => [0, max() / 2, max()]
  const tick = (value: number) => (props.tick ?? props.format)(value)
  // Label the first and last intervals, and the middle one when there is room.
  const labelled = (index: number) =>
    index === 0 ||
    index === props.columns.length - 1 ||
    (props.columns.length > 6 && index === Math.floor((props.columns.length - 1) / 2))
  const active = () => {
    const index = hover()
    return index === undefined ? undefined : props.columns[index]
  }

  return (
    <figure class="chart" aria-label={props.title} ref={(element) => (box.figure = element)}>
      <svg
        width={width()}
        height={height}
        viewBox={`0 0 ${width()} ${height}`}
        role="img"
        aria-label={props.title}
        onPointerLeave={() => setHover()}
      >
        <For each={ticks()}>
          {(value) => (
            <>
              <line class="chart-grid" x1={left} x2={width()} y1={y(value)} y2={y(value)} />
              <text class="chart-tick" x={left - 6} y={y(value)} text-anchor="end" dominant-baseline="middle">
                {tick(value)}
              </text>
            </>
          )}
        </For>
        <For each={props.columns}>
          {(column, index) => {
            const x = () => left + index() * band()
            const h = () => Math.max(0, top + plot.height - y(column.value))
            return (
              <g
                class="chart-column"
                classList={{ hovered: hover() === index() }}
                tabindex="0"
                aria-label={`${column.label}: ${props.format(column.value)}${column.detail ? `, ${column.detail}` : ""}`}
                onPointerEnter={() => setHover(index())}
                onFocus={() => setHover(index())}
                onBlur={() => setHover()}
              >
                <rect class="chart-hit" x={x()} y={top} width={band()} height={plot.height} />
                <Show when={column.value > 0}>
                  <path class="chart-bar" d={shape(x() + (band() - thick()) / 2, y(column.value), thick(), h())} />
                </Show>
                <Show when={labelled(index())}>
                  <text
                    class="chart-tick"
                    x={x() + band() / 2}
                    y={height - 6}
                    text-anchor={index() === 0 ? "start" : index() === props.columns.length - 1 ? "end" : "middle"}
                  >
                    {column.label}
                  </text>
                </Show>
              </g>
            )
          }}
        </For>
        <line class="chart-axis" x1={left} x2={width()} y1={top + plot.height} y2={top + plot.height} />
      </svg>
      <Show when={active()}>
        {(column) => (
          <div
            class="chart-tooltip"
            // Kept inside the figure near its edges.
            style={{ left: `${Math.min(Math.max(left + (hover()! + 0.5) * band(), 70), width() - 70)}px` }}
            role="status"
          >
            <strong>{props.format(column().value)}</strong>
            <span>{column().label}</span>
            <Show when={column().detail}>
              <span>{column().detail}</span>
            </Show>
          </div>
        )}
      </Show>
    </figure>
  )
}
