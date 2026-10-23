import { Clock, Effect } from "effect"
import { HttpRouter, HttpServerRequest } from "effect/unstable/http"
import { Store } from "../store"
import { escape, failure, page } from "../pages"

const query = (request: HttpServerRequest.HttpServerRequest, name: string) =>
  new URL(request.url, "http://localhost").searchParams.get(name)

// Browser pages of the device login: confirm the code shown in the terminal, then continue with SSO.
export const deviceRoutes = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const store = yield* Store.Service

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
        const row = yield* store.device.code(code)
        if (!row || row.status !== "pending" || row.expires < (yield* Clock.currentTimeMillis))
          return failure("Code not found", "This code is invalid or has expired. Start the login again.", 404)
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
        yield* store.device.decide((query(request, "code") ?? "").trim().toUpperCase(), "denied")
        return page(
          "Login denied",
          `<h1>Login denied</h1><p>The device was not signed in. You can close this window.</p>`,
        )
      }),
    )
  }),
)
