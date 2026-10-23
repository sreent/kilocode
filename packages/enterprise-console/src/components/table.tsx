import { For, Show, type JSX } from "solid-js"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@kilocode/kilo-web-ui/table"

export type Column<T> = {
  readonly label: string
  readonly cell: (row: T) => JSX.Element
  readonly align?: "end"
  readonly width?: string
}

export function DataTable<T>(props: { columns: ReadonlyArray<Column<T>>; rows: ReadonlyArray<T>; empty?: string }) {
  return (
    <div class="table-wrap">
      <Table>
        <TableHeader>
          <TableRow>
            <For each={props.columns}>
              {(column) => (
                <TableHead data-align={column.align} style={column.width ? { width: column.width } : undefined}>
                  {column.label}
                </TableHead>
              )}
            </For>
          </TableRow>
        </TableHeader>
        <TableBody>
          <For each={props.rows}>
            {(row) => (
              <TableRow>
                <For each={props.columns}>
                  {(column) => <TableCell data-align={column.align}>{column.cell(row)}</TableCell>}
                </For>
              </TableRow>
            )}
          </For>
          <Show when={props.rows.length === 0}>
            <TableRow>
              <TableCell class="table-empty" colSpan={props.columns.length}>
                {props.empty ?? "Nothing here yet."}
              </TableCell>
            </TableRow>
          </Show>
        </TableBody>
      </Table>
    </div>
  )
}
