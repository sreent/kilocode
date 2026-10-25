import { HttpServerResponse } from "effect/unstable/http"
import * as svg from "../../../brand/icons/svg"

// Server-rendered pages for the browser legs of sign-in (device approval, SSO results). They use
// the tokens of kilo-web-ui's console theme, so they look like the admin console they lead to.

export function escape(text: string) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
}

const logo = `<svg width="40" height="40" viewBox="${svg.logo.viewBox}" aria-hidden="true">${svg.logo.body}</svg>`

const style = `
  :root {
    color-scheme: dark;
    --background: oklch(0.147 0.004 49.25); --card: oklch(0.216 0.006 56.043);
    --foreground: oklch(0.985 0.001 106.423); --muted-foreground: oklch(0.709 0.01 56.259);
    --border: oklch(1 0 0 / 10%); --input: oklch(1 0 0 / 15%); --ring: oklch(0.553 0.013 58.071);
    --primary: oklch(0.9519 0.1569 108.263); --primary-hover: oklch(0.9 0.16 108.263);
    --primary-foreground: oklch(0.147 0.004 49.25);
  }
  @media (prefers-color-scheme: light) {
    :root {
      color-scheme: light;
      --background: oklch(0.97 0.001 106.424); --card: oklch(1 0 0);
      --foreground: oklch(0.147 0.004 49.25); --muted-foreground: oklch(0.553 0.013 58.071);
      --border: oklch(0.923 0.003 48.717); --input: oklch(0.923 0.003 48.717); --ring: oklch(0.709 0.01 56.259);
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--background);
    color: var(--foreground);
    font: 14px/1.5 "Inter Variable", "Inter", ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }
  main {
    width: min(420px, calc(100vw - 32px)); padding: 32px 28px; text-align: center; background: var(--card);
    border: 1px solid var(--border); border-radius: 0.63rem;
  }
  h1 { margin: 16px 0 8px; font-size: 16px; font-weight: 500; }
  p { margin: 8px 0; color: var(--muted-foreground); }
  a { color: var(--foreground); text-underline-offset: 3px; }
  .code { font: 500 24px "Roboto Mono", ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: 4px; margin: 16px 0; }
  .button, button {
    display: inline-block; padding: 8px 16px; border: 0; border-radius: 0.36rem; background: var(--primary);
    color: var(--primary-foreground); font: inherit; font-weight: 500; text-decoration: none; cursor: pointer;
  }
  .button:hover, button:hover { background: var(--primary-hover); }
  .button:focus-visible, button:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }
  input {
    font: 500 18px "Roboto Mono", ui-monospace, SFMono-Regular, Menlo, monospace; padding: 6px 8px; width: 12ch;
    text-align: center; text-transform: uppercase; color: var(--foreground); background: transparent;
    border: 1px solid var(--input); border-radius: 0.36rem;
  }
  input:focus { outline: 2px solid var(--ring); outline-offset: 1px; }
`

const csp =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"

export function page(title: string, content: string, status = 200) {
  const body = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)}</title>
<style>${style}</style>
</head>
<body><main>${logo}${content}</main></body>
</html>`
  return HttpServerResponse.text(body, {
    status,
    contentType: "text/html; charset=utf-8",
    headers: { "content-security-policy": csp, "cache-control": "no-store" },
  })
}

export function failure(title: string, message: string, status = 400) {
  return page(title, `<h1>${escape(title)}</h1><p>${escape(message)}</p>`, status)
}
