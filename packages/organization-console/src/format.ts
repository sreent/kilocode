const day = 24 * 60 * 60 * 1000

export const when = (ms: number | null | undefined) => (ms ? new Date(ms).toLocaleString() : "—")
export const date = (ms: number | null | undefined) => (ms ? new Date(ms).toLocaleDateString() : "—")
export { dollars as money } from "@organization/protocol/match"
export const count = (value: number) => value.toLocaleString()

// <input type="date"> values as an inclusive UTC window, in the epoch milliseconds the API accepts.
export function range(from: string, to: string) {
  return {
    ...(from ? { from: String(Date.parse(`${from}T00:00:00Z`)) } : {}),
    ...(to ? { to: String(Date.parse(`${to}T00:00:00Z`) + day) } : {}),
  }
}

export const label = (role: string) => {
  const text = role.replace("_", " ")
  return text.charAt(0).toUpperCase() + text.slice(1)
}

// Long ids stay recognizable in tables; the full value is in the title.
export const short = (id: string) => (id.length > 18 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id)
