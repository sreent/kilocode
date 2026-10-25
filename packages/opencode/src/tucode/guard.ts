// kilocode_change - new file (tucode)
// tucode never talks to Kilo's cloud services. The features that would (Kilo sign-in, the Kilo
// Gateway, cloud sessions, the marketplace, notifications, telemetry) are removed or switched off,
// and this guard is the backstop for any that a merge from Kilo brings back: it refuses fetch and
// WebSocket connections to Kilo's domains before they open, so such a feature fails instead of
// sending anything. Every entry point imports it first, before any module can capture fetch.

const domains = ["kilo.ai", "kilocode.ai", "kilosessions.ai", "kiloapps.io"]
const installed = Symbol.for("tucode.guard")

/** The host `url` names, when it belongs to Kilo's services. */
export function blocked(url: string | URL | Request) {
  const href = typeof url === "string" ? url : url instanceof URL ? url.href : url.url
  const host = URL.parse(href)?.hostname.toLowerCase().replace(/\.$/, "")
  if (!host) return undefined
  return domains.some((domain) => host === domain || host.endsWith(`.${domain}`)) ? host : undefined
}

function refusal(host: string) {
  return new TypeError(`tucode does not connect to Kilo's services (${host}).`)
}

export function install() {
  const scope = globalThis as typeof globalThis & { [installed]?: true }
  if (scope[installed]) return
  scope[installed] = true

  const original = globalThis.fetch
  const guarded = (input: string | URL | Request, init?: RequestInit) => {
    const host = blocked(input)
    if (host) return Promise.reject(refusal(host))
    return original(input, init)
  }
  globalThis.fetch = Object.assign(guarded, {
    preconnect: (url: string | URL, options?: Parameters<typeof original.preconnect>[1]) => {
      if (!blocked(url)) original.preconnect(url, options)
    },
  }) as typeof fetch

  const Socket = globalThis.WebSocket
  if (!Socket) return
  globalThis.WebSocket = class extends Socket {
    constructor(...args: ConstructorParameters<typeof WebSocket>) {
      const host = blocked(args[0])
      if (host) throw refusal(host)
      super(...args)
    }
  }
}

install()
