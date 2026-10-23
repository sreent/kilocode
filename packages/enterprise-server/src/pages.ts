import { HttpServerResponse } from "effect/unstable/http"

// Server-rendered pages for the browser legs of sign-in (device approval, SSO results). They use
// the Kilo theme's tokens and palette (kilo-ui's "kilo" theme), so they look like the admin console.

export function escape(text: string) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
}

const logo = `<svg width="40" height="40" viewBox="0 0 512 512" aria-hidden="true"><path d="M512 0H0V512H512V0Z" fill="black"/><path d="M322 377H377V421H307.857L278 391.143V322H322V377ZM421 307.857L391.143 278H322V322L377 322V377H421V307.857ZM234 278H190V322H234V278ZM91 391.143L120.857 421H234V377H135V278H91V391.143ZM371.172 189.999V120.856L341.315 90.9995H278V135H327.172V189.999H278V233.999H421V189.999H371.172ZM135 91H91V233.999H135V184.5H190V233.999H234V184.5L190 140.5H135V91ZM234 91H190V140.5H234V91Z" fill="#FAF74F"/></svg>`

const style = `
  :root {
    color-scheme: dark;
    --background-base: #1e1e1e; --background-weak: #252526; --text-base: #cccccc; --text-weak: #a0a0a0;
    --text-strong: #d4d4d4; --text-interactive-base: #3794ff; --surface-brand-base: #0e639c;
    --surface-brand-hover: #1177bb; --border-base: #454545; --input-base: #3c3c3c; --border-focus: #007fd4;
  }
  @media (prefers-color-scheme: light) {
    :root {
      color-scheme: light;
      --background-base: #ffffff; --background-weak: #f3f3f3; --text-base: #616161; --text-weak: #767676;
      --text-strong: #333333; --text-interactive-base: #006ab1; --surface-brand-base: #007acc;
      --surface-brand-hover: #0062a3; --border-base: #cecece; --input-base: #ffffff; --border-focus: #0090f1;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--background-base);
    color: var(--text-base); font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  }
  main {
    width: min(420px, calc(100vw - 32px)); padding: 32px 28px; text-align: center; background: var(--background-weak);
    border: 1px solid var(--border-base); border-radius: 6px;
  }
  h1 { margin: 16px 0 8px; font-size: 16px; font-weight: 500; color: var(--text-strong); }
  p { margin: 8px 0; color: var(--text-weak); }
  a { color: var(--text-interactive-base); }
  .code { font: 600 24px ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: 4px; margin: 16px 0; color: var(--text-strong); }
  .button, button {
    display: inline-block; padding: 6px 14px; border: 0; border-radius: 2px; background: var(--surface-brand-base);
    color: #ffffff; font: inherit; text-decoration: none; cursor: pointer;
  }
  .button:hover, button:hover { background: var(--surface-brand-hover); }
  input {
    font: 600 18px ui-monospace, SFMono-Regular, Menlo, monospace; padding: 6px 8px; width: 12ch; text-align: center;
    text-transform: uppercase; color: var(--text-strong); background: var(--input-base); border: 1px solid var(--border-base);
    border-radius: 2px;
  }
  input:focus { outline: 1px solid var(--border-focus); }
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
