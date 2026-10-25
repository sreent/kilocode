import { describe, expect, test } from "bun:test"
import { plain, session, supports, tui } from "../../src/kilocode/cli/logo"

describe("tucode logo", () => {
  test("allows remote terminals", () => {
    expect(supports({ SSH_TTY: "/dev/pts/0" }, "linux")).toBe(true)
    expect(supports({ SSH_CLIENT: "127.0.0.1 12345 22" }, "linux")).toBe(true)
    expect(supports({ SSH_CONNECTION: "127.0.0.1 12345 127.0.0.1 22" }, "linux")).toBe(true)
  })

  test("falls back on old Windows terminals", () => {
    expect(supports({}, "win32")).toBe(false)
    expect(supports({ ANSICON: "1" }, "win32")).toBe(false)
    expect(supports({ ConEmuPID: "123" }, "win32")).toBe(false)
  })

  test("allows modern Windows terminals", () => {
    expect(supports({ WT_SESSION: "session" }, "win32")).toBe(true)
    expect(supports({ TERM_PROGRAM: "vscode" }, "win32")).toBe(true)
    expect(supports({ WEZTERM_PANE: "1" }, "win32")).toBe(true)
    expect(supports({ TERM_PROGRAM: "WezTerm" }, "win32")).toBe(true)
  })

  test("allows an override", () => {
    expect(supports({ KILO_UNICODE_LOGO: "1", SSH_TTY: "/dev/pts/0" }, "linux")).toBe(true)
    expect(supports({ KILO_UNICODE_LOGO: "0" }, "linux")).toBe(false)
  })

  test("draws the tucode wordmark in blocks on every terminal", () => {
    expect(tui({ KILO_UNICODE_LOGO: "1" }, "linux")).toEqual(tui({}, "win32"))
    expect(plain({ KILO_UNICODE_LOGO: "1" }, "linux")).toEqual(plain({}, "win32"))
    expect(plain().join("\n")).toMatch(/^[█▀ \n]+$/)
    // The TUI wordmark is the same letters with shadows under them, and a row for the last shadows.
    expect(
      tui()
        .slice(0, -1)
        .map((row) => row.replaceAll("~", " ").replaceAll("^", "▀")),
    ).toEqual(plain())
    expect(tui().at(-1)).toMatch(/^[~ ]+$/)
  })

  test("formats child session exit logo", () => {
    const out = session("Title", "ses_test", "<dim>", "<reset>", {}, "win32")
    expect(out).toContain("<dim>Title<reset>")
    expect(out).toContain("<dim>tucode -s ses_test<reset>")
  })
})
