import { Clock, Effect } from "effect"
import { HttpRouter, HttpServerRequest } from "effect/unstable/http"
import { ServerConfig } from "../config"
import { refusal } from "../middleware/ratelimit"
import { RateLimit } from "../ratelimit"
import { RequestContext } from "../request"
import { Store } from "../store"
import { escape, failure, page } from "../pages"

const query = (request: HttpServerRequest.HttpServerRequest, name: string) =>
  new URL(request.url, "http://localhost").searchParams.get(name)

// Wrong codes each address may enter (RFC 8628 §5.1): enough for people's typos, nothing like the
// billions of codes a guesser would have to try.
const guesses = { limit: 20, window: 10 * 60_000 }

// Browser pages of the device login: confirm the code shown in the terminal, then continue with SSO.
export const deviceRoutes = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const store = yield* Store.Service
    const limiter = yield* RateLimit.Service
    const config = yield* ServerConfig.Service
    const address = RequestContext.address(config)
    const key = Effect.map(address, (value) => `device:${value}`)
    // Refuses an address that entered too many wrong codes, whatever it enters now.
    const blocked = (path: string) =>
      Effect.gen(function* () {
        const wait = yield* limiter.wait(yield* key, guesses)
        return wait > 0 ? refusal(path, wait) : undefined
      })
    const wrong = Effect.gen(function* () {
      yield* limiter.take(yield* key, guesses)
      return failure("Code not found", "This code is invalid or has expired. Start the login again.", 404)
    })

    yield* router.add("GET", "/device", (request) =>
      Effect.gen(function* () {
        const code = query(request, "code")
        if (!code)
          return page(
            "Approve device",
            `<h1>Approve a device</h1>
             <p>Enter the code shown in your terminal or IDE.</p>
             <form method="get" action="/device"><input name="code" autocomplete="off" required> <button>Continue</button></form>`,
          )
        const refused = yield* blocked("/device")
        if (refused) return refused
        const row = yield* store.device.code(code)
        if (!row || row.status !== "pending" || row.expires < (yield* Clock.currentTimeMillis)) return yield* wrong
        const org = (yield* store.org.get(row.org))!
        return page(
          "Approve device",
          `<h1>Sign in to ${escape(org.name)}</h1>
           <p>Confirm this code matches the one in your terminal or IDE:</p>
           <div class="code">${escape(row.code)}</div>
           <p><a class="button" href="/sso/${encodeURIComponent(org.slug)}/start?device=${encodeURIComponent(row.code)}">Continue with single sign-on</a></p>
           <p><a href="/device/deny?code=${encodeURIComponent(row.code)}">This wasn't me</a></p>`,
        )
      }),
    )

    yield* router.add("GET", "/device/deny", (request) =>
      Effect.gen(function* () {
        const refused = yield* blocked("/device/deny")
        if (refused) return refused
        if (!(yield* store.device.decide((query(request, "code") ?? "").trim().toUpperCase(), "denied")))
          return yield* wrong
        return page(
          "Login denied",
          `<h1>Login denied</h1><p>The device was not signed in. You can close this window.</p>`,
        )
      }),
    )
  }),
)
