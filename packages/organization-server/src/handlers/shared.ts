import type { Org } from "../store"

// Keys whose JSON value differs between two snapshots, for audit details.
export function changed(before: Record<string, unknown>, after: Record<string, unknown>) {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(
    (key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]),
  )
}

export function delta(before: ReadonlyArray<string>, after: ReadonlyArray<string>) {
  return {
    added: after.filter((item) => !before.includes(item)),
    removed: before.filter((item) => !after.includes(item)),
  }
}

export function view(org: Org) {
  return {
    id: org.id,
    name: org.name,
    slug: org.slug,
    parent: org.parent,
    settings: org.settings,
    seats: org.seats,
    created: org.created,
  }
}

export function monthStart(time: number) {
  const date = new Date(time)
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)
}

export function csv(rows: ReadonlyArray<Record<string, unknown>>, columns: ReadonlyArray<string>) {
  const cell = (value: unknown) => {
    const text = value == null ? "" : typeof value === "string" ? value : JSON.stringify(value)
    // Neutralise spreadsheet formula injection as well as quoting separators.
    const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text
    return /[",\n\r]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe
  }
  return (
    [columns.join(","), ...rows.map((row) => columns.map((column) => cell(row[column])).join(","))].join("\n") + "\n"
  )
}
