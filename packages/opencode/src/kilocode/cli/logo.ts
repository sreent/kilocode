// kilocode_change - new file
import { Brand } from "@/tucode/brand"

const yes = new Set(["1", "true", "yes", "on"])
const no = new Set(["0", "false", "no", "off"])

// The tucode wordmark in blocks, which every terminal draws: lowercase letters three rows tall,
// with t and d a row taller.
const letters = [
  `  ██                            ██        `,
  `██████ ██  ██ ██████ ██████ ██████ ██▀▀██ `,
  `  ██   ██  ██ ██     ██  ██ ██  ██ ██▀▀▀▀ `,
  `  ████ ██████ ██████ ██████ ██████ ██████ `,
]

// The TUI's wordmark casts a shadow half a row deep under each letter, in a row of its own under
// the last. "~" marks a shadow in the top half of an empty cell, and "^" a cell whose top half is
// a letter and bottom half shadow (see the TUI's logo component and UI.logo).
function shade(rows: string[]) {
  return [...rows, ""].map((row, index) => {
    const above = index > 0 ? rows[index - 1] : ""
    return row.padEnd(above.length).replace(/./g, (char, column: number) => {
      if (char === "▀") return "^"
      if (char === " " && above[column] === "█") return "~"
      return char
    })
  })
}

const blocks = {
  tui: shade(letters),
  plain: letters,
  // "tu", the top of the mark.
  exit: letters.map((row) => `  ${row.slice(0, 13)}  `),
}
const modern = blocks
const fallback = blocks

function flag(value: string | undefined) {
  const key = value?.toLowerCase()
  if (!key) return
  if (yes.has(key)) return true
  if (no.has(key)) return false
}

function windows(env: NodeJS.ProcessEnv) {
  if (env.WT_SESSION) return true
  if (env.TERM_PROGRAM === "vscode") return true
  if (env.WEZTERM_PANE) return true
  if (env.TERM_PROGRAM === "WezTerm") return true
  return false
}

export function supports(env = process.env, platform = process.platform) {
  const override = flag(env.KILO_UNICODE_LOGO)
  if (override !== undefined) return override
  if (env.TERM === "dumb") return false
  // Old Windows Console Host cannot render the sextant glyphs used by the modern logo.
  if (platform === "win32") return windows(env)
  if (env.ConEmuPID) return false
  if (env.ANSICON) return false
  return true
}

export function tui(env = process.env, platform = process.platform) {
  return supports(env, platform) ? modern.tui : fallback.tui
}

export function plain(env = process.env, platform = process.platform) {
  return supports(env, platform) ? modern.plain : fallback.plain
}

export function session(
  title: string,
  id: string | undefined,
  dim: string,
  normal: string,
  env = process.env,
  platform = process.platform,
) {
  const logo = supports(env, platform) ? modern.exit : fallback.exit
  return [
    ``,
    logo[0],
    `${logo[1]}${dim}${title}${normal}`,
    `${logo[2]}${dim}${Brand.command} -s ${id}${normal}`,
    logo[3],
  ].join("\n")
}
